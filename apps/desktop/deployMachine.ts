import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ProjectType } from "@dartsnut/shared-ipc";
import { Client, type Channel, type SFTPWrapper } from "ssh2";
import {
  buildDebugLaunchInner,
  buildEnsureAppVenvScript,
  buildSyncWorkspaceScript,
  remoteAppPythonBin,
  remoteLegacyPythonBin,
} from "./deployMachineScripts";

const SSH_USER = "rpi";
const SSH_PASSWORD = "rpi";

const REMOTE_UPLOAD_TGZ = "/tmp/dartsnut_deploy_upload.tgz";
const REMOTE_LOG = "/tmp/dartsnut_deploy.log";
const REMOTE_PID = "/tmp/dartsnut_dbg.pid";
/** Widget-only: runner script materialized via heredoc (avoids `sudo bash -c "$(…)"` quote bugs). */
const REMOTE_WIDGET_RUNNER = "/tmp/dartsnut_deploy_inner.sh";

/** Same tree as `services/dartsnut_python.service` on `dartsnut_rpi` (WorkingDirectory + ExecStart paths). */
const REMOTE_DARTSNUT_ROOT = "/home/rpi/dartsnut_rpi";
const REMOTE_UV_BIN = `${REMOTE_DARTSNUT_ROOT}/uv`;

export type DeployLogFn = (line: string) => void;

function runTarCreate(workspaceRoot: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    /**
     * Use POSIX ustar (not default PAX) so macOS libarchive does not embed xattr/extension records
     * that GNU tar on Linux prints as `Ignoring unknown extended header keyword 'LIBARCHIVE.xattr…'`.
     * `COPYFILE_DISABLE` alone does not suppress those PAX keywords on newer macOS.
     */
    const env = { ...process.env, COPYFILE_DISABLE: "1" };
    const child = spawn(
      "tar",
      [
        "-c",
        "--format",
        "ustar",
        "-z",
        "-f",
        outFile,
        "-C",
        workspaceRoot,
        "--exclude=.git",
        "--exclude=node_modules",
        "--exclude=.DS_Store",
        "--exclude=.dartsnut",
        ".",
      ],
      { stdio: "ignore", env },
    );
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "Could not run `tar` on PATH (needed to bundle the workspace). On Windows, use Windows 10+ (built-in tar.exe) or Git for Windows; on macOS/Linux, install GNU or BSD tar.",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
  });
}

function execSession(client: Client, command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | undefined, stream: Channel) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      stream.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      stream.on("close", (code: number | null) => {
        resolve({ stdout, stderr, code });
      });
    };
    client.exec(command, cb);
  });
}

/** Runs a bash script from stdin — avoids `bash -lc` + JSON quoting breaking `$VAR` on the remote shell. */
function execBashScriptStdin(client: Client, scriptBody: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    client.exec("bash -s", (err: Error | undefined, stream: Channel) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      stream.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      stream.on("close", (code: number | null) => {
        resolve({ stdout, stderr, code });
      });
      stream.end(scriptBody.endsWith("\n") ? scriptBody : `${scriptBody}\n`);
    });
  });
}

function fastPut(client: Client, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
      if (err) {
        reject(err);
        return;
      }
      sftp.fastPut(localPath, remotePath, (e2: Error | null | undefined) => {
        try {
          sftp.end();
        } catch {
          /* ignore */
        }
        if (e2) {
          reject(e2);
        } else {
          resolve();
        }
      });
    });
  });
}

/**
 * SSH session for sync + systemd + debug `apps/<id>/main.py` on a Dartsnut Pi image (dev user rpi:rpi).
 */
export class DeployMachineSession {
  private client: Client | null = null;

  private tailChannel: Channel | null = null;

  private remoteUsesUv = false;

  constructor(private readonly emitLog: DeployLogFn) { }

  get connected(): boolean {
    return this.client !== null;
  }

  async connect(host: string): Promise<{ deviceName: string | null }> {
    await this.disconnect();
    const trimmed = host.trim();
    if (!trimmed) {
      throw new Error("Host is empty.");
    }
    const c = new Client();
    let ready = false;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    await new Promise<void>((resolve, reject) => {
      const handleError = (err: Error): void => {
        if (this.client === c) {
          this.emitLog(`[deploy] SSH error: ${err.message}`);
        }
        if (!ready) {
          settle(() => {
            clearTimeout(t);
            c.end();
            reject(err);
          });
        }
      };
      const t = setTimeout(() => {
        settle(() => {
          c.end();
          reject(new Error("SSH connection timed out."));
        });
      }, 25000);
      // Keep a persistent listener so ssh2 socket/protocol errors never become
      // unhandled EventEmitter "error" exceptions in Electron main process.
      c.on("error", handleError);
      c.once("ready", () => {
        ready = true;
        settle(() => {
          clearTimeout(t);
          resolve();
        });
      });
      c.once("close", () => {
        if (!ready) {
          settle(() => {
            clearTimeout(t);
            reject(new Error("SSH connection lost before handshake."));
          });
        }
      });
      c.connect({
        host: trimmed,
        username: SSH_USER,
        password: SSH_PASSWORD,
        readyTimeout: 20000,
      });
    });
    this.client = c;
    c.on("close", () => {
      if (this.client === c) {
        this.client = null;
        this.stopLogTail();
      }
    });
    await this.probeRemoteUv();
    const deviceName = await this.readDeviceName();
    return { deviceName };
  }

  async disconnect(): Promise<void> {
    this.stopLogTail();
    this.remoteUsesUv = false;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  private async probeRemoteUv(): Promise<void> {
    if (!this.client) {
      this.remoteUsesUv = false;
      return;
    }
    const { code } = await execSession(this.client, `bash -lc 'test -x ${REMOTE_UV_BIN}'`);
    this.remoteUsesUv = code === 0;
    this.emitLog(
      this.remoteUsesUv
        ? "[deploy] Device uses uv app venvs"
        : "[deploy] Device uses legacy venv0",
    );
  }

  private async ensureRemoteAppVenv(appId: string): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected.");
    }
    const script = buildEnsureAppVenvScript({
      root: REMOTE_DARTSNUT_ROOT,
      appId,
      password: SSH_PASSWORD,
    });
    const { stderr, code } = await execBashScriptStdin(this.client, script);
    if (code !== 0) {
      throw new Error(stderr.trim() || `ensure_app_venv failed (exit ${code})`);
    }
    this.emitLog(`[deploy] uv sync ready for apps/${appId}`);
  }

  private async readDeviceName(): Promise<string | null> {
    if (!this.client) {
      return null;
    }
    const { stdout, code } = await execSession(
      this.client,
      `bash -lc 'test -f "$HOME/dartsnut_rpi/device.json" && cat "$HOME/dartsnut_rpi/device.json"'`,
    );
    if (code !== 0 || !stdout.trim()) {
      return null;
    }
    try {
      const j = JSON.parse(stdout) as { name?: unknown };
      return typeof j.name === "string" && j.name.trim() ? j.name.trim() : null;
    } catch {
      return null;
    }
  }

  private async execRemoteShell(script: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    if (!this.client) {
      throw new Error("Not connected.");
    }
    return execSession(this.client, script);
  }

  async syncWorkspace(localWorkspaceRoot: string, appId: string): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected.");
    }
    const tmpTar = path.join(os.tmpdir(), `dartsnut-deploy-${Date.now()}.tgz`);
    try {
      await runTarCreate(localWorkspaceRoot, tmpTar);
      this.emitLog(`[deploy] Uploading bundle (${path.basename(tmpTar)})…`);
      await fastPut(this.client, tmpTar, REMOTE_UPLOAD_TGZ);
      /** Pipe script to `bash -s` so `$TGZ`, `$STAGING`, etc. are never mangled by SSH/JSON quoting. */
      const script = buildSyncWorkspaceScript({
        appId,
        password: SSH_PASSWORD,
        remoteUploadTgz: REMOTE_UPLOAD_TGZ,
      });
      const { stderr, code } = await execBashScriptStdin(this.client, script);
      if (code !== 0) {
        throw new Error(stderr.trim() || `remote sync failed (exit ${code})`);
      }
      this.emitLog(`[deploy] Synced workspace to ~/dartsnut_rpi/apps/${appId}`);
    } finally {
      await fsp.unlink(tmpTar).catch(() => { });
    }
  }

  async stopSystemdService(): Promise<void> {
    const { stderr, code } = await this.execRemoteShell(
      `bash -lc 'echo ${SSH_PASSWORD} | sudo -S systemctl stop dartsnut_python.service'`,
    );
    if (code !== 0) {
      throw new Error(stderr.trim() || `systemctl stop failed (exit ${code})`);
    }
    this.emitLog("[deploy] Stopped dartsnut_python.service");
  }

  async startSystemdService(): Promise<void> {
    const { stderr, code } = await this.execRemoteShell(
      `bash -lc 'echo ${SSH_PASSWORD} | sudo -S systemctl start dartsnut_python.service'`,
    );
    if (code !== 0) {
      throw new Error(stderr.trim() || `systemctl start failed (exit ${code})`);
    }
    this.emitLog("[deploy] Started dartsnut_python.service");
  }

  async restartSystemdService(): Promise<void> {
    const { stderr, code } = await this.execRemoteShell(
      `bash -lc 'echo ${SSH_PASSWORD} | sudo -S systemctl restart dartsnut_python.service'`,
    );
    if (code !== 0) {
      throw new Error(stderr.trim() || `systemctl restart failed (exit ${code})`);
    }
    this.emitLog("[deploy] Restarted dartsnut_python.service");
  }

  /**
   * After reconnecting from a dropped SSH session, bring **`dartsnut_python.service`** back if it was left
   * stopped — without restarting when already **active** (avoids bouncing production during normal connects).
   */
  async restartDartsnutPythonServiceIfInactive(): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected.");
    }
    const { code } = await this.execRemoteShell(
      `bash -lc 'echo ${SSH_PASSWORD} | sudo -S systemctl is-active dartsnut_python.service'`,
    );
    if (code === 0) {
      return;
    }
    this.emitLog("[deploy] dartsnut_python.service not active — restarting…");
    await this.restartSystemdService();
  }

  /**
   * Kill any process whose command line matches **`~/dartsnut_rpi/apps/<any id>/main.py`** (debug widget/game
   * runs), not only the current workspace id — including orphaned runs not tracked by {@link REMOTE_PID}.
   */
  async killAppMainPyProcesses(): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected.");
    }
    const script = [
      "set -eo pipefail",
      "PASS=" + JSON.stringify(SSH_PASSWORD),
      // procps `pkill -f` uses regex; `[^/]+` matches a single apps/<id>/ segment.
      'echo "$PASS" | sudo -S pkill -f \'dartsnut_rpi/apps/[^/]+/main\\.py\' 2>/dev/null || true',
      `rm -f ${REMOTE_PID}`,
    ].join("\n");
    const { stderr, code } = await execBashScriptStdin(this.client, script);
    if (code !== 0) {
      throw new Error(stderr.trim() || `kill apps/*/main.py failed (exit ${code})`);
    }
    this.emitLog("[deploy] Cleared processes matching apps/*/main.py");
  }

  async killDebugPython(): Promise<void> {
    await this.execRemoteShell(
      `bash -lc 'if [ -f ${REMOTE_PID} ]; then echo ${SSH_PASSWORD} | sudo -S kill "$(cat ${REMOTE_PID})" 2>/dev/null || true; rm -f ${REMOTE_PID}; fi'`,
    );
  }

  async startDebugPython(
    appId: string,
    launch: { projectType: ProjectType; widgetParams?: Record<string, unknown> },
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected.");
    }
    /**
     * Run the synced widget/game entrypoint (`apps/<id>/main.py`), not the repo-root runtime (`main.py`).
     * Tar sync updates workspace **files** only. Widget JSON is `JSON.stringify` from IPC on each Run/Reload.
     *
     * **Widgets:** do not pass a one-liner to `sudo bash -c "…"` — nested `"` / `\` break easily. Instead
     * `sudo tee` writes **`REMOTE_WIDGET_RUNNER`** via a quoted heredoc; the file holds plain bash:
     * base64 decode → `PARAMS`, then `exec python … --params "$PARAMS"`.
     */
    if (this.remoteUsesUv) {
      await this.ensureRemoteAppVenv(appId);
    }
    const appDir = `${REMOTE_DARTSNUT_ROOT}/apps/${appId}`;
    const appMainPy = `${appDir}/main.py`;
    const pythonBin = this.remoteUsesUv
      ? remoteAppPythonBin(REMOTE_DARTSNUT_ROOT, appId)
      : remoteLegacyPythonBin(REMOTE_DARTSNUT_ROOT);
    const mainScript = this.remoteUsesUv ? "main.py" : appMainPy;
    const passAssign = "PASS=" + JSON.stringify(SSH_PASSWORD);
    const scriptHead = [
      "set -eo pipefail",
      "LOG=" + REMOTE_LOG,
      "PIDFILE=" + REMOTE_PID,
      passAssign,
      'echo "$PASS" | sudo -S truncate -s 0 "$LOG" 2>/dev/null || true',
      'echo "$PASS" | sudo -S chmod 666 "$LOG" 2>/dev/null || true',
      'printf "%s\\n" "[deploy] spawning python $(date -Is)" >> "$LOG"',
    ];
    let script: string;
    if (launch.projectType === "widget") {
      const paramsJson = JSON.stringify(launch.widgetParams ?? {});
      const paramsB64 = Buffer.from(paramsJson, "utf8").toString("base64");
      let eofMarker = `DARTSNUT_DEPLOY_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      const innerBody = buildDebugLaunchInner({
        appDir,
        pythonBin,
        mainScript,
        projectType: "widget",
        paramsB64,
      });
      while (innerBody.includes(eofMarker)) {
        eofMarker = `DARTSNUT_DEPLOY_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      }
      script = [
        ...scriptHead,
        `echo "$PASS" | sudo -S tee ${JSON.stringify(REMOTE_WIDGET_RUNNER)} > /dev/null <<'${eofMarker}'`,
        innerBody,
        eofMarker,
        `echo "$PASS" | sudo -S chmod 755 ${JSON.stringify(REMOTE_WIDGET_RUNNER)} 2>/dev/null || true`,
        `echo "$PASS" | sudo -S bash ${JSON.stringify(REMOTE_WIDGET_RUNNER)} >> "$LOG" 2>&1 &`,
        'echo $! > "$PIDFILE"',
      ].join("\n");
    } else {
      const innerCmd = buildDebugLaunchInner({
        appDir,
        pythonBin,
        mainScript,
        projectType: "game",
      });
      script = [
        ...scriptHead,
        'echo "$PASS" | sudo -S bash -c ' + JSON.stringify(innerCmd) + ' >> "$LOG" 2>&1 &',
        'echo $! > "$PIDFILE"',
      ].join("\n");
    }
    const { stderr, code } = await execBashScriptStdin(this.client, script);
    if (code !== 0) {
      throw new Error(stderr.trim() || `failed to start debug python (exit ${code})`);
    }
    const kind = launch.projectType === "widget" ? "widget" : "game";
    this.emitLog(`[deploy] Launching ${kind}: ${appMainPy} · ${REMOTE_LOG}`);
  }

  stopLogTail(): void {
    if (this.tailChannel) {
      try {
        this.tailChannel.close();
      } catch {
        /* ignore */
      }
      this.tailChannel = null;
    }
  }

  /**
   * Stream lines from the remote log file (expects `tail` on PATH).
   */
  startLogTail(): void {
    if (!this.client) {
      return;
    }
    this.stopLogTail();
    const tailCb = (err: Error | undefined, stream: Channel) => {
      if (err) {
        this.emitLog(`[deploy] tail error: ${err.message}`);
        return;
      }
      this.tailChannel = stream;
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (line.length > 0) {
            this.emitLog(line);
          }
        }
      });
      stream.stderr.on("data", (c: Buffer) => {
        const t = c.toString("utf8").trimEnd();
        if (t) {
          this.emitLog(`[tail] ${t}`);
        }
      });
      stream.on("close", () => {
        this.tailChannel = null;
      });
    };
    this.client.exec(`bash -lc 'tail -n +1 -f ${REMOTE_LOG}'`, tailCb);
  }

  async removeRemoteAppFolder(appId: string): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected.");
    }
    const targetDir = JSON.stringify(`${REMOTE_DARTSNUT_ROOT}/apps/${appId}`);
    const script = [
      "set -eo pipefail",
      "PASS=" + JSON.stringify(SSH_PASSWORD),
      "TARGET=" + targetDir,
      'echo "$PASS" | sudo -S rm -rf "$TARGET"',
    ].join("\n");
    const { stderr, code } = await execBashScriptStdin(this.client, script);
    if (code !== 0) {
      throw new Error(stderr.trim() || `rm apps/${appId} failed (exit ${code})`);
    }
    this.emitLog(`[deploy] Removed ~/dartsnut_rpi/apps/${appId}`);
  }
}
