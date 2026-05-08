import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  AssetBindError,
  AssetBindErrorCode,
  AssetManifest,
  AssetSlot,
  BindSlotRequest,
  BindSlotResponse,
  ManifestSnapshot,
  UnbindSlotRequest,
  UnbindSlotResponse
} from "@dartsnut/shared-ipc";

export const ASSET_MANIFEST_FILENAME = "dartsnut.assets.json";
const MANIFEST_POLL_INTERVAL_MS = 600;

function manifestPath(workspacePath: string): string {
  return path.join(workspacePath, ASSET_MANIFEST_FILENAME);
}

function bindError(slotId: string, code: AssetBindErrorCode, message: string): AssetBindError {
  return { slotId, code, message };
}

function isAssetManifest(value: unknown): value is AssetManifest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { version?: unknown; slots?: unknown };
  if (candidate.version !== 1) {
    return false;
  }
  return Array.isArray(candidate.slots);
}

export function readManifest(workspacePath: string): AssetManifest | null {
  const file = manifestPath(workspacePath);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return isAssetManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeManifestAtomic(workspacePath: string, manifest: AssetManifest): void {
  const file = manifestPath(workspacePath);
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(manifest, null, 2));
  fs.renameSync(tempFile, file);
}

interface PreprocessOk {
  ok: true;
  slotId: string;
  kind: AssetSlot["kind"];
  frames: number;
  binding: { source: string; frames: string[]; meta: string };
}

interface PreprocessErr {
  ok: false;
  slotId: string;
  code: AssetBindErrorCode;
  message: string;
}

type PreprocessResult = PreprocessOk | PreprocessErr;

function parsePreprocessOutput(stdout: string, slotId: string): PreprocessResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      ok: false,
      slotId,
      code: "preprocessor_crashed",
      message: "preprocessor produced no output"
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as PreprocessResult;
    return parsed;
  } catch {
    return {
      ok: false,
      slotId,
      code: "preprocessor_crashed",
      message: `preprocessor returned non-JSON output: ${trimmed.slice(0, 160)}`
    };
  }
}

interface RunPreprocessorOptions {
  pythonExec: string;
  scriptPath: string;
  slot: AssetSlot;
  workspacePath: string;
  sourcePath: string;
}

function runPreprocessor(options: RunPreprocessorOptions): Promise<PreprocessResult> {
  return new Promise((resolve) => {
    const args = [
      options.scriptPath,
      "--slot",
      options.slot.id,
      "--kind",
      options.slot.kind,
      "--size",
      `${options.slot.size[0]}x${options.slot.size[1]}`,
      "--frames",
      String(options.slot.frames),
      "--source",
      options.sourcePath,
      "--workspace",
      options.workspacePath
    ];
    const child = spawn(options.pythonExec, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        slotId: options.slot.id,
        code: "preprocessor_crashed",
        message: `failed to spawn preprocessor: ${error.message}`
      });
    });
    child.on("close", (exitCode) => {
      if (stdout.trim().length > 0) {
        resolve(parsePreprocessOutput(stdout, options.slot.id));
        return;
      }
      resolve({
        ok: false,
        slotId: options.slot.id,
        code: "preprocessor_crashed",
        message: `preprocessor exited with code ${exitCode}; stderr: ${stderr.slice(0, 240)}`
      });
    });
  });
}

interface AssetManagerOptions {
  pythonExec: () => string;
  scriptPath: string;
  onSnapshot?: (snapshot: ManifestSnapshot) => void;
}

interface ActiveWatcher {
  workspacePath: string;
  filePath: string;
}

export class AssetManager {
  private active: ActiveWatcher | null = null;
  private pendingBySlot = new Map<string, Set<string>>();

  constructor(private readonly options: AssetManagerOptions) { }

  /** Read the current manifest and pending-changes set without subscribing. */
  getSnapshot(workspacePath: string): ManifestSnapshot {
    return {
      workspacePath,
      manifest: readManifest(workspacePath),
      pendingChangeSlotIds: this.getPendingSlots(workspacePath)
    };
  }

  /**
   * Start watching `<workspace>/dartsnut.assets.json`; replaces any existing watcher.
   *
   * Uses `fs.watchFile` (polling) rather than `fs.watch` so the watcher is robust
   * to atomic-rename writes and avoids kqueue/FSEvents per-file fd pressure on
   * macOS. The poll interval is short enough that the manifest preview UI feels
   * live but long enough to not waste CPU.
   */
  watch(workspacePath: string): void {
    this.stop();
    const filePath = manifestPath(workspacePath);
    fs.watchFile(filePath, { interval: MANIFEST_POLL_INTERVAL_MS }, () => {
      this.emitSnapshot(workspacePath);
    });
    this.active = { workspacePath, filePath };
    this.emitSnapshot(workspacePath);
  }

  /** Stop the active watcher (if any). */
  stop(): void {
    if (!this.active) {
      return;
    }
    try {
      fs.unwatchFile(this.active.filePath);
    } catch {
      // ignore
    }
    this.active = null;
  }

  async bindSlot(request: BindSlotRequest): Promise<BindSlotResponse> {
    const { workspacePath, slotId, sourcePath } = request;
    const manifest = readManifest(workspacePath);
    if (!manifest) {
      return {
        ok: false,
        error: bindError(slotId, "manifest_missing", `no ${ASSET_MANIFEST_FILENAME} at workspace root`)
      };
    }
    const slot = manifest.slots.find((entry) => entry.id === slotId);
    if (!slot) {
      return { ok: false, error: bindError(slotId, "slot_not_found", `slot id not found: ${slotId}`) };
    }
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      return { ok: false, error: bindError(slotId, "io_error", `source file not found: ${sourcePath}`) };
    }

    const result = await runPreprocessor({
      pythonExec: this.options.pythonExec(),
      scriptPath: this.options.scriptPath,
      slot,
      workspacePath,
      sourcePath
    });

    if (!result.ok) {
      return { ok: false, error: bindError(slotId, result.code, result.message) };
    }

    const updatedManifest: AssetManifest = {
      ...manifest,
      slots: manifest.slots.map((entry) =>
        entry.id === slotId
          ? {
            ...entry,
            binding: {
              source: result.binding.source,
              frames: result.binding.frames,
              meta: result.binding.meta
            }
          }
          : entry
      )
    };

    try {
      writeManifestAtomic(workspacePath, updatedManifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to write manifest";
      return { ok: false, error: bindError(slotId, "io_error", message) };
    }

    this.markPending(workspacePath, slotId);
    this.emitSnapshot(workspacePath);

    return {
      ok: true,
      slotId,
      binding: updatedManifest.slots.find((entry) => entry.id === slotId)!.binding!
    };
  }

  async unbindSlot(request: UnbindSlotRequest): Promise<UnbindSlotResponse> {
    const { workspacePath, slotId, removeOutputs } = request;
    const manifest = readManifest(workspacePath);
    if (!manifest) {
      return {
        ok: false,
        error: bindError(slotId, "manifest_missing", `no ${ASSET_MANIFEST_FILENAME} at workspace root`)
      };
    }
    const slot = manifest.slots.find((entry) => entry.id === slotId);
    if (!slot) {
      return { ok: false, error: bindError(slotId, "slot_not_found", `slot id not found: ${slotId}`) };
    }

    const updatedManifest: AssetManifest = {
      ...manifest,
      slots: manifest.slots.map((entry) =>
        entry.id === slotId ? { ...entry, binding: null } : entry
      )
    };

    try {
      writeManifestAtomic(workspacePath, updatedManifest);
      if (removeOutputs) {
        const slotDir = path.join(workspacePath, "assets", slotId);
        if (fs.existsSync(slotDir)) {
          fs.rmSync(slotDir, { recursive: true, force: true });
        }
        const sourcesDir = path.join(workspacePath, "assets", "_sources");
        if (fs.existsSync(sourcesDir)) {
          for (const entry of fs.readdirSync(sourcesDir)) {
            if (entry.startsWith(`${slotId}.`)) {
              fs.rmSync(path.join(sourcesDir, entry), { force: true });
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to write manifest";
      return { ok: false, error: bindError(slotId, "io_error", message) };
    }

    this.markPending(workspacePath, slotId);
    this.emitSnapshot(workspacePath);

    return { ok: true, slotId };
  }

  /** Slot ids whose binding has changed since the last successful Apply. */
  getPendingSlots(workspacePath: string): string[] {
    const set = this.pendingBySlot.get(workspacePath);
    return set ? Array.from(set).sort() : [];
  }

  /** Mark a slot as having changed since the last apply. */
  markPending(workspacePath: string, slotId: string): void {
    const existing = this.pendingBySlot.get(workspacePath) ?? new Set<string>();
    existing.add(slotId);
    this.pendingBySlot.set(workspacePath, existing);
  }

  /** Clear the pending-changes set for a workspace (e.g. after a successful Apply). */
  clearPending(workspacePath: string, slotIds?: string[]): void {
    if (!slotIds || slotIds.length === 0) {
      this.pendingBySlot.delete(workspacePath);
      return;
    }
    const existing = this.pendingBySlot.get(workspacePath);
    if (!existing) {
      return;
    }
    for (const id of slotIds) {
      existing.delete(id);
    }
    if (existing.size === 0) {
      this.pendingBySlot.delete(workspacePath);
    }
  }

  private emitSnapshot(workspacePath: string): void {
    if (!this.options.onSnapshot) {
      return;
    }
    this.options.onSnapshot(this.getSnapshot(workspacePath));
  }
}
