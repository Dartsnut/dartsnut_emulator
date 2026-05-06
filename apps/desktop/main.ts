import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  IPCChannels,
  type AgentEvent,
  type BootstrapState,
  type PromptRequest
} from "@dartsnut/shared-ipc";
import {
  loadProviderConfig,
  validateProviderConfig,
  ProviderClient,
  SessionEngine,
  WorkspacePolicy,
  loadSkillBundle
} from "@dartsnut/agent-runtime";
import {
  EMULATOR_IPC_CHANNELS,
  type EmulatorCommand,
  type EmulatorFrame,
  type EmulatorLogEntry,
  type EmulatorStateSnapshot,
} from "@dartsnut/emulator-protocol";

let win: BrowserWindow | null = null;
let workspaceRoot: string | null = null;
let firstRunComplete = false;
let bridgeProcess: ReturnType<typeof spawn> | null = null;
const repoRoot = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, "../../..");
let pythonExec = process.env.DARTSNUT_PYTHON || "python3";
let lastWidgetDir: string | null = null;
const emulatorState: EmulatorStateSnapshot = {
  widgetPath: null,
  running: false,
  fps: 0,
  status: "Idle",
};

const proofStatePath = () => path.join(app.getPath("userData"), "first-run-proof.json");
const emulatorStatePath = () => path.join(app.getPath("userData"), "emulator-state.json");

function readProofState() {
  const file = proofStatePath();
  if (fs.existsSync(file)) {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as { complete?: boolean };
    firstRunComplete = Boolean(content.complete);
  }
}

function writeProofState(complete: boolean) {
  fs.mkdirSync(path.dirname(proofStatePath()), { recursive: true });
  fs.writeFileSync(proofStatePath(), JSON.stringify({ complete }, null, 2));
  firstRunComplete = complete;
}

function readEmulatorState() {
  const file = emulatorStatePath();
  if (!fs.existsSync(file)) {
    return;
  }
  try {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as { lastWidgetDir?: string };
    lastWidgetDir = typeof content.lastWidgetDir === "string" ? content.lastWidgetDir : null;
  } catch {
    lastWidgetDir = null;
  }
}

function writeEmulatorState() {
  fs.mkdirSync(path.dirname(emulatorStatePath()), { recursive: true });
  fs.writeFileSync(emulatorStatePath(), JSON.stringify({ lastWidgetDir }, null, 2));
}

function providerStatus(): BootstrapState["providerStatus"] {
  const validation = validateProviderConfig(loadProviderConfig());
  return validation.ok ? "ready" : "missing_config";
}

function getBootstrapState(): BootstrapState {
  return {
    workspaceRoot,
    providerStatus: providerStatus(),
    firstRunComplete
  };
}

function resolveSkillBundlePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "packages/agent-runtime/skills/dartsnut-skill.md"),
    path.resolve(process.cwd(), "../packages/agent-runtime/skills/dartsnut-skill.md"),
    path.resolve(__dirname, "../../../packages/agent-runtime/skills/dartsnut-skill.md")
  ];
  const existingPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existingPath) {
    throw new Error(`Skill bundle is missing at ${candidates[0]}`);
  }
  return existingPath;
}

function emitEmulatorState() {
  win?.webContents.send(EMULATOR_IPC_CHANNELS.emulatorState, emulatorState);
}

function emitEmulatorFrame(frame: EmulatorFrame) {
  win?.webContents.send(EMULATOR_IPC_CHANNELS.emulatorFrame, frame);
}

function emitEmulatorLog(entry: EmulatorLogEntry) {
  win?.webContents.send(EMULATOR_IPC_CHANNELS.emulatorLog, entry);
}

function canRunEmulatorDeps(executable: string): boolean {
  const probe = spawnSync(executable, ["-c", "import pydartsnut, pygame, PIL; print('ok')"], {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf-8",
  });
  return probe.status === 0;
}

function resolvePythonExecutable(): string {
  if (process.env.DARTSNUT_PYTHON) {
    return process.env.DARTSNUT_PYTHON;
  }
  const bundledVenvPython = path.join(repoRoot, ".venv", "bin", "python");
  const candidates = [bundledVenvPython, "python3", "python"];
  for (const candidate of candidates) {
    if (canRunEmulatorDeps(candidate)) {
      return candidate;
    }
  }
  emulatorState.status = "Missing Python emulator deps (pydartsnut/pygame/Pillow). Run: npm run setup:python";
  emitEmulatorState();
  return "python3";
}

function startPythonBridge() {
  if (bridgeProcess) {
    return;
  }
  const bridgePath = path.join(repoRoot, "services", "emulator-core", "bridge_service.py");
  bridgeProcess = spawn(pythonExec, [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
  emulatorState.status = `Bridge starting with ${pythonExec}`;
  emitEmulatorState();

  let stdoutBuffer = "";
  bridgeProcess.stdout?.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as {
          event: "ready" | "state" | "heartbeat" | "error" | "frame" | "log";
          payload: Record<string, unknown>;
        };
        if (event.event === "frame") {
          emitEmulatorFrame(event.payload as EmulatorFrame);
          continue;
        }
        if (event.event === "log") {
          const payload = event.payload as EmulatorLogEntry;
          if (payload?.text?.trim()) {
            emitEmulatorLog({
              source: payload.source === "stderr" ? "stderr" : "stdout",
              text: payload.text,
              timestampMs: typeof payload.timestampMs === "number" ? payload.timestampMs : Date.now(),
            });
          }
          continue;
        }
        const payload = event.payload as Partial<EmulatorStateSnapshot>;
        if (typeof payload.status === "string") {
          emulatorState.status = payload.status;
        }
        if (typeof payload.running === "boolean") {
          emulatorState.running = payload.running;
        }
        if (typeof payload.widgetPath !== "undefined") {
          emulatorState.widgetPath = payload.widgetPath ?? null;
        }
        if (typeof payload.widgetId !== "undefined") {
          emulatorState.widgetId = payload.widgetId ?? null;
        }
        if (typeof payload.widgetType !== "undefined") {
          emulatorState.widgetType = payload.widgetType ?? null;
        }
        if (typeof payload.lastError === "string") {
          emulatorState.lastError = payload.lastError;
        }
        emitEmulatorState();
      } catch {
        emulatorState.status = line.trim();
        emitEmulatorState();
      }
    }
  });

  bridgeProcess.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    emulatorState.status = "Bridge error";
    emulatorState.lastError = text;
    emitEmulatorState();
    emitEmulatorLog({
      source: "stderr",
      text,
      timestampMs: Date.now(),
    });
  });

  bridgeProcess.on("close", () => {
    bridgeProcess = null;
    emulatorState.running = false;
    emulatorState.status = "Bridge stopped";
    emitEmulatorState();
  });
}

function buildSession(): SessionEngine {
  if (!workspaceRoot) {
    throw new Error("Workspace is not selected.");
  }
  const config = loadProviderConfig();
  const validation = validateProviderConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const skillPath = resolveSkillBundlePath();
  const skillPrompt = loadSkillBundle(skillPath);
  return new SessionEngine({
    provider: new ProviderClient(config),
    workspacePolicy: new WorkspacePolicy(workspaceRoot),
    skillPrompt
  });
}

async function createWindow() {
  readProofState();
  readEmulatorState();
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1320,
    minHeight: 860,
    backgroundColor: "#0f141b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  emitEmulatorState();
}

app.whenReady().then(async () => {
  pythonExec = resolvePythonExecutable();
  startPythonBridge();
  await createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (bridgeProcess) {
    bridgeProcess.kill();
  }
});

ipcMain.handle(IPCChannels.bootstrapState, () => getBootstrapState());

ipcMain.handle(IPCChannels.pickWorkspace, async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"]
  });
  if (!result.canceled && result.filePaths[0]) {
    workspaceRoot = result.filePaths[0];
    // Attempt to launch emulator immediately from the selected workspace.
    // If it's not a widget folder, the bridge will emit a clear failure status.
    if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
      startPythonBridge();
    }
    if (bridgeProcess?.stdin && !bridgeProcess.stdin.destroyed) {
      const selectedPath = workspaceRoot;
      bridgeProcess.stdin.write(
        `${JSON.stringify({ command: { type: "set_path", path: selectedPath } satisfies EmulatorCommand })}\n`,
      );
      bridgeProcess.stdin.write(
        `${JSON.stringify({ command: { type: "reload_widget" } satisfies EmulatorCommand })}\n`,
      );
      lastWidgetDir = selectedPath;
      writeEmulatorState();
    }
  }
  return getBootstrapState();
});

ipcMain.handle(IPCChannels.sendPrompt, async (_event: unknown, req: PromptRequest) => {
  const events: AgentEvent[] = [];
  try {
    const session = buildSession();
    await session.runPrompt(req.prompt, (agentEvent: AgentEvent) => {
      events.push(agentEvent);
      console.log("[agent-stream]", JSON.stringify(agentEvent));
      win?.webContents.send(IPCChannels.subscribeEvents, agentEvent);
    });
    if (!firstRunComplete) {
      writeProofState(true);
    }
    return { ok: true, events };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown prompt error";
    const event: AgentEvent = { type: "error", message, at: Date.now() };
    win?.webContents.send(IPCChannels.subscribeEvents, event);
    return { ok: false, events: [event] };
  }
});

ipcMain.handle(EMULATOR_IPC_CHANNELS.emulatorCommand, async (_event, command: EmulatorCommand) => {
  if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
    startPythonBridge();
  }
  if (bridgeProcess?.stdin && !bridgeProcess.stdin.destroyed) {
    bridgeProcess.stdin.write(`${JSON.stringify({ command })}\n`);
    if (command.type === "set_path") {
      const selectedPath = path.isAbsolute(command.path) ? command.path : path.join(repoRoot, command.path);
      lastWidgetDir = selectedPath;
      writeEmulatorState();
    }
  } else {
    emulatorState.status = "Bridge unavailable";
    emitEmulatorState();
  }
  return { ok: true };
});

ipcMain.handle(EMULATOR_IPC_CHANNELS.emulatorPickPath, async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Select widget directory",
    defaultPath: lastWidgetDir ?? repoRoot,
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { path: null };
  }
  const selected = result.filePaths[0];
  lastWidgetDir = selected;
  writeEmulatorState();
  const relative = path.relative(repoRoot, selected);
  return { path: relative || selected };
});

ipcMain.handle(EMULATOR_IPC_CHANNELS.emulatorGetLastPath, async () => {
  if (!lastWidgetDir) {
    return { path: null };
  }
  const relative = path.relative(repoRoot, lastWidgetDir);
  return { path: relative || lastWidgetDir };
});

ipcMain.handle(EMULATOR_IPC_CHANNELS.emulatorGetBackground, async () => {
  const backgroundPath = path.join(repoRoot, "PixelDarts.png");
  try {
    const bytes = fs.readFileSync(backgroundPath);
    return { url: `data:image/png;base64,${bytes.toString("base64")}` };
  } catch {
    return { url: null };
  }
});
