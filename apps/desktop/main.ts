import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import dotenv from "dotenv";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import type { MessageBoxOptions, OpenDialogOptions } from "electron";
import { createAgentEventBatcher, type AgentEventBatcher } from "./agentEventBatcher";
import { devLog, isDevLoggingEnabled } from "./devOnlyLog";
import {
  IPCChannels,
  type AgentEvent,
  type ApplyAssetsRequest,
  type ApplyAssetsResponse,
  type BindSlotRequest,
  type BindSlotResponse,
  type BootstrapState,
  type SaveTempWorkspaceResponse,
  isTemporaryWorkspaceForBootstrap,
  normalizeFsPathComparable,
  workspaceNeedsCreationIntake,
  type DeployActionResponse,
  type DeployConnectRequest,
  type DeployConnectResponse,
  type DeployEligibility,
  type DeployLaunchRequest,
  type ManifestSnapshot,
  type PickWorkspaceRequest,
  type PickWorkspaceResponse,
  type PrepareWorkspaceForProviderSwitchResponse,
  type ProjectType,
  type PromptRequest,
  type LlmProviderId,
  type ProviderSettings,
  type ReadPreviewRequest,
  type ReadPreviewResponse,
  type SaveProviderSettingsRequest,
  type UserDefineProviderSettings,
  type UnbindSlotRequest,
  type UnbindSlotResponse,
  validateDeployWorkspaceConf,
  WIDGET_DISPLAY_SIZES,
  type WidgetSize,
  type ShellUiTheme,
  type WindowChromeInsets,
  type SendPromptResponse,
  type MainProcessConsoleMirrorPayload,
  type IntakeSubmitQuestionAnswerRequest,
  type IntakeSubmitQuestionAnswerResponse,
  type AgentSessionWorkspaceSummary,
  buildCreationIntakeUserPrompt,
  buildPostIntakeCreatorUserPrompt,
  resolveSessionUserLocale,
  type UserLocale,
  formatCreatorBuildPlanMessage,
  shouldIncludeCreatorBuildPlan,
  parseWidgetFontCatalogFromManifest,
  type WidgetFontCatalogEntry
} from "@dartsnut/shared-ipc";
import {
  loadProviderConfig,
  validateProviderConfig,
  ProviderClient,
  SessionEngine,
  WorkspacePolicy,
  bundleForTemplateMode,
  resolveSkillRouterPrompt,
  allowedDeferredSkillIdsForMode,
  AGENT_CREATION_INTAKE_TOOL_SCHEMAS,
  AGENT_TOOL_SCHEMAS,
  AgentSessionPersistence,
  isAgentSessionPersistenceDisabledByEnv,
  AGENT_STOPPED_MESSAGE,
  executeIntakeHostTool,
  isIntakeStateReady,
  nextAfterProjectType,
  parseConfWidgetSize,
  precheckAskQuestion,
  type IntakeToolState,
  type ChatMessage
} from "@dartsnut/agent-runtime";
import { formatAgentEventForConsole } from "./agentEventConsole";
import {
  EMULATOR_IPC_CHANNELS,
  type EmulatorCommand,
  type EmulatorFrame,
  type EmulatorLogEntry,
  type EmulatorStateSnapshot,
} from "@dartsnut/emulator-protocol";
import { AssetManager } from "./assetManager";
import { DeployMachineSession } from "./deployMachine";

let win: BrowserWindow | null = null;
let workspaceRoot: string | null = null;
/** Persisted unsaved temp workspace directory (under OS temp), or null. */
let trackedTempWorkspacePath: string | null = null;
/** When true, the next window close can continue without showing the temp-workspace prompt again. */
let allowWindowCloseWithoutTempPrompt = false;
/** Set once app quit has been requested so the guarded close can resume quitting after save/discard. */
let appQuitRequested = false;
/** Temp dir to remove on `will-quit` after the bridge is killed (quit-time discard). */
let pendingTempDirRemovalOnQuit: string | null = null;
let firstRunComplete = false;
let bridgeProcess: ReturnType<typeof spawn> | null = null;
/** Interpreter used to spawn the current bridge (restart bridge when this changes). */
let bridgePythonExec: string | null = null;
const repoRoot = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, "../../..");
process.env.DARTSNUT_REPO_ROOT = repoRoot;
const repoEnvPath = path.join(repoRoot, ".env");
if (fs.existsSync(repoEnvPath)) {
  dotenv.config({ path: repoEnvPath });
}
let pythonExec = process.env.DARTSNUT_PYTHON || "python3";
let pythonRuntimeStatus: string | null = null;

const PYTHON_SETUP_LOG_PREFIX = "[python-setup]";
let lastWidgetDir: string | null = null;
const creatorTemplatePaths = {
  "game-creator": "packages/agent-runtime/skills/game-creator.md",
  "widget-creator": "packages/agent-runtime/skills/widget-creator.md"
} as const;
const assetPreprocessScriptRelativePath = "scripts/asset_preprocess.py";
const assetManager = new AssetManager({
  pythonExec: () => pythonExec,
  scriptPath: path.join(repoRoot, assetPreprocessScriptRelativePath),
  onSnapshot: (snapshot: ManifestSnapshot) => {
    sendToRenderer(IPCChannels.assetsSubscribeManifest, snapshot);
  }
});
const widgetFontManifestRelativePath = "assets/fonts/widgets/font_manifest.json";

let deployMachineSession: DeployMachineSession | null = null;

/** Set while `sendPrompt` is running; used to abort the provider + tool loop from the renderer Stop control. */
let sendPromptAbortController: AbortController | null = null;

/** Poll `conf.json` like `AssetManager` does for the manifest — survives atomic writes; works before the file exists. */
const DEPLOY_CONF_POLL_MS = 600;
let deployConfWatch: { watchedPath: string; workspacePath: string } | null = null;

function stopDeployConfWatcher(): void {
  if (!deployConfWatch) {
    return;
  }
  try {
    fs.unwatchFile(deployConfWatch.watchedPath);
  } catch {
    // ignore
  }
  deployConfWatch = null;
}

function startDeployConfWatcher(workspacePath: string): void {
  stopDeployConfWatcher();
  const watchedPath = path.join(workspacePath, "conf.json");
  fs.watchFile(watchedPath, { interval: DEPLOY_CONF_POLL_MS }, () => {
    if (!deployConfWatch || deployConfWatch.workspacePath !== workspaceRoot) {
      return;
    }
    sendToRenderer(IPCChannels.deployEligibilityChanged, readDeployEligibilityFromWorkspace());
  });
  deployConfWatch = { watchedPath, workspacePath };
  sendToRenderer(IPCChannels.deployEligibilityChanged, readDeployEligibilityFromWorkspace());
}

function emitDeployLog(line: string): void {
  sendToRenderer(IPCChannels.deployLog, line);
}

function getDeployMachineSession(): DeployMachineSession {
  if (!deployMachineSession) {
    deployMachineSession = new DeployMachineSession(emitDeployLog);
  }
  return deployMachineSession;
}

async function disconnectDeployMachine(): Promise<void> {
  if (deployMachineSession) {
    await deployMachineSession.disconnect().catch(() => { });
    deployMachineSession = null;
  }
}

function readDeployEligibilityFromWorkspace(): DeployEligibility {
  if (!workspaceRoot) {
    return { ok: false, reason: "no_workspace" };
  }
  const confPath = path.join(workspaceRoot, "conf.json");
  if (!fs.existsSync(confPath)) {
    return { ok: false, reason: "missing_conf" };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(confPath, "utf-8"));
    return validateDeployWorkspaceConf(raw);
  } catch {
    return { ok: false, reason: "invalid_conf" };
  }
}

const EMULATOR_LOG_RING_MAX = 200;
const EMULATOR_LOG_DEFAULT_TAIL = 80;
const EMULATOR_LOG_MAX_REQUEST = 200;

let emulatorLogRing: EmulatorLogEntry[] = [];

function pushEmulatorLogRing(entry: EmulatorLogEntry): void {
  emulatorLogRing.push(entry);
  if (emulatorLogRing.length > EMULATOR_LOG_RING_MAX) {
    emulatorLogRing = emulatorLogRing.slice(-EMULATOR_LOG_RING_MAX);
  }
}

function clearEmulatorLogRing(): void {
  emulatorLogRing = [];
}

/** Clear agent log ring and emulator panel logs before each widget reload. */
function clearEmulatorLogsForReload(): void {
  clearEmulatorLogRing();
  sendToRenderer(EMULATOR_IPC_CHANNELS.emulatorLogsClear);
}

/** Agent tool `get_emulator_logs`: tail of buffered Python bridge stdout/stderr + emulator status. */
function executeHostGetEmulatorLogsForAgent(args?: { max_lines?: number }): string {
  const requested =
    typeof args?.max_lines === "number" && Number.isFinite(args.max_lines)
      ? Math.min(EMULATOR_LOG_MAX_REQUEST, Math.max(1, Math.floor(args.max_lines)))
      : EMULATOR_LOG_DEFAULT_TAIL;
  const lines = emulatorLogRing.slice(-requested);
  return JSON.stringify({
    ok: true,
    lines,
    emulator: {
      running: emulatorState.running,
      status: emulatorState.status,
      lastError: emulatorState.lastError ?? null,
      widgetPath: emulatorState.widgetPath
    },
    hint: "Scan stderr and stdout for Traceback, SyntaxError, ModuleNotFoundError, and Error before continuing."
  });
}

/** Agent tool `reload_emulator`: sync bridge path, reload widget (Python re-reads conf.json), refresh deploy UI. */
async function executeHostReloadEmulatorForAgent(): Promise<string> {
  if (!workspaceRoot) {
    return JSON.stringify({
      ok: false,
      error: "No workspace is selected — finish intake or pick a project folder first."
    });
  }
  if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
    startPythonBridge();
  }
  if (!bridgeProcess?.stdin || bridgeProcess.stdin.destroyed) {
    return JSON.stringify({ ok: false, error: "Emulator bridge is not available." });
  }
  const baseRoot = getEmulatorWorkspaceRoot();
  let selectedPath = path.isAbsolute(workspaceRoot) ? workspaceRoot : path.join(baseRoot, workspaceRoot);
  if (!isWithinDirectory(workspaceRoot, selectedPath)) {
    selectedPath = workspaceRoot;
  }
  const setPath: EmulatorCommand = { type: "set_path", path: selectedPath };
  const reload: EmulatorCommand = { type: "reload_widget" };
  bridgeProcess.stdin.write(`${JSON.stringify({ command: setPath })}\n`);
  clearEmulatorLogsForReload();
  bridgeProcess.stdin.write(`${JSON.stringify({ command: reload })}\n`);
  lastWidgetDir = selectedPath;
  writeEmulatorState();
  startDeployConfWatcher(workspaceRoot);
  return JSON.stringify({
    ok: true,
    message:
      "Emulator path re-applied and reload_widget sent; conf.json re-read on the Python side and deploy eligibility refreshed. Call get_emulator_logs next to confirm the widget starts without errors."
  });
}

const emulatorState: EmulatorStateSnapshot = {
  widgetPath: null,
  running: false,
  fps: 0,
  status: "Idle",
};

const proofStatePath = () => path.join(app.getPath("userData"), "first-run-proof.json");
const tempWorkspaceRecordPath = () => path.join(app.getPath("userData"), "temp-workspace.json");
const emulatorStatePath = () => path.join(app.getPath("userData"), "emulator-state.json");
const providerSettingsPath = () => path.join(app.getPath("userData"), "provider-settings.json");
const pythonSettingsPath = () => path.join(app.getPath("userData"), "python-settings.json");

const LLM_PROVIDER_IDS: readonly LlmProviderId[] = ["gpt", "gemini", "xiaomi", "claude", "user-define"];

/** Hidden from settings UI and remapped on load until Claude tool streaming is stable. */
const UI_DISABLED_LLM_PROVIDERS = new Set<LlmProviderId>(["claude"]);
const UI_FALLBACK_LLM_PROVIDER: LlmProviderId = "gpt";

function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === "string" && (LLM_PROVIDER_IDS as readonly string[]).includes(value);
}

function resolveUiSelectableProvider(id: LlmProviderId): LlmProviderId {
  return UI_DISABLED_LLM_PROVIDERS.has(id) ? UI_FALLBACK_LLM_PROVIDER : id;
}

function normalizeUserDefineSettings(input?: Partial<UserDefineProviderSettings> | null): UserDefineProviderSettings {
  return {
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : ""
  };
}

type LegacyProviderSettingsFile = Partial<ProviderSettings> & {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function normalizeProviderSettings(input?: LegacyProviderSettingsFile | null): ProviderSettings {
  const legacyFlat =
    input != null &&
    (typeof input.baseUrl === "string" ||
      typeof input.apiKey === "string" ||
      typeof input.model === "string") &&
    input.userDefine == null;

  if (legacyFlat) {
    const userDefine = normalizeUserDefineSettings({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model
    });
    const hasLegacyCredentials = Boolean(userDefine.apiKey || userDefine.model || userDefine.baseUrl);
    return {
      activeProvider: hasLegacyCredentials ? "user-define" : "gpt",
      userDefine
    };
  }

  const userDefine = normalizeUserDefineSettings(input?.userDefine);
  const hasUserDefineCredentials = Boolean(userDefine.apiKey || userDefine.model || userDefine.baseUrl);
  const rawProvider = isLlmProviderId(input?.activeProvider)
    ? input.activeProvider
    : hasUserDefineCredentials
      ? "user-define"
      : "gpt";

  return { activeProvider: resolveUiSelectableProvider(rawProvider), userDefine };
}

function maskApiKeyForPreview(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "••••••••";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function enrichProviderSettingsForRenderer(stored: ProviderSettings): ProviderSettings {
  if (stored.activeProvider === "user-define") {
    return stored;
  }
  const config = loadProviderConfig({ activeProvider: stored.activeProvider });
  return {
    ...stored,
    resolvedPreview: {
      baseUrl: config.baseUrl,
      apiKeyMasked: maskApiKeyForPreview(config.apiKey),
      model: config.model
    }
  };
}

function readProviderSettings(): ProviderSettings {
  const file = providerSettingsPath();
  if (!fs.existsSync(file)) {
    return normalizeProviderSettings();
  }
  try {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as LegacyProviderSettingsFile;
    const normalized = normalizeProviderSettings(content);
    if (isLlmProviderId(content.activeProvider) && UI_DISABLED_LLM_PROVIDERS.has(content.activeProvider)) {
      writeProviderSettings(normalized);
    }
    return normalized;
  } catch {
    return normalizeProviderSettings();
  }
}

function validateProviderSettingsInput(input: SaveProviderSettingsRequest): { ok: true } | { ok: false; error: string } {
  const normalized = normalizeProviderSettings(input);
  if (!isLlmProviderId(normalized.activeProvider)) {
    return { ok: false, error: "Invalid provider selection." };
  }
  if (UI_DISABLED_LLM_PROVIDERS.has(input.activeProvider)) {
    return { ok: false, error: "Claude is not available in the app right now." };
  }
  if (normalized.activeProvider !== "user-define") {
    return { ok: true };
  }
  const ud = normalized.userDefine;
  if (!ud.apiKey) {
    return { ok: false, error: "API key is required." };
  }
  if (!ud.model) {
    return { ok: false, error: "Model is required." };
  }
  if (ud.baseUrl) {
    try {
      new URL(ud.baseUrl);
    } catch {
      return { ok: false, error: "Endpoint must be a valid URL." };
    }
  }
  return { ok: true };
}

function writeProviderSettings(input: SaveProviderSettingsRequest): ProviderSettings {
  const validation = validateProviderSettingsInput(input);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const normalized = normalizeProviderSettings(input);
  fs.mkdirSync(path.dirname(providerSettingsPath()), { recursive: true });
  fs.writeFileSync(providerSettingsPath(), JSON.stringify(normalized, null, 2));
  return enrichProviderSettingsForRenderer(normalized);
}

function readSelectedPythonPath(): string | null {
  const file = pythonSettingsPath();
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as { pythonPath?: string };
    return typeof content.pythonPath === "string" && content.pythonPath.trim() ? content.pythonPath.trim() : null;
  } catch {
    return null;
  }
}

function writeSelectedPythonPath(pythonPath: string): string {
  const normalized = pythonPath.trim();
  fs.mkdirSync(path.dirname(pythonSettingsPath()), { recursive: true });
  fs.writeFileSync(pythonSettingsPath(), JSON.stringify({ pythonPath: normalized }, null, 2));
  return normalized;
}

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

function readTempWorkspaceJsonFromDisk(): string | null {
  const file = tempWorkspaceRecordPath();
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as { temporaryPath?: unknown };
    if (typeof content.temporaryPath === "string" && content.temporaryPath.trim()) {
      return path.resolve(content.temporaryPath.trim());
    }
    return null;
  } catch {
    return null;
  }
}

function writeTempWorkspaceRecordToDisk(next: string | null): void {
  trackedTempWorkspacePath = next;
  const file = tempWorkspaceRecordPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ temporaryPath: next }, null, 2));
}

function loadTrackedTempWorkspaceFromDisk(): void {
  trackedTempWorkspacePath = readTempWorkspaceJsonFromDisk();
}

function isTemporaryWorkspaceActiveNow(): boolean {
  return isTemporaryWorkspaceForBootstrap(workspaceRoot, trackedTempWorkspacePath);
}

function getDialogParent(): BrowserWindow | undefined {
  return win && !win.isDestroyed() ? win : undefined;
}

async function showAppMessageBox(options: MessageBoxOptions) {
  const parent = getDialogParent();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

async function showAppOpenDialog(options: OpenDialogOptions) {
  const parent = getDialogParent();
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

function removeDirectoryBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function isProbableAllocatedTempDir(absPath: string): boolean {
  const base = path.basename(absPath);
  if (!base.startsWith("dartsnut-chat-")) {
    return false;
  }
  const abs = path.resolve(absPath);
  const tmp = path.resolve(os.tmpdir());
  const rel = path.relative(tmp, abs);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function markNewTemporaryWorkspaceAllocated(root: string): void {
  const absRoot = path.resolve(root);
  const previous = trackedTempWorkspacePath;
  if (
    previous &&
    normalizeFsPathComparable(previous) !== normalizeFsPathComparable(absRoot) &&
    fs.existsSync(previous) &&
    isProbableAllocatedTempDir(previous)
  ) {
    removeDirectoryBestEffort(previous);
  }
  writeTempWorkspaceRecordToDisk(absRoot);
}

type TempWorkspaceGuardReason = "quit" | "open_workspace" | "new_project";

function tempGuardDialogMessage(reason: TempWorkspaceGuardReason): string {
  switch (reason) {
    case "quit":
      return "You have an unsaved project in a temporary folder. Save it to a permanent folder, discard it, or cancel.";
    case "open_workspace":
      return "Opening another workspace will leave your temporary project. Save it, discard it, or cancel.";
    case "new_project":
      return "Starting a new project will clear the current session. Save the temporary project, discard it, or cancel to stay.";
  }
}

async function promptSaveDiscardCancel(reason: TempWorkspaceGuardReason): Promise<"save" | "discard" | "cancel"> {
  const { response } = await showAppMessageBox({
    type: "question",
    buttons: ["Save", "Discard", "Cancel"],
    defaultId: 2,
    cancelId: 2,
    title: "Unsaved temporary project",
    message: tempGuardDialogMessage(reason)
  });
  if (response === 0) {
    return "save";
  }
  if (response === 1) {
    return "discard";
  }
  return "cancel";
}

function stopPythonBridgeProcess(): void {
  if (bridgeProcess) {
    bridgeProcess.kill();
    bridgeProcess = null;
  }
}

function releaseWorkspaceFileHandles(): void {
  stopPythonBridgeProcess();
  assetManager.stop();
  stopDeployConfWatcher();
}

async function discardTrackedTemporaryProject(reason?: TempWorkspaceGuardReason): Promise<void> {
  const tracked = trackedTempWorkspacePath;
  if (!tracked) {
    return;
  }
  const toRemove = path.resolve(tracked);
  const discardingOnQuit = reason === "quit";
  if (discardingOnQuit) {
    pendingTempDirRemovalOnQuit = toRemove;
  }
  if (workspaceRoot && path.resolve(workspaceRoot) === toRemove) {
    performSessionCleanup({ clearWorkspace: true });
  } else {
    writeTempWorkspaceRecordToDisk(null);
  }
  if (discardingOnQuit) {
    releaseWorkspaceFileHandles();
    void disconnectDeployMachine();
  }
  removeDirectoryBestEffort(toRemove);
  if (!discardingOnQuit) {
    ensureTemporaryWorkspaceRootAllocated();
  }
}

async function runInteractiveSaveTemporaryWorkspace(): Promise<boolean> {
  const tracked = trackedTempWorkspacePath;
  if (!tracked || !isTemporaryWorkspaceActiveNow()) {
    return false;
  }
  if (!fs.existsSync(tracked)) {
    return false;
  }
  const pick = await showAppOpenDialog({
    title: "Save project — choose an empty folder",
    properties: ["openDirectory", "createDirectory"]
  });
  if (pick.canceled || !pick.filePaths[0]) {
    return false;
  }
  const dest = pick.filePaths[0];
  if (!isDirectoryEmpty(dest)) {
    await showAppMessageBox({
      type: "warning",
      title: "Cannot save",
      message: "The destination folder must be empty."
    });
    return false;
  }
  try {
    fs.cpSync(tracked, dest, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showAppMessageBox({
      type: "error",
      title: "Save failed",
      message: `Could not copy the project: ${message}`
    });
    return false;
  }
  const toRemove = path.resolve(tracked);
  writeTempWorkspaceRecordToDisk(null);
  applyWorkspaceRoot(dest);
  removeDirectoryBestEffort(toRemove);
  return true;
}

async function ensureTemporaryWorkspaceResolvedForGuard(reason: TempWorkspaceGuardReason): Promise<boolean> {
  if (!isTemporaryWorkspaceActiveNow()) {
    return true;
  }
  if (reason === "quit") {
    const ws = workspaceRoot;
    if (
      ws &&
      fs.existsSync(ws) &&
      fs.statSync(ws).isDirectory() &&
      isDirectoryEmpty(ws)
    ) {
      await discardTrackedTemporaryProject(reason);
      return true;
    }
  }
  for (; ;) {
    const choice = await promptSaveDiscardCancel(reason);
    if (choice === "cancel") {
      return false;
    }
    if (choice === "discard") {
      await discardTrackedTemporaryProject(reason);
      return true;
    }
    const saved = await runInteractiveSaveTemporaryWorkspace();
    if (saved) {
      return true;
    }
  }
}

async function maybeRecoverTrackedTempWorkspaceAtLaunch(): Promise<void> {
  loadTrackedTempWorkspaceFromDisk();
  const tp = trackedTempWorkspacePath;
  if (!tp) {
    return;
  }
  if (!fs.existsSync(tp) || !fs.statSync(tp).isDirectory()) {
    writeTempWorkspaceRecordToDisk(null);
    return;
  }
  const { response } = await showAppMessageBox({
    type: "question",
    buttons: ["Resume", "Discard"],
    defaultId: 0,
    cancelId: 1,
    title: "Temporary project",
    message:
      "A project folder from your last session is still in temporary storage.\n\nResume to continue editing, or Discard to delete it.",
    detail: tp
  });
  if (response === 1) {
    const toRemove = path.resolve(tp);
    writeTempWorkspaceRecordToDisk(null);
    removeDirectoryBestEffort(toRemove);
    return;
  }
  const resolved = path.resolve(tp);
  writeTempWorkspaceRecordToDisk(resolved);
  applyWorkspaceRoot(resolved);
}

function providerStatus(): BootstrapState["providerStatus"] {
  const stored = readProviderSettings();
  const config = loadProviderConfig({
    activeProvider: stored.activeProvider,
    userDefine: stored.userDefine
  });
  const validation = validateProviderConfig(config, stored.activeProvider);
  return validation.ok ? "ready" : "missing_config";
}

function getBootstrapState(): BootstrapState {
  return {
    workspaceRoot,
    providerStatus: providerStatus(),
    firstRunComplete,
    isTemporaryWorkspace: isTemporaryWorkspaceActiveNow(),
    needsCreationIntake: computeNeedsCreationIntake()
  };
}

function emitBootstrapStateToRenderer(): void {
  sendToRenderer(IPCChannels.bootstrapStateChanged, getBootstrapState());
}

function isDirectoryEmpty(directoryPath: string): boolean {
  const entries = fs.readdirSync(directoryPath);
  return entries.length === 0;
}

type CreatorTemplateMode = keyof typeof creatorTemplatePaths;

function resolveCreatorTemplatePath(templateMode: CreatorTemplateMode): string {
  return path.join(repoRoot, creatorTemplatePaths[templateMode]);
}

function readWorkspaceCreatorHints(absoluteWorkspacePath: string): {
  templateMode: CreatorTemplateMode;
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
    if (conf.type === "game") {
      return {
        templateMode: "game-creator",
        projectType: "game"
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Cleared in `sendPrompt` finally so an in-flight deferred chip question cannot strand the agent. */
let agentEventEmitter: ((event: AgentEvent) => void) | null = null;

interface IntakeChipQuestionPending {
  kind: "project_type" | "widget_size";
  resolve: (json: string) => void;
  state: IntakeToolState;
}

let intakeChipQuestionPending: IntakeChipQuestionPending | null = null;

function cancelAllIntakeUserInputPending(): void {
  if (intakeChipQuestionPending) {
    const { resolve, kind } = intakeChipQuestionPending;
    intakeChipQuestionPending = null;
    if (agentEventEmitter) {
      if (kind === "project_type") {
        agentEventEmitter({ type: "intake_project_type_prompt", at: Date.now(), visible: false });
      } else {
        agentEventEmitter({ type: "intake_widget_size_prompt", at: Date.now(), visible: false });
      }
    }
    resolve(
      JSON.stringify({
        ok: false,
        cancelled: true,
        message: "Choice was interrupted."
      })
    );
  }
}

function allocateTemporaryWorkspaceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-chat-"));
}

/** Allocate and select a temp workspace when none is active (eager allocation). */
function ensureTemporaryWorkspaceRootAllocated(): string {
  if (workspaceRoot) {
    return workspaceRoot;
  }
  const root = allocateTemporaryWorkspaceRoot();
  applyWorkspaceRoot(root);
  markNewTemporaryWorkspaceAllocated(root);
  return root;
}

function readWorkspaceConfJsonExists(absoluteWorkspacePath: string): boolean {
  return fs.existsSync(path.join(absoluteWorkspacePath, "conf.json"));
}

function computeNeedsCreationIntake(): boolean {
  // No active workspace yet (early-startup race before ensureTemporaryWorkspaceRootAllocated
  // runs, or right after a cleanup): the next prompt will eagerly allocate a fresh temp dir
  // which by definition has no conf.json, so intake is required. Reporting `true` here keeps
  // the renderer's chip gate correct against a stale bootstrap snapshot.
  if (!workspaceRoot) {
    return true;
  }
  return workspaceNeedsCreationIntake(workspaceRoot, readWorkspaceConfJsonExists(workspaceRoot));
}

function applyWorkspaceRoot(selectedPath: string): void {
  if (workspaceRoot && workspaceRoot !== selectedPath) {
    performSessionCleanup({ clearWorkspace: false });
  }
  workspaceRoot = selectedPath;
  if (
    trackedTempWorkspacePath &&
    path.resolve(trackedTempWorkspacePath) !== path.resolve(selectedPath)
  ) {
    writeTempWorkspaceRecordToDisk(null);
  }
  if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
    startPythonBridge();
  }
  if (bridgeProcess?.stdin && !bridgeProcess.stdin.destroyed) {
    bridgeProcess.stdin.write(
      `${JSON.stringify({ command: { type: "set_path", path: selectedPath } satisfies EmulatorCommand })}\n`,
    );
    clearEmulatorLogsForReload();
    bridgeProcess.stdin.write(
      `${JSON.stringify({ command: { type: "reload_widget" } satisfies EmulatorCommand })}\n`,
    );
    lastWidgetDir = selectedPath;
    writeEmulatorState();
  }
  assetManager.watch(selectedPath);
  startDeployConfWatcher(selectedPath);
  emitBootstrapStateToRenderer();
}

async function intakeHostToolExecute(
  args: Record<string, unknown>,
  state: IntakeToolState
): Promise<string> {
  const root = workspaceRoot;
  if (!root) {
    return JSON.stringify({ ok: false, error: "No workspace is active." });
  }
  return executeIntakeHostTool(args, state, root);
}

async function askQuestionHostExecute(
  args: Record<string, unknown>,
  state: IntakeToolState
): Promise<string> {
  const precheck = precheckAskQuestion(args, state);
  if (precheck.handled && precheck.response !== undefined) {
    return precheck.response;
  }
  const questionId = args.question_id;
  if (typeof questionId !== "string") {
    return JSON.stringify({ ok: false, error: "question_id is required" });
  }
  if (intakeChipQuestionPending) {
    return JSON.stringify({
      ok: false,
      error: "Another intake question is already waiting for the user."
    });
  }
  if (questionId === "project_type") {
    agentEventEmitter?.({
      type: "intake_project_type_prompt",
      at: Date.now(),
      visible: true,
      options: ["game", "widget"]
    });
    return await new Promise<string>((resolve) => {
      intakeChipQuestionPending = { kind: "project_type", resolve, state };
    });
  }
  if (questionId === "widget_display_size") {
    agentEventEmitter?.({
      type: "intake_widget_size_prompt",
      at: Date.now(),
      visible: true,
      sizes: [...WIDGET_DISPLAY_SIZES]
    });
    return await new Promise<string>((resolve) => {
      intakeChipQuestionPending = { kind: "widget_size", resolve, state };
    });
  }
  return JSON.stringify({ ok: false, error: `Unknown question_id: ${questionId}` });
}

function buildAssetApplierPrompt(request: PromptRequest): string {
  const apply = request.assetApply ?? { slotIds: [], projectType: "game" };
  const slotIds = Array.isArray(apply.slotIds) ? apply.slotIds : [];
  const workspacePath = request.workspacePath ?? workspaceRoot ?? "";
  const directives = [
    "You are running in **asset-applier** mode (see `asset-pipeline` skill, Apply mode section).",
    `Project type: ${apply.projectType}.`,
    `Workspace path: ${workspacePath}.`,
    `Slot ids that just changed: ${slotIds.length > 0 ? slotIds.join(", ") : "(none)"}.`,
    "",
    "Allowed actions: read `dartsnut.assets.json`, ensure `assets_loader.py` matches the backend snippet for the project type, and switch placeholder draws to `slot.draw(...)` only for the named slot ids.",
    "Do not scaffold, rename, or restructure files. Do not change layout, fonts, gameplay, or any code unrelated to the named slot ids.",
    "If the loader is already up-to-date and named slot ids already render through `slot.draw(...)`, return an empty `actions` array and a one-sentence response."
  ].join("\n");
  const userPrompt = request.prompt && request.prompt.trim().length > 0
    ? request.prompt
    : "Apply the bound assets for the slot ids above by ensuring the loader and call sites are correct.";
  return [directives, "", "User request:", userPrompt].join("\n");
}

function buildRoutedPrompt(request: PromptRequest): string {
  if (request.templateMode === "asset-applier") {
    return buildAssetApplierPrompt(request);
  }

  const effectiveWorkspacePath =
    typeof request.workspacePath === "string" && request.workspacePath
      ? request.workspacePath
      : workspaceRoot;

  let templateMode: CreatorTemplateMode | undefined =
    request.templateMode === "game-creator" || request.templateMode === "widget-creator"
      ? request.templateMode
      : undefined;
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
  let availableWidgetFonts: WidgetFontCatalogEntry[] = [];
  if (templateMode === "widget-creator" && fs.existsSync(widgetFontManifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(widgetFontManifestPath, "utf-8")) as Parameters<
        typeof parseWidgetFontCatalogFromManifest
      >[0];
      availableWidgetFonts = parseWidgetFontCatalogFromManifest(manifest);
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
  const confPath =
    effectiveWorkspacePath && effectiveWorkspacePath.length > 0
      ? path.join(effectiveWorkspacePath, "conf.json")
      : "";
  const confJsonExists = confPath.length > 0 && fs.existsSync(confPath);
  const resolvedProjectType: ProjectType =
    projectType === "game" || projectType === "widget" ? projectType : templateMode === "widget-creator" ? "widget" : "game";
  const buildPlanBlock =
    shouldIncludeCreatorBuildPlan(templateMode, confJsonExists) &&
      (resolvedProjectType === "game" || resolvedProjectType === "widget")
      ? [
        formatCreatorBuildPlanMessage({
          templateMode,
          projectType: resolvedProjectType,
          widgetSize: widgetSize as WidgetSize | undefined
        }),
        ""
      ]
      : [];
  return [
    template,
    "",
    ...buildPlanBlock,
    "Creation context:",
    JSON.stringify(context, null, 2),
    "",
    "User request:",
    request.prompt
  ].join("\n");
}

function resolveAgentRuntimeSkillsDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "packages", "agent-runtime", "skills")] : []),
    path.resolve(process.cwd(), "packages/agent-runtime/skills"),
    path.resolve(process.cwd(), "../packages/agent-runtime/skills"),
    path.resolve(__dirname, "../../../packages/agent-runtime/skills")
  ];
  const existing = candidates.find((dir) => fs.existsSync(path.join(dir, "dartsnut-skill.md")));
  if (!existing) {
    throw new Error(`Skill directory not found (expected dartsnut-skill.md); tried: ${candidates.join(", ")}`);
  }
  return existing;
}

function resolveSkillSessionContext(
  templateMode?: PromptRequest["templateMode"] | "creation-intake" | null
): {
  skillPrompt: string;
  skillLibrary?: { skillsDir: string; allowedIds: ReturnType<typeof allowedDeferredSkillIdsForMode> };
} {
  const skillsDir = resolveAgentRuntimeSkillsDir();
  if (templateMode === "creation-intake") {
    return {
      skillPrompt: bundleForTemplateMode(skillsDir, "creation-intake")
    };
  }
  return {
    skillPrompt: resolveSkillRouterPrompt(skillsDir, templateMode ?? null),
    skillLibrary: {
      skillsDir,
      allowedIds: allowedDeferredSkillIdsForMode(templateMode ?? null)
    }
  };
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

function sendToRenderer(channel: string, ...args: unknown[]) {
  if (!win || win.isDestroyed()) {
    return;
  }
  win.webContents.send(channel, ...(args as [unknown, ...unknown[]]));
}

function mirrorMainProcessConsole(payload: MainProcessConsoleMirrorPayload): void {
  if (!isDevLoggingEnabled()) {
    return;
  }
  sendToRenderer(IPCChannels.mainProcessConsoleMirror, payload);
}

/** Logs to the Electron terminal and mirrors the same line into renderer DevTools (dev only). */
function terminalAgentLifecycleLog(message: string, meta?: Record<string, unknown>): void {
  if (!isDevLoggingEnabled()) {
    return;
  }
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  devLog.log(line);
  mirrorMainProcessConsole({ level: "log", prefix: "", message: line });
}

function logAgentEventToConsole(event: AgentEvent, mirrorToDevtools: boolean): void {
  if (!isDevLoggingEnabled()) {
    return;
  }
  if (event.type === "stream" || event.type === "reasoning_stream") {
    return;
  }
  const formatted = formatAgentEventForConsole(event);
  if (!formatted) {
    return;
  }
  for (const line of formatted.lines) {
    if (!line.trim()) {
      continue;
    }
    if (formatted.level === "error") {
      devLog.error("[agent]", line);
      if (mirrorToDevtools) {
        mirrorMainProcessConsole({ level: "error", prefix: "[agent]", message: line });
      }
    } else if (formatted.level === "warn") {
      devLog.warn("[agent]", line);
      if (mirrorToDevtools) {
        mirrorMainProcessConsole({ level: "warn", prefix: "[agent]", message: line });
      }
    } else if (formatted.level === "debug") {
      devLog.debug("[agent]", line);
      if (mirrorToDevtools) {
        mirrorMainProcessConsole({ level: "debug", prefix: "[agent]", message: line });
      }
    } else {
      devLog.info("[agent]", line);
      if (mirrorToDevtools) {
        mirrorMainProcessConsole({ level: "info", prefix: "[agent]", message: line });
      }
    }
  }
}

/** Logical px; must match `titleBarOverlay.height` on Windows when overlay is enabled. */
const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 32;

/** Match renderer `themes.css` `--color-bg-page` and caption contrast per theme. */
const WINDOWS_SHELL_UI: Record<
  ShellUiTheme,
  { titleBarColor: string; symbolColor: string; windowBackground: string }
> = {
  dark: {
    titleBarColor: "#121212",
    symbolColor: "#e0e0e0",
    windowBackground: "#121212"
  },
  light: {
    titleBarColor: "#eef1f8",
    symbolColor: "#1a2332",
    windowBackground: "#eef1f8"
  }
};

function applyShellUiTheme(theme: ShellUiTheme): void {
  nativeTheme.themeSource = theme;
  if (!win || win.isDestroyed()) {
    return;
  }
  if (process.platform !== "win32") {
    return;
  }
  const colors = WINDOWS_SHELL_UI[theme];
  try {
    win.setTitleBarOverlay({
      color: colors.titleBarColor,
      symbolColor: colors.symbolColor,
      height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT
    });
  } catch {
    /* WCO only after `titleBarStyle: "hidden"` + `titleBarOverlay` at construction; ignore if unsupported. */
  }
  win.setBackgroundColor(colors.windowBackground);
}

async function syncShellUiThemeFromDomSnapshot(): Promise<void> {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    const resolved = await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme === "light" ? "light" : "dark"`,
      true
    );
    applyShellUiTheme(resolved === "light" ? "light" : "dark");
  } catch {
    applyShellUiTheme("dark");
  }
}

function computeWindowChromeInsets(window: BrowserWindow): WindowChromeInsets {
  if (window.isDestroyed()) {
    return { top: 0, left: 0, right: 0, bottom: 0 };
  }
  if (window.isFullScreen() || window.isSimpleFullScreen()) {
    return { top: 0, left: 0, right: 0, bottom: 0 };
  }
  /* macOS: title-bar row height (traffic lights + comfortable padding for web chrome). */
  if (process.platform === "darwin") {
    return { top: 32, left: 0, right: 0, bottom: 0 };
  }
  if (process.platform === "win32") {
    return { top: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT, left: 0, right: 0, bottom: 0 };
  }
  return { top: 0, left: 0, right: 0, bottom: 0 };
}

function emitWindowChromeInsets(): void {
  if (!win || win.isDestroyed()) {
    return;
  }
  sendToRenderer(IPCChannels.windowChromeInsetsChanged, computeWindowChromeInsets(win));
}

/** Last key from `webContents.insertCSS` — remove before re-inserting on resize/fullscreen. */
let chromeInsetInsertedCssKey: string | undefined;

/**
 * Shell padding + drag/no-drag via `insertCSS` (Chromium-level).
 * Drag model: `#root` is draggable; `.left-rail` / `.right-pane` are no-drag so UI works; `.app-bar` is drag again.
 * On macOS, `html,body { overflow: visible }` — `overflow:hidden` ancestors break `-webkit-app-region: drag`.
 */
async function pushWindowChromeInsetAuthorStyle(): Promise<void> {
  if (!win || win.isDestroyed()) {
    return;
  }
  const i = computeWindowChromeInsets(win);
  const top = Math.max(0, Math.round(i.top));
  const left = Math.max(0, Math.round(i.left));
  const right = Math.max(0, Math.round(i.right));
  const bottom = Math.max(0, Math.round(i.bottom));

  const isDarwin = process.platform === "darwin";

  let css =
    `body .app-shell{padding-top:0!important;padding-right:${right}px!important;padding-bottom:${bottom}px!important;padding-left:${left}px!important;overflow:visible!important}` +
    `:root{--window-control-inset-top:${top}px!important}` +
    `body .app-shell .left-rail{overflow:visible!important}` +
    `#root{overflow:visible!important}`;

  if (isDarwin) {
    css += `html,body{overflow:visible!important}`;
  }

  /* Window drag: `.window-chrome-drag-strip` only (renderer). Avoid padding-top here — row 1 height uses the CSS var above. */

  if (chromeInsetInsertedCssKey) {
    try {
      await win.webContents.removeInsertedCSS(chromeInsetInsertedCssKey);
    } catch {
      /* stale key after navigation */
    }
    chromeInsetInsertedCssKey = undefined;
  }

  chromeInsetInsertedCssKey = await win.webContents.insertCSS(css, { cssOrigin: "author" });
}

function emitChromeInsetsAndPushStyles(): void {
  void pushWindowChromeInsetAuthorStyle()
    .then(() => {
      emitWindowChromeInsets();
    })
    .catch((err: unknown) => {
      devLog.error("[dartsnut] window chrome insertCSS failed:", err);
      emitWindowChromeInsets();
    });
}

function sendBridgeCommandSafe(command: EmulatorCommand): void {
  if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
    startPythonBridge();
  }
  if (bridgeProcess?.stdin && !bridgeProcess.stdin.destroyed) {
    bridgeProcess.stdin.write(`${JSON.stringify({ command })}\n`);
  } else {
    emulatorState.status = "Bridge unavailable";
    emulatorState.running = false;
    emitEmulatorState();
  }
}

/** Mirror Python `stop_widget` idle snapshot if stdout lags. */
function applyIdleEmulatorMainState(): void {
  emulatorState.widgetPath = null;
  emulatorState.widgetId = null;
  emulatorState.widgetType = null;
  emulatorState.running = false;
  emulatorState.lastError = undefined;
  emulatorState.status = "Idle";
  clearEmulatorLogRing();
}

function performSessionCleanup(options: { clearWorkspace: boolean }): void {
  sendBridgeCommandSafe({ type: "stop_widget" });
  applyIdleEmulatorMainState();
  void disconnectDeployMachine();
  if (options.clearWorkspace) {
    workspaceRoot = null;
    assetManager.stop();
    stopDeployConfWatcher();
    lastWidgetDir = null;
    writeTempWorkspaceRecordToDisk(null);
    writeEmulatorState();
  }
  sendToRenderer(IPCChannels.sessionReset);
  emitEmulatorState();
}

function emitEmulatorState() {
  sendToRenderer(EMULATOR_IPC_CHANNELS.emulatorState, emulatorState);
}

function emitEmulatorFrame(frame: EmulatorFrame) {
  sendToRenderer(EMULATOR_IPC_CHANNELS.emulatorFrame, frame);
}

function emitEmulatorLog(entry: EmulatorLogEntry) {
  pushEmulatorLogRing(entry);
  sendToRenderer(EMULATOR_IPC_CHANNELS.emulatorLog, entry);
}

function emitPythonRuntimeStatus() {
  sendToRenderer(IPCChannels.subscribePythonRuntimeStatus, pythonRuntimeStatus);
}

function setPythonRuntimeStatus(status: string | null) {
  pythonRuntimeStatus = status;
  emitPythonRuntimeStatus();
}

function canRunEmulatorDeps(executable: string): boolean {
  const probe = spawnSync(executable, ["-c", "import pydartsnut, pygame, PIL; print('ok')"], {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf-8",
  });
  return probe.status === 0;
}

function runCommandOkAsync(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function emitPythonSetupLog(source: "stdout" | "stderr", phase: string, line: string): void {
  const trimmed = line.trimEnd();
  if (!trimmed.trim()) {
    return;
  }
  emitEmulatorLog({
    source,
    text: `${PYTHON_SETUP_LOG_PREFIX} [${phase}] ${trimmed}`,
    timestampMs: Date.now(),
  });
}

function runPackagedPythonSetupCommandAsync(
  command: string,
  args: string[],
  cwd: string,
  phase: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const attach = (stream: NodeJS.ReadableStream | null | undefined, source: "stdout" | "stderr") => {
      if (!stream) {
        return;
      }
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => emitPythonSetupLog(source, phase, line));
    };
    attach(child.stdout, "stdout");
    attach(child.stderr, "stderr");
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function isPythonVersionSupportedAsync(executable: string): Promise<boolean> {
  return runCommandOkAsync(
    executable,
    ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
    repoRoot,
  );
}

function isPythonVersionSupportedSync(executable: string): boolean {
  const result = spawnSync(
    executable,
    ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
    {
      cwd: repoRoot,
      stdio: "pipe",
    },
  );
  return result.status === 0;
}

function compareVersionDirsDescending(a: string, b: string): number {
  const parse = (s: string) =>
    s.split(".").map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? -1 : n;
    });
  const ap = parse(a);
  const bp = parse(b);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = ap[i] ?? -1;
    const bv = bp[i] ?? -1;
    if (av !== bv) return bv - av;
  }
  return 0;
}

// Packaged macOS Electron apps inherit launchd's minimal PATH, which breaks
// asdf/pyenv shims (they shell out to `asdf`/`pyenv` via PATH). Resolve real
// interpreter binaries directly so the bootstrap step doesn't depend on shims.
function listInstalledPythonBinaries(home: string): string[] {
  const installRoots = [
    path.join(home, ".asdf", "installs", "python"),
    path.join(home, ".pyenv", "versions"),
  ];
  const result: string[] = [];
  for (const root of installRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const versions = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(compareVersionDirsDescending);
    for (const ver of versions) {
      const binDir = path.join(root, ver, "bin");
      for (const exe of ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]) {
        const p = path.join(binDir, exe);
        if (fs.existsSync(p)) {
          result.push(p);
          break;
        }
      }
    }
  }
  return result;
}

function pythonCandidates(): string[] {
  const home = app.getPath("home");
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const windowsVersions = ["312", "311", "310"];
  const windowsPythonCandidates = [
    ...windowsVersions.flatMap((version) => [
      path.join(localAppData, "Programs", "Python", `Python${version}`, "python.exe"),
      `C:\\Python${version}\\python.exe`,
      path.join(programFiles, "Python", `Python${version}`, "python.exe"),
      path.join(programFilesX86, "Python", `Python${version}`, "python.exe")
    ]),
    path.join(localAppData, "Microsoft", "WindowsApps", "python.exe"),
    path.join(home, "scoop", "shims", "python.exe"),
    path.join(home, ".pyenv", "pyenv-win", "shims", "python.exe")
  ];

  return [
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
    "python",
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.11",
    "/opt/homebrew/bin/python3.10",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3.12",
    "/usr/local/bin/python3.11",
    "/usr/local/bin/python3.10",
    "/usr/local/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3",
    ...listInstalledPythonBinaries(home),
    path.join(home, ".pyenv", "shims", "python3.12"),
    path.join(home, ".pyenv", "shims", "python3.11"),
    path.join(home, ".pyenv", "shims", "python3.10"),
    path.join(home, ".pyenv", "shims", "python3"),
    path.join(home, ".pyenv", "shims", "python"),
    path.join(home, ".asdf", "shims", "python3.12"),
    path.join(home, ".asdf", "shims", "python3.11"),
    path.join(home, ".asdf", "shims", "python3.10"),
    path.join(home, ".asdf", "shims", "python3"),
    path.join(home, ".asdf", "shims", "python"),
    ...windowsPythonCandidates
  ];
}

function venvPythonPath(venvDir: string): string {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

function repoVenvPythonCandidates(): string[] {
  const venvDir = path.join(repoRoot, ".venv");
  if (process.platform === "win32") {
    return [
      venvPythonPath(venvDir),
      path.join(venvDir, "Scripts", "python3.12.exe"),
      path.join(venvDir, "Scripts", "python3.11.exe"),
      path.join(venvDir, "Scripts", "python3.10.exe")
    ];
  }
  return [
    venvPythonPath(venvDir),
    path.join(venvDir, "bin", "python3.12"),
    path.join(venvDir, "bin", "python3.11"),
    path.join(venvDir, "bin", "python3.10")
  ];
}

function pythonProcessEnv(executable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
  const venvDir = path.join(repoRoot, ".venv");
  for (const venvPython of repoVenvPythonCandidates()) {
    if (path.resolve(executable) === path.resolve(venvPython)) {
      env.VIRTUAL_ENV = venvDir;
      const binDir = path.dirname(venvPython);
      env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
      break;
    }
  }
  return env;
}

function firstRunnablePython(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (
      canRunEmulatorDeps(candidate) &&
      isPythonVersionSupportedSync(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

async function canRunEmulatorDepsAsync(executable: string): Promise<boolean> {
  return runCommandOkAsync(executable, ["-c", "import pydartsnut, pygame, PIL; print('ok')"], repoRoot);
}

async function ensurePackagedPythonRuntime(preferredPython?: string | null): Promise<string | null> {
  if (!app.isPackaged) {
    return null;
  }
  const runtimeDir = path.join(app.getPath("userData"), "python-runtime");
  const runtimePython = venvPythonPath(runtimeDir);
  if ((await isPythonVersionSupportedAsync(runtimePython)) && (await canRunEmulatorDepsAsync(runtimePython))) {
    return runtimePython;
  }

  const pythonBootstrapCandidates = preferredPython
    ? [preferredPython, ...pythonCandidates()]
    : pythonCandidates();
  let bootstrapPython: string | null = null;
  for (const candidate of pythonBootstrapCandidates) {
    if (
      (await runCommandOkAsync(candidate, ["--version"], repoRoot)) &&
      (await isPythonVersionSupportedAsync(candidate))
    ) {
      bootstrapPython = candidate;
      break;
    }
  }
  if (!bootstrapPython) {
    setPythonRuntimeStatus("Python runtime setup failed: Python 3.10+ is required.");
    return null;
  }

  fs.mkdirSync(runtimeDir, { recursive: true });
  setPythonRuntimeStatus("Setting up Python runtime (first run). This can take a minute...");
  emitPythonSetupLog("stdout", "bootstrap", `Using interpreter: ${bootstrapPython}`);

  if (!(await runPackagedPythonSetupCommandAsync(bootstrapPython, ["-m", "venv", runtimeDir], repoRoot, "venv"))) {
    setPythonRuntimeStatus("Python runtime setup failed while creating virtual environment.");
    return null;
  }
  if (
    !(await runPackagedPythonSetupCommandAsync(
      runtimePython,
      ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
      repoRoot,
      "pip-upgrade",
    ))
  ) {
    setPythonRuntimeStatus("Python runtime setup failed while upgrading pip.");
    return null;
  }
  const requirementsPath = path.join(repoRoot, "requirements.txt");
  if (!fs.existsSync(requirementsPath)) {
    setPythonRuntimeStatus("Python runtime setup failed: requirements.txt is missing.");
    return null;
  }
  if (
    !(await runPackagedPythonSetupCommandAsync(
      runtimePython,
      ["-m", "pip", "install", "-r", requirementsPath],
      repoRoot,
      "pip-install",
    ))
  ) {
    setPythonRuntimeStatus("Python runtime setup failed while installing dependencies.");
    return null;
  }
  if (!(await canRunEmulatorDepsAsync(runtimePython))) {
    setPythonRuntimeStatus("Python runtime setup failed: dependency check did not pass.");
    return null;
  }
  setPythonRuntimeStatus(null);
  return runtimePython;
}

async function resolvePythonExecutable(): Promise<string> {
  const envOverride = process.env.DARTSNUT_PYTHON?.trim();
  if (envOverride) {
    if (canRunEmulatorDeps(envOverride) && isPythonVersionSupportedSync(envOverride)) {
      return envOverride;
    }
    setPythonRuntimeStatus(
      "DARTSNUT_PYTHON is set but missing emulator deps (pydartsnut/pygame-ce/Pillow)."
    );
  }
  const selectedPythonPath = readSelectedPythonPath();
  const packagedRuntimePython = app.isPackaged
    ? await ensurePackagedPythonRuntime(selectedPythonPath)
    : null;
  if (packagedRuntimePython) {
    setPythonRuntimeStatus(null);
    return packagedRuntimePython;
  }

  const searchLists: string[][] = app.isPackaged
    ? [
      ...(selectedPythonPath ? [[selectedPythonPath]] : []),
      repoVenvPythonCandidates(),
      pythonCandidates()
    ]
    : [
      repoVenvPythonCandidates(),
      ...(selectedPythonPath ? [[selectedPythonPath]] : []),
      pythonCandidates()
    ];

  for (const group of searchLists) {
    const found = firstRunnablePython(group);
    if (found) {
      setPythonRuntimeStatus(null);
      return found;
    }
  }

  const setupHint = app.isPackaged
    ? "Python 3.10+ with pydartsnut/pygame-ce/Pillow is required. Restart the app after setup completes."
    : "Missing Python 3.10+ or emulator deps (pydartsnut/pygame-ce/Pillow). Run: pnpm setup:python";
  setPythonRuntimeStatus(setupHint);
  emulatorState.status = setupHint;
  emitEmulatorState();
  const venvFallback = repoVenvPythonCandidates().find((candidate) => fs.existsSync(candidate));
  return venvFallback ?? (process.platform === "win32" ? "python" : "python3");
}

function stopPythonBridge(): void {
  if (bridgeProcess) {
    bridgeProcess.kill();
    bridgeProcess = null;
    bridgePythonExec = null;
  }
}

function startPythonBridge() {
  if (!canRunEmulatorDeps(pythonExec) || !isPythonVersionSupportedSync(pythonExec)) {
    emulatorState.status =
      pythonRuntimeStatus ??
      "Python runtime is not ready (pydartsnut/pygame-ce/Pillow). Run: pnpm setup:python";
    emulatorState.running = false;
    emitEmulatorState();
    return;
  }
  if (bridgeProcess && bridgePythonExec === pythonExec) {
    return;
  }
  stopPythonBridge();
  const bridgePath = path.join(repoRoot, "services", "emulator-core", "bridge_service.py");
  bridgeProcess = spawn(pythonExec, [bridgePath], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repoRoot,
    env: pythonProcessEnv(pythonExec),
  });
  bridgePythonExec = pythonExec;
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
      const jsonLine = line.replace(/\r/g, "");
      try {
        const event = JSON.parse(jsonLine) as {
          event: string;
          payload: Record<string, unknown>;
        };
        if (event.event === "diag") {
          continue;
        }
        if (event.event === "frame") {
          const fr = event.payload as EmulatorFrame;
          emitEmulatorFrame(fr);
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
        emulatorState.status = jsonLine.trim();
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
    bridgePythonExec = null;
    emulatorState.running = false;
    emulatorState.status = "Bridge stopped";
    emitEmulatorState();
  });
}

function shouldAttachAgentSessionPersistence(workspaceForSession: string | null | undefined): boolean {
  if (!workspaceForSession) {
    return false;
  }
  if (isAgentSessionPersistenceDisabledByEnv()) {
    return false;
  }
  return true;
}

function buildWorkspaceSessionPersistence(
  workspaceForSession: string | null | undefined
): AgentSessionPersistence | undefined {
  if (!shouldAttachAgentSessionPersistence(workspaceForSession)) {
    return undefined;
  }
  return new AgentSessionPersistence(workspaceForSession!);
}

function resolvePreferredUserLocaleForSession(
  latestUserText: string,
  persistence?: AgentSessionPersistence
): UserLocale {
  const persisted = persistence?.readManifest()?.preferredUserLocale ?? null;
  return resolveSessionUserLocale(persisted, latestUserText);
}

function buildSession(
  templateMode: PromptRequest["templateMode"] | undefined,
  extras?: {
    workspacePath?: string;
    completionTools?: typeof AGENT_TOOL_SCHEMAS | typeof AGENT_CREATION_INTAKE_TOOL_SCHEMAS;
    hostIntakeToolHandler?: (args: Record<string, unknown>) => Promise<string>;
    hostAskQuestionHandler?: (args: Record<string, unknown>) => Promise<string>;
    hostIntakeReadyToFinish?: () => boolean;
    skipInitialWorkspaceResolve?: boolean;
    skillBundleMode?: PromptRequest["templateMode"] | "creation-intake" | null;
    sessionPersistence?: AgentSessionPersistence;
    initialConversation?: ChatMessage[];
    preferredUserLocale?: UserLocale | null;
    latestUserTextForLocale?: string;
  }
): SessionEngine {
  const workspacePath = extras?.workspacePath ?? workspaceRoot;
  if (!workspacePath) {
    throw new Error("Workspace is not selected.");
  }
  const providerSettings = readProviderSettings();
  const config = loadProviderConfig({
    activeProvider: providerSettings.activeProvider,
    userDefine: providerSettings.userDefine
  });
  const validation = validateProviderConfig(config, providerSettings.activeProvider);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const skillBundleMode =
    extras?.skillBundleMode !== undefined ? extras.skillBundleMode : templateMode ?? null;
  const { skillPrompt, skillLibrary } = resolveSkillSessionContext(skillBundleMode);
  const intakeToolsOnly = extras?.completionTools === AGENT_CREATION_INTAKE_TOOL_SCHEMAS;
  const preferredUserLocale =
    extras?.preferredUserLocale ??
    (extras?.latestUserTextForLocale != null
      ? resolvePreferredUserLocaleForSession(extras.latestUserTextForLocale, extras.sessionPersistence)
      : null);
  return new SessionEngine({
    provider: new ProviderClient(config),
    workspacePolicy: new WorkspacePolicy(workspacePath),
    skillPrompt,
    skillLibrary,
    preferredUserLocale,
    assetRoots: {
      widgetFonts: path.join(repoRoot, "assets", "fonts", "widgets")
    },
    completionTools: extras?.completionTools,
    hostIntakeToolHandler: extras?.hostIntakeToolHandler,
    hostAskQuestionHandler: extras?.hostAskQuestionHandler,
    hostIntakeReadyToFinish: extras?.hostIntakeReadyToFinish,
    hostReloadEmulatorHandler: intakeToolsOnly ? undefined : () => executeHostReloadEmulatorForAgent(),
    hostGetEmulatorLogsHandler: intakeToolsOnly
      ? undefined
      : (args) => Promise.resolve(executeHostGetEmulatorLogsForAgent(args)),
    skipInitialWorkspaceResolve: extras?.skipInitialWorkspaceResolve,
    sessionPersistence: extras?.sessionPersistence,
    initialConversation: extras?.initialConversation,
    sessionTemplateMode: templateMode ?? null,
    sessionSection: skillBundleMode === null ? null : String(skillBundleMode)
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
    backgroundColor: WINDOWS_SHELL_UI.dark.windowBackground,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(process.platform === "win32"
      ? {
        /* Required with `titleBarOverlay` so `setTitleBarOverlay` works (avoids "Titlebar overlay is not enabled"). */
        titleBarStyle: "hidden" as const,
        titleBarOverlay: {
          color: WINDOWS_SHELL_UI.dark.titleBarColor,
          symbolColor: WINDOWS_SHELL_UI.dark.symbolColor,
          height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT
        }
      }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.webContents.on("did-finish-load", () => {
    void syncShellUiThemeFromDomSnapshot().catch(() => {
      /* Theme sync uses executeJavaScript; failures are non-fatal. */
    });
    emitChromeInsetsAndPushStyles();
    setTimeout(emitChromeInsetsAndPushStyles, 50);
    setTimeout(emitChromeInsetsAndPushStyles, 300);
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  // Guard quit here while the window is still alive; async native dialogs during `before-quit`
  // caused unstable macOS teardown behavior.
  win.on("close", (event) => {
    if (allowWindowCloseWithoutTempPrompt || !isTemporaryWorkspaceActiveNow()) {
      allowWindowCloseWithoutTempPrompt = false;
      return;
    }
    event.preventDefault();
    // `close` can run before `before-quit` on macOS; mark quit intent now so one Cmd+Q finishes after the guard.
    appQuitRequested = true;
    void (async () => {
      const proceed = await ensureTemporaryWorkspaceResolvedForGuard("quit");
      if (!proceed) {
        appQuitRequested = false;
        return;
      }
      allowWindowCloseWithoutTempPrompt = true;
      const windowRef = win;
      if (!windowRef || windowRef.isDestroyed()) {
        app.quit();
        return;
      }
      // Close the window (do not call app.quit here — the first quit was aborted by preventDefault).
      windowRef.close();
    })();
  });
  win.on("closed", () => {
    allowWindowCloseWithoutTempPrompt = false;
    chromeInsetInsertedCssKey = undefined;
    win = null;
  });
  win.on("resize", emitChromeInsetsAndPushStyles);
  win.on("maximize", emitChromeInsetsAndPushStyles);
  win.on("unmaximize", emitChromeInsetsAndPushStyles);
  win.on("enter-full-screen", emitChromeInsetsAndPushStyles);
  win.on("leave-full-screen", emitChromeInsetsAndPushStyles);
  emitEmulatorState();
}

app.whenReady().then(async () => {
  // Resolve Python before workspace recovery — recovery can start the bridge via applyWorkspaceRoot.
  pythonExec = await resolvePythonExecutable();
  await maybeRecoverTrackedTempWorkspaceAtLaunch();
  ensureTemporaryWorkspaceRootAllocated();
  startPythonBridge();
  await createWindow();
  emitBootstrapStateToRenderer();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  appQuitRequested = true;
});

app.on("will-quit", () => {
  stopPythonBridgeProcess();
  assetManager.stop();
  void disconnectDeployMachine();
  const pending = pendingTempDirRemovalOnQuit;
  pendingTempDirRemovalOnQuit = null;
  if (pending) {
    removeDirectoryBestEffort(pending);
  }
});

ipcMain.handle(IPCChannels.windowChromeInsets, (): WindowChromeInsets => {
  if (!win || win.isDestroyed()) {
    return { top: 0, left: 0, right: 0, bottom: 0 };
  }
  return computeWindowChromeInsets(win);
});

ipcMain.handle(IPCChannels.shellUiTheme, (_event: unknown, theme: unknown): void => {
  if (theme === "light" || theme === "dark") {
    applyShellUiTheme(theme);
  }
});

ipcMain.handle(IPCChannels.bootstrapState, () => getBootstrapState());

ipcMain.handle(IPCChannels.getWorkspaceSessionSummary, (): AgentSessionWorkspaceSummary => {
  const ws = workspaceRoot;
  if (!ws || !shouldAttachAgentSessionPersistence(ws)) {
    return {
      hasPersistedSession: false,
      sessionId: null,
      updatedAt: null,
      templateMode: null,
      transcriptTail: []
    };
  }
  const persistence = new AgentSessionPersistence(ws);
  const manifest = persistence.readManifest();
  return {
    hasPersistedSession: persistence.hasPersistedSession(),
    sessionId: manifest?.sessionId ?? null,
    updatedAt: manifest?.updatedAt ?? null,
    templateMode: manifest?.templateMode ?? null,
    transcriptTail: persistence.readTranscriptTail(200)
  };
});

ipcMain.handle(
  IPCChannels.resetWorkspaceSession,
  (): { ok: true } | { ok: false; reason: "no_workspace" | "persistence_disabled" } => {
    const ws = workspaceRoot;
    if (!ws) {
      return { ok: false, reason: "no_workspace" };
    }
    const persistence = buildWorkspaceSessionPersistence(ws);
    if (!persistence) {
      return { ok: false, reason: "persistence_disabled" };
    }
    persistence.archiveOrResetSession("user-reset");
    return { ok: true };
  }
);

ipcMain.handle(
  IPCChannels.prepareWorkspaceForProviderSwitch,
  async (): Promise<PrepareWorkspaceForProviderSwitchResponse> => {
    if (isTemporaryWorkspaceActiveNow()) {
      await discardTrackedTemporaryProject();
      return { ok: true, state: getBootstrapState() };
    }
    const ws = workspaceRoot;
    if (!ws) {
      return { ok: false, reason: "no_workspace" };
    }
    const persistence = buildWorkspaceSessionPersistence(ws);
    if (!persistence) {
      return { ok: false, reason: "persistence_disabled" };
    }
    persistence.archiveOrResetSession("provider-switch");
    return { ok: true, state: getBootstrapState() };
  }
);

ipcMain.handle(IPCChannels.deployGetEligibility, (): DeployEligibility => readDeployEligibilityFromWorkspace());

function parseDeployWidgetParamsJson(raw: string | undefined): Record<string, unknown> {
  const text = (raw ?? "").trim() || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Widget params must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Widget params must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

ipcMain.handle(
  IPCChannels.deployConnect,
  async (_event: unknown, request: DeployConnectRequest): Promise<DeployConnectResponse> => {
    try {
      const session = getDeployMachineSession();
      const { deviceName } = await session.connect(request.host.trim());
      try {
        emitDeployLog("[deploy] Stopping any ~/dartsnut_rpi/apps/*/main.py still running on device…");
        await session.killAppMainPyProcesses();
        await session.restartDartsnutPythonServiceIfInactive();
        return { ok: true, deviceName };
      } catch (cleanupError) {
        await disconnectDeployMachine();
        throw cleanupError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitDeployLog(`[deploy] Connect failed: ${message}`);
      return { ok: false, error: message };
    }
  },
);

ipcMain.handle(IPCChannels.deployDisconnect, async (): Promise<DeployActionResponse> => {
  try {
    const session = getDeployMachineSession();
    if (!session.connected) {
      return { ok: false, error: "SSH not connected." };
    }
    emitDeployLog("[deploy] Disconnect — stop log tail, kill debug Python, restart dartsnut_python.service…");
    session.stopLogTail();
    await session.killDebugPython();
    await session.killAppMainPyProcesses();
    await session.restartSystemdService();
    await disconnectDeployMachine();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitDeployLog(`[deploy] Disconnect failed: ${message}`);
    return { ok: false, error: message };
  }
});

ipcMain.handle(
  IPCChannels.deployRun,
  async (_event: unknown, request?: DeployLaunchRequest): Promise<DeployActionResponse> => {
    const elig = readDeployEligibilityFromWorkspace();
    if (!elig.ok) {
      return { ok: false, error: `Workspace not deployable (${elig.reason}).` };
    }
    if (!workspaceRoot) {
      return { ok: false, error: "No workspace open." };
    }
    let widgetParams: Record<string, unknown> | undefined;
    if (elig.projectType === "widget") {
      try {
        widgetParams = parseDeployWidgetParamsJson(request?.widgetParamsJson);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    }
    try {
      const session = getDeployMachineSession();
      if (!session.connected) {
        throw new Error("SSH not connected. Enter the device IP and click Connect.");
      }
      emitDeployLog("[deploy] Run — sync, stop service, start debug Python…");
      await session.syncWorkspace(workspaceRoot, elig.appId);
      await session.stopSystemdService();
      await session.killDebugPython();
      session.stopLogTail();
      await session.startDebugPython(elig.appId, { projectType: elig.projectType, widgetParams });
      session.startLogTail();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitDeployLog(`[deploy] Run failed: ${message}`);
      return { ok: false, error: message };
    }
  },
);

ipcMain.handle(
  IPCChannels.deployReload,
  async (_event: unknown, request?: DeployLaunchRequest): Promise<DeployActionResponse> => {
    const elig = readDeployEligibilityFromWorkspace();
    if (!elig.ok) {
      return { ok: false, error: `Workspace not deployable (${elig.reason}).` };
    }
    let widgetParams: Record<string, unknown> | undefined;
    if (elig.projectType === "widget") {
      try {
        widgetParams = parseDeployWidgetParamsJson(request?.widgetParamsJson);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    }
    try {
      const session = getDeployMachineSession();
      if (!session.connected) {
        throw new Error("SSH not connected.");
      }
      emitDeployLog("[deploy] Reload — restart debug Python…");
      await session.killDebugPython();
      session.stopLogTail();
      await session.startDebugPython(elig.appId, { projectType: elig.projectType, widgetParams });
      session.startLogTail();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitDeployLog(`[deploy] Reload failed: ${message}`);
      return { ok: false, error: message };
    }
  },
);

ipcMain.handle(IPCChannels.deployStop, async (): Promise<DeployActionResponse> => {
  const elig = readDeployEligibilityFromWorkspace();
  if (!elig.ok) {
    return { ok: false, error: `Workspace not deployable (${elig.reason}).` };
  }
  try {
    const session = getDeployMachineSession();
    if (!session.connected) {
      throw new Error("SSH not connected.");
    }
    emitDeployLog("[deploy] Stop — remove app folder, restore dartsnut_python.service…");
    session.stopLogTail();
    await session.killDebugPython();
    await session.removeRemoteAppFolder(elig.appId);
    await session.startSystemdService();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitDeployLog(`[deploy] Stop failed: ${message}`);
    return { ok: false, error: message };
  }
});
ipcMain.handle(IPCChannels.getProviderSettings, () =>
  enrichProviderSettingsForRenderer(readProviderSettings())
);
ipcMain.handle(IPCChannels.getPythonRuntimeStatus, () => pythonRuntimeStatus);
ipcMain.handle(IPCChannels.getSelectedPythonPath, () => readSelectedPythonPath());
ipcMain.handle(IPCChannels.saveProviderSettings, (_event: unknown, request: SaveProviderSettingsRequest) =>
  writeProviderSettings(request)
);
ipcMain.handle(IPCChannels.pickPythonPath, async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    title: "Select Python executable",
    defaultPath: readSelectedPythonPath() ?? app.getPath("home")
  });
  if (result.canceled || !result.filePaths[0]) {
    return {
      accepted: false,
      selectedPath: null,
      error: "cancelled"
    };
  }
  const selectedPath = result.filePaths[0];
  if (!isPythonVersionSupportedSync(selectedPath)) {
    return {
      accepted: false,
      selectedPath,
      error: "Python 3.10+ is required."
    };
  }
  if (!canRunEmulatorDeps(selectedPath)) {
    return {
      accepted: false,
      selectedPath,
      error: "That Python is missing emulator deps (pydartsnut, pygame-ce, Pillow)."
    };
  }
  const persistedPath = writeSelectedPythonPath(selectedPath);
  pythonExec = await resolvePythonExecutable();
  stopPythonBridge();
  startPythonBridge();
  return {
    accepted: true,
    selectedPath: persistedPath
  };
});

ipcMain.handle(IPCChannels.startNewProject, async () => {
  const proceed = await ensureTemporaryWorkspaceResolvedForGuard("new_project");
  if (!proceed) {
    return getBootstrapState();
  }
  performSessionCleanup({ clearWorkspace: true });
  ensureTemporaryWorkspaceRootAllocated();
  return getBootstrapState();
});

ipcMain.handle(IPCChannels.pickWorkspace, async (_event: unknown, request?: PickWorkspaceRequest) => {
  const proceed = await ensureTemporaryWorkspaceResolvedForGuard("open_workspace");
  if (!proceed) {
    return {
      state: getBootstrapState(),
      selectedPath: null,
      accepted: false,
      reason: "cancelled"
    } satisfies PickWorkspaceResponse;
  }
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
  applyWorkspaceRoot(selectedPath);
  return {
    state: getBootstrapState(),
    selectedPath,
    accepted: true
  } satisfies PickWorkspaceResponse;
});

ipcMain.handle(IPCChannels.saveTempWorkspace, async (): Promise<SaveTempWorkspaceResponse> => {
  if (!workspaceRoot) {
    return { ok: false, reason: "missing_workspace" };
  }
  if (!isTemporaryWorkspaceActiveNow()) {
    return { ok: false, reason: "not_temporary" };
  }
  const saved = await runInteractiveSaveTemporaryWorkspace();
  if (!saved) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: true, state: getBootstrapState() };
});

ipcMain.handle(
  IPCChannels.intakeSubmitQuestionAnswer,
  async (_event: unknown, body: IntakeSubmitQuestionAnswerRequest): Promise<IntakeSubmitQuestionAnswerResponse> => {
    if (!intakeChipQuestionPending) {
      return { ok: false, reason: "no_pending" };
    }
    if (body.kind === "project_type") {
      if (intakeChipQuestionPending.kind !== "project_type") {
        return { ok: false, reason: "kind_mismatch" };
      }
      if (body.value !== "game" && body.value !== "widget") {
        return { ok: false, reason: "invalid_value" };
      }
      const { resolve, state } = intakeChipQuestionPending;
      intakeChipQuestionPending = null;
      state.projectType = body.value;
      if (body.value === "game") {
        state.widgetSize = undefined;
      }
      agentEventEmitter?.({ type: "intake_project_type_prompt", at: Date.now(), visible: false });
      resolve(
        JSON.stringify({
          ok: true,
          recorded: { projectType: body.value },
          next: nextAfterProjectType(body.value)
        })
      );
      return { ok: true };
    }
    if (body.kind === "widget_size") {
      if (intakeChipQuestionPending.kind !== "widget_size") {
        return { ok: false, reason: "kind_mismatch" };
      }
      if (!WIDGET_DISPLAY_SIZES.includes(body.value)) {
        return { ok: false, reason: "invalid_value" };
      }
      const { resolve, state } = intakeChipQuestionPending;
      intakeChipQuestionPending = null;
      state.widgetSize = body.value;
      agentEventEmitter?.({ type: "intake_widget_size_prompt", at: Date.now(), visible: false });
      resolve(
        JSON.stringify({
          ok: true,
          recorded: { widgetSize: body.value },
          next: "Call **read_workspace_conf** — returns `conf.json` status for the active workspace."
        })
      );
      return { ok: true };
    }
    return { ok: false, reason: "invalid_value" };
  }
);

ipcMain.handle(
  IPCChannels.assetsGetManifest,
  async (_event: unknown, workspacePath: string): Promise<ManifestSnapshot> => {
    return assetManager.getSnapshot(workspacePath);
  }
);

ipcMain.handle(
  IPCChannels.assetsBindSlot,
  async (_event: unknown, request: BindSlotRequest): Promise<BindSlotResponse> => {
    return assetManager.bindSlot(request);
  }
);

ipcMain.handle(
  IPCChannels.assetsUnbindSlot,
  async (_event: unknown, request: UnbindSlotRequest): Promise<UnbindSlotResponse> => {
    return assetManager.unbindSlot(request);
  }
);

ipcMain.handle(
  IPCChannels.assetsReadPreview,
  async (_event: unknown, request: ReadPreviewRequest): Promise<ReadPreviewResponse> => {
    if (!request.workspacePath || !request.framePath) {
      return { ok: false, message: "workspacePath and framePath are required" };
    }
    const normalizedRel = request.framePath.replace(/\\/g, "/");
    if (path.isAbsolute(normalizedRel) || normalizedRel.includes("..")) {
      return { ok: false, message: "framePath must be a workspace-relative path" };
    }
    const absolute = path.resolve(request.workspacePath, normalizedRel);
    if (!isWithinDirectory(request.workspacePath, absolute)) {
      return { ok: false, message: "framePath escapes the workspace" };
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return { ok: false, message: "frame file does not exist" };
    }
    try {
      const bytes = fs.readFileSync(absolute);
      const ext = path.extname(absolute).toLowerCase();
      const mime = ext === ".gif" ? "image/gif" : "image/png";
      return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to read frame";
      return { ok: false, message };
    }
  }
);

ipcMain.handle(
  IPCChannels.assetsApplyAssets,
  async (_event: unknown, request: ApplyAssetsRequest): Promise<ApplyAssetsResponse> => {
    const targetWorkspace = request.workspacePath || workspaceRoot;
    if (!targetWorkspace || !fs.existsSync(targetWorkspace)) {
      return { ok: false, reason: "missing_workspace" };
    }
    const requestedSlots = Array.isArray(request.slotIds) && request.slotIds.length > 0
      ? request.slotIds
      : assetManager.getPendingSlots(targetWorkspace);
    if (requestedSlots.length === 0) {
      return { ok: false, reason: "no_pending_changes" };
    }
    const confPath = path.join(targetWorkspace, "conf.json");
    if (!fs.existsSync(confPath)) {
      return { ok: false, reason: "missing_conf", message: `no conf.json at ${targetWorkspace}` };
    }
    let projectType: ProjectType;
    try {
      const conf = JSON.parse(fs.readFileSync(confPath, "utf-8")) as { type?: string };
      projectType = conf.type === "widget" ? "widget" : "game";
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to parse conf.json";
      return { ok: false, reason: "missing_conf", message };
    }
    try {
      const session = buildSession("asset-applier");
      const prompt = buildRoutedPrompt({
        prompt: "",
        templateMode: "asset-applier",
        workspacePath: targetWorkspace,
        assetApply: { slotIds: requestedSlots, projectType }
      });
      terminalAgentLifecycleLog("[agent] runPrompt asset-applier", {
        slotIds: requestedSlots,
        projectType,
        promptChars: prompt.length
      });
      const assetEmit = createEmitAgentToRenderer();
      try {
        await session.runPrompt(prompt, (agentEvent: AgentEvent) => assetEmit.emit(agentEvent));
      } finally {
        assetEmit.flush();
      }
      assetManager.clearPending(targetWorkspace, requestedSlots);
      // Re-emit a snapshot so the UI clears the pending badge.
      sendToRenderer(IPCChannels.assetsSubscribeManifest, assetManager.getSnapshot(targetWorkspace));
      return { ok: true, appliedSlotIds: requestedSlots };
    } catch (error) {
      const message = error instanceof Error ? error.message : "asset-applier run failed";
      const event: AgentEvent = { type: "error", message, at: Date.now() };
      sendToRenderer(IPCChannels.subscribeEvents, event);
      return { ok: false, reason: "unknown", message };
    }
  }
);

function createEmitAgentToRenderer(): AgentEventBatcher & { dispose: () => void } {
  const batcher = createAgentEventBatcher((agentEvent) => {
    if (isDevLoggingEnabled()) {
      logAgentEventToConsole(agentEvent, true);
    }
    sendToRenderer(IPCChannels.subscribeEvents, agentEvent);
  });
  return {
    ...batcher,
    dispose: () => batcher.flush()
  };
}

ipcMain.handle(IPCChannels.sendPrompt, async (_event: unknown, req: PromptRequest): Promise<SendPromptResponse> => {
  sendPromptAbortController?.abort();
  const runAbort = new AbortController();
  sendPromptAbortController = runAbort;
  const emitAgentSink = createEmitAgentToRenderer();
  const emitAgent = (agentEvent: AgentEvent) => emitAgentSink.emit(agentEvent);
  try {
    ensureTemporaryWorkspaceRootAllocated();
    agentEventEmitter = emitAgent;
    let sessionRouting: SendPromptResponse["sessionRouting"];
    const hostState: IntakeToolState = {};
    const sharedIntakeHandler = async (args: Record<string, unknown>) =>
      intakeHostToolExecute(args, hostState);

    const shouldRunCreationIntake = Boolean(req.creationIntake && computeNeedsCreationIntake());

    if (shouldRunCreationIntake) {
      const intakeWorkspace = workspaceRoot;
      if (!intakeWorkspace) {
        throw new Error("Workspace is not selected.");
      }
      emitAgent({ type: "intake_widget_size_prompt", at: Date.now(), visible: false });
      emitAgent({ type: "intake_project_type_prompt", at: Date.now(), visible: false });
      const intakeState: IntakeToolState = {};
      if (req.intakeProjectTypeChoice) {
        intakeState.projectType = req.intakeProjectTypeChoice;
        if (req.intakeProjectTypeChoice === "game") {
          intakeState.widgetSize = undefined;
        }
      }
      if (req.intakeWidgetSizeChoice) {
        intakeState.projectType = "widget";
        intakeState.widgetSize = req.intakeWidgetSizeChoice;
      }
      let intakeReadWorkspaceConfDone = false;
      const intakeSession = buildSession(undefined, {
        workspacePath: intakeWorkspace,
        completionTools: AGENT_CREATION_INTAKE_TOOL_SCHEMAS,
        hostIntakeToolHandler: async (args) => {
          if (args.action === "read_workspace_conf") {
            intakeReadWorkspaceConfDone = true;
          }
          return intakeHostToolExecute(args, intakeState);
        },
        hostAskQuestionHandler: (args) => askQuestionHostExecute(args, intakeState),
        hostIntakeReadyToFinish: () =>
          isIntakeStateReady(intakeState) && intakeReadWorkspaceConfDone,
        skillBundleMode: "creation-intake",
        latestUserTextForLocale: req.prompt
      });
      terminalAgentLifecycleLog("[agent] runPrompt creation-intake start");
      const intakeUserPrompt = buildCreationIntakeUserPrompt(req.prompt, {
        widgetSizeFromPicker: req.intakeWidgetSizeChoice,
        projectTypeFromPicker: req.intakeProjectTypeChoice
      });
      await intakeSession.runPrompt(intakeUserPrompt, emitAgent, runAbort.signal);

      const canChain =
        Boolean(workspaceRoot) &&
        intakeState.projectType &&
        (intakeState.projectType === "game" ||
          (intakeState.projectType === "widget" && intakeState.widgetSize));

      if (canChain && intakeState.projectType && workspaceRoot) {
        const creatorWorkspace = intakeWorkspace;
        const templateMode =
          intakeState.projectType === "game" ? "game-creator" : "widget-creator";
        sessionRouting = {
          templateMode,
          projectType: intakeState.projectType,
          widgetSize: intakeState.projectType === "widget" ? intakeState.widgetSize : undefined
        };
        const followUpPersistence = buildWorkspaceSessionPersistence(creatorWorkspace);
        // Intake → creator is always a new scaffold: do not resume a half-finished creator
        // transcript from a prior crash/relaunch in the same temp folder (common in packaged builds).
        if (followUpPersistence) {
          followUpPersistence.archiveOrResetSession("post-intake-creator-chain");
        }
        const followUpInitial: ChatMessage[] = [];
        const followUp = buildSession(templateMode, {
          workspacePath: creatorWorkspace,
          completionTools: AGENT_TOOL_SCHEMAS,
          hostIntakeToolHandler: sharedIntakeHandler,
          sessionPersistence: followUpPersistence,
          initialConversation: followUpInitial,
          latestUserTextForLocale: req.prompt
        });
        const postIntakeUserPrompt = buildPostIntakeCreatorUserPrompt(req.prompt, { forceBuildAfterIntake: true });
        const routed = buildRoutedPrompt({
          prompt: postIntakeUserPrompt,
          templateMode,
          projectType: intakeState.projectType,
          widgetSize: intakeState.widgetSize,
          workspacePath: creatorWorkspace
        });
        terminalAgentLifecycleLog("[agent] runPrompt chained creator", { templateMode });
        await followUp.runPrompt(routed, emitAgent, runAbort.signal);
      }
    } else {
      const intent = req.agentSession?.intent ?? "auto";
      const persistence = buildWorkspaceSessionPersistence(workspaceRoot);
      if (intent === "fresh" && persistence) {
        persistence.archiveOrResetSession("renderer-fresh");
      }
      const initialConversation =
        persistence && intent !== "fresh" ? persistence.readConversation() : [];
      const session = buildSession(req.templateMode, {
        completionTools: AGENT_TOOL_SCHEMAS,
        hostIntakeToolHandler: sharedIntakeHandler,
        sessionPersistence: persistence,
        initialConversation,
        latestUserTextForLocale: req.prompt
      });
      const prompt = buildRoutedPrompt(req);
      terminalAgentLifecycleLog("[agent] runPrompt start", { promptChars: prompt.length });
      await session.runPrompt(prompt, emitAgent, runAbort.signal);
    }

    if (!firstRunComplete) {
      writeProofState(true);
    }
    return { ok: true, sessionRouting };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown prompt error";
    if (message !== AGENT_STOPPED_MESSAGE) {
      const event: AgentEvent = { type: "error", message, at: Date.now() };
      logAgentEventToConsole(event, true);
      sendToRenderer(IPCChannels.subscribeEvents, event);
    }
    return { ok: false };
  } finally {
    emitAgentSink.flush();
    cancelAllIntakeUserInputPending();
    agentEventEmitter = null;
    if (sendPromptAbortController === runAbort) {
      sendPromptAbortController = null;
    }
  }
});

ipcMain.handle(IPCChannels.cancelAgent, () => {
  cancelAllIntakeUserInputPending();
  sendPromptAbortController?.abort();
  return { ok: true };
});

ipcMain.handle(EMULATOR_IPC_CHANNELS.emulatorCommand, async (_event, command: EmulatorCommand) => {
  if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
    startPythonBridge();
  }
  if (bridgeProcess?.stdin && !bridgeProcess.stdin.destroyed) {
    let commandToSend = command;
    if (command.type === "set_path") {
      const baseRoot = getEmulatorWorkspaceRoot();
      const rawPath = (typeof command.path === "string" ? command.path : "").trim().replace(/^["']|["']$/g, "");
      let selectedPath = path.isAbsolute(rawPath) ? rawPath : path.join(baseRoot, rawPath);
      selectedPath = path.resolve(path.normalize(selectedPath));
      if (workspaceRoot && !isWithinDirectory(workspaceRoot, selectedPath)) {
        selectedPath = workspaceRoot;
      }
      commandToSend = { type: "set_path", path: selectedPath };
      lastWidgetDir = selectedPath;
      writeEmulatorState();
    }
    if (commandToSend.type === "reload_widget") {
      clearEmulatorLogsForReload();
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
