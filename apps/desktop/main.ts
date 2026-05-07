import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  IPCChannels,
  type AgentEvent,
  type BootstrapState,
  type PickWorkspaceRequest,
  type PickWorkspaceResponse,
  type ProjectType,
  type PromptRequest,
  type WidgetSize
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
const creatorTemplatePaths = {
  "game-creator": "packages/agent-runtime/skills/game-creator.md",
  "widget-creator": "packages/agent-runtime/skills/widget-creator.md"
} as const;
const widgetFontManifestRelativePath = "assets/fonts/widgets/font_manifest.json";
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

function isDirectoryEmpty(directoryPath: string): boolean {
  const entries = fs.readdirSync(directoryPath);
  return entries.length === 0;
}

function resolveCreatorTemplatePath(templateMode: NonNullable<PromptRequest["templateMode"]>): string {
  return path.join(repoRoot, creatorTemplatePaths[templateMode]);
}

const SUPPORTED_WIDGET_SIZES = ["128x160", "128x128", "128x64", "64x32"] as const satisfies readonly WidgetSize[];

function parseConfWidgetSize(size: unknown): WidgetSize | undefined {
  if (!Array.isArray(size) || size.length !== 2) {
    return undefined;
  }
  const w = Number(size[0]);
  const h = Number(size[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    return undefined;
  }
  const key = `${w}x${h}` as WidgetSize;
  return SUPPORTED_WIDGET_SIZES.includes(key as (typeof SUPPORTED_WIDGET_SIZES)[number]) ? key : undefined;
}

function readWorkspaceCreatorHints(absoluteWorkspacePath: string): {
  templateMode: NonNullable<PromptRequest["templateMode"]>;
  projectType: ProjectType;
  widgetSize?: WidgetSize;
} | null {
  const confPath = path.join(absoluteWorkspacePath, "conf.json");
  if (!fs.existsSync(confPath)) {
    return null;
  }
  try {
    const conf = JSON.parse(fs.readFileSync(confPath, "utf-8")) as {
      type?: string;
      size?: unknown;
    };
    if (conf.type === "widget") {
      return {
        templateMode: "widget-creator",
        projectType: "widget",
        widgetSize: parseConfWidgetSize(conf.size)
      };
    }
  } catch {
    return null;
  }
  return null;
}

function buildRoutedPrompt(request: PromptRequest): string {
  const effectiveWorkspacePath =
    typeof request.workspacePath === "string" && request.workspacePath
      ? request.workspacePath
      : workspaceRoot;

  let templateMode = request.templateMode;
  let projectType = request.projectType;
  let widgetSize = request.widgetSize;

  if (
    (!templateMode || !projectType || !widgetSize) &&
    effectiveWorkspacePath &&
    fs.existsSync(effectiveWorkspacePath)
  ) {
    const hints = readWorkspaceCreatorHints(effectiveWorkspacePath);
    if (hints) {
      templateMode = templateMode ?? hints.templateMode;
      projectType = projectType ?? hints.projectType;
      widgetSize = widgetSize ?? hints.widgetSize;
    }
  }

  if (!templateMode) {
    return request.prompt;
  }
  const templatePath = resolveCreatorTemplatePath(templateMode);
  const template = fs.readFileSync(templatePath, "utf-8");
  const widgetFontManifestPath = path.join(repoRoot, widgetFontManifestRelativePath);
  let availableWidgetFonts: string[] = [];
  if (templateMode === "widget-creator" && fs.existsSync(widgetFontManifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(widgetFontManifestPath, "utf-8")) as {
        fonts?: Array<{ fileName?: string }>;
      };
      availableWidgetFonts = (manifest.fonts ?? [])
        .map((font) => font.fileName)
        .filter((name): name is string => typeof name === "string")
        .sort((a, b) => a.localeCompare(b));
    } catch {
      availableWidgetFonts = [];
    }
  }
  const context = {
    projectType,
    widgetSize,
    workspacePath: effectiveWorkspacePath ?? workspaceRoot,
    widgetFontManifestPath: templateMode === "widget-creator" ? widgetFontManifestPath : undefined,
    availableWidgetFonts: templateMode === "widget-creator" ? availableWidgetFonts : undefined
  };
  return [
    template,
    "",
    "Creation context:",
    JSON.stringify(context, null, 2),
    "",
    "User request:",
    request.prompt
  ].join("\n");
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

function getEmulatorWorkspaceRoot(): string {
  return workspaceRoot ?? repoRoot;
}

function toRelativeFromEmulatorWorkspaceRoot(absolutePath: string): string {
  const baseRoot = getEmulatorWorkspaceRoot();
  const relative = path.relative(baseRoot, absolutePath);
  if (!relative || relative === ".") {
    return absolutePath;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
}

function isWithinDirectory(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
    skillPrompt,
    assetRoots: {
      widgetFonts: path.join(repoRoot, "assets", "fonts", "widgets")
    }
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

ipcMain.handle(IPCChannels.pickWorkspace, async (_event: unknown, request?: PickWorkspaceRequest) => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) {
    return {
      state: getBootstrapState(),
      selectedPath: null,
      accepted: false,
      reason: "cancelled"
    } satisfies PickWorkspaceResponse;
  }
  const selectedPath = result.filePaths[0];
  if (request?.requireEmpty && !isDirectoryEmpty(selectedPath)) {
    return {
      state: getBootstrapState(),
      selectedPath,
      accepted: false,
      reason: "non_empty"
    } satisfies PickWorkspaceResponse;
  }
  workspaceRoot = selectedPath;
  // Attempt to launch emulator immediately from the selected workspace.
  // If it's not a widget folder, the bridge will emit a clear failure status.
  if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
    startPythonBridge();
  }
  if (bridgeProcess?.stdin && !bridgeProcess.stdin.destroyed) {
    bridgeProcess.stdin.write(
      `${JSON.stringify({ command: { type: "set_path", path: selectedPath } satisfies EmulatorCommand })}\n`,
    );
    bridgeProcess.stdin.write(
      `${JSON.stringify({ command: { type: "reload_widget" } satisfies EmulatorCommand })}\n`,
    );
    lastWidgetDir = selectedPath;
    writeEmulatorState();
  }
  return {
    state: getBootstrapState(),
    selectedPath,
    accepted: true
  } satisfies PickWorkspaceResponse;
});

ipcMain.handle(IPCChannels.sendPrompt, async (_event: unknown, req: PromptRequest) => {
  const events: AgentEvent[] = [];
  try {
    const session = buildSession();
    const prompt = buildRoutedPrompt(req);
    await session.runPrompt(prompt, (agentEvent: AgentEvent) => {
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
    let commandToSend = command;
    if (command.type === "set_path") {
      const baseRoot = getEmulatorWorkspaceRoot();
      let selectedPath = path.isAbsolute(command.path) ? command.path : path.join(baseRoot, command.path);
      if (workspaceRoot && !isWithinDirectory(workspaceRoot, selectedPath)) {
        selectedPath = workspaceRoot;
      }
      commandToSend = { type: "set_path", path: selectedPath };
      lastWidgetDir = selectedPath;
      writeEmulatorState();
    }
    bridgeProcess.stdin.write(`${JSON.stringify({ command: commandToSend })}\n`);
  } else {
    emulatorState.status = "Bridge unavailable";
    emitEmulatorState();
  }
  return { ok: true };
});

ipcMain.handle(EMULATOR_IPC_CHANNELS.emulatorPickPath, async () => {
  const baseRoot = getEmulatorWorkspaceRoot();
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Select widget directory",
    defaultPath: lastWidgetDir ?? baseRoot,
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { path: null };
  }
  const selected = result.filePaths[0];
  lastWidgetDir = selected;
  writeEmulatorState();
  return { path: toRelativeFromEmulatorWorkspaceRoot(selected) };
});

ipcMain.handle(EMULATOR_IPC_CHANNELS.emulatorGetLastPath, async () => {
  if (!lastWidgetDir) {
    return { path: null };
  }
  return { path: toRelativeFromEmulatorWorkspaceRoot(lastWidgetDir) };
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
