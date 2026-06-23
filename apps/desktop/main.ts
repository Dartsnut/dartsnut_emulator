import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import dotenv from "dotenv";
import { spawn, spawnSync } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from "electron";
import type { MessageBoxOptions, OpenDialogOptions } from "electron";
import { createAgentEventBatcher, type AgentEventBatcher } from "./agentEventBatcher";
import { devLog, isDevLoggingEnabled } from "./devOnlyLog";
import { createPublishTarball } from "./publishPackage";
import { buildPythonScriptLaunch, pythonRuntimeDir, runtimeDir, uvBinaryPath, venvPythonPath } from "./pythonRuntime";
import { ensureRuntime, type DownloadProgress } from "./pythonRuntimeDownloader";
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
  type ProjectType,
  type PromptRequest,
  type ProviderId,
  type ProviderSettings,
  type PythonRuntimeProgress,
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
  type CommunitySessionInfo,
  type CommunityLoginRequest,
  type CommunityLoginResponse,
  type CommunityLogoutResponse,
  type CommunityListDeployDevicesResponse,
  type CommunityListMyGamesResponse,
  type CommunityGetPublishOptionsResponse,
  type CommunityCreateAppRequest,
  type CommunityCreateAppResponse,
  type CommunityUploadNativeImageRequest,
  type CommunityUploadNativeImageResponse,
  type CommunitySubmitAppVersionRequest,
  type CommunitySubmitAppVersionResponse,
  type CommunityWithdrawAppVersionRequest,
  type CommunityWithdrawAppVersionResponse,
  type CommunityAppSummary,
  type CommunityVersionSummary,
  type CommunityWorkspaceDefaults,
  type AgentSessionWorkspaceSummary,
  resolveSessionUserLocale,
  type UserLocale,
  buildCreationIntakeUserPrompt,
  parseWidgetFontCatalogFromManifest,
  type WidgetFontCatalogEntry
} from "@dartsnut/shared-ipc";
import {
  loadProviderConfig,
  validateProviderConfig,
  configureAgentsSdk,
  buildAgentModelConfig,
  SessionEngine,
  AgentSessionRuntime,
  WorkspacePolicy,
  bundleForTemplateMode,
  resolveSkillRouterPrompt,
  allowedDeferredSkillIdsForMode,
  AGENT_TOOL_SCHEMAS,
  AgentSessionPersistence,
  isAgentSessionPersistenceDisabledByEnv,
  AGENT_STOPPED_MESSAGE,
  executeIntakeHostTool,
  nextAfterProjectType,
  parseConfWidgetSize,
  precheckAskQuestion,
  isIntakeStateReady,
  type IntakeToolState,
  type ChatMessage
} from "@dartsnut/agent-runtime";
import { formatAgentEventForConsole } from "./agentEventConsole";
import { PACKAGED_ENV } from "./packagedEnv.generated";
import {
  ensureRuntimeDartsnutLlmConfig,
  primeRuntimeDartsnutLlmConfig,
  readCachedRuntimeDartsnutLlmConfig
} from "./dartsnutLlmConfig";
import {
  EMULATOR_IPC_CHANNELS,
  type EmulatorCommand,
  type EmulatorFrame,
  type EmulatorLogEntry,
  type EmulatorStateSnapshot,
} from "@dartsnut/emulator-protocol";
import { AssetManager } from "./assetManager";
import { DeployMachineSession } from "./deployMachine";
import { createCommunityClient, type CommunityClient } from "./communityClient";
import { clearCommunityAuth, readCommunityAuth, writeCommunityAuth } from "./communityAuth";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  normalizeWindowBounds,
  type PersistedWindowState
} from "./windowState";
import {
  decideBeforeQuitBridgeAction,
  shouldAllocateTempWorkspaceAfterDiscard,
  type TempWorkspaceGuardReason
} from "./quitFlow";

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
/** Launch config key for the current bridge (restart bridge when this changes). */
let bridgeRuntimeKey: string | null = null;
/** True after graceful bridge teardown so quit does not orphan pygame/SDL audio. */
let emulatorBridgeTeardownDone = false;
let emulatorBridgeTeardownInFlight: Promise<void> | null = null;

// Ensure consistent app name for getPath('userData') in both dev and packaged modes
if (!app.isPackaged) {
  app.setName("DartsnutAgent-Dev");
}

// Bypass system proxy/VPN for localhost in development to prevent SSL interception
// of the Vite dev server connection by tools like Surge Enhanced Mode
if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1,localhost');
}

const repoRoot = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, "../../..");
process.env.DARTSNUT_REPO_ROOT = repoRoot;
process.env.DARTSNUT_ALLOW_RESOURCES_ENV_FILE = app.isPackaged ? "0" : "1";
const repoEnvPath = path.join(repoRoot, ".env");
if (app.isPackaged) {
  for (const [key, value] of Object.entries(PACKAGED_ENV)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} else if (fs.existsSync(repoEnvPath)) {
  dotenv.config({ path: repoEnvPath });
}
void primeRuntimeDartsnutLlmConfig()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    devLog.warn(`[provider] Dartsnut LLM config load failed: ${message}`);
  })
  .finally(() => {
    emitBootstrapStateToRenderer();
  });
let pythonExec: string | null = null;
let pythonRuntimeStatus: string | null = null;
let pythonRuntimeProgress: PythonRuntimeProgress = {
  running: false,
  stage: null,
  percent: 0,
  message: null
};

let lastWidgetDir: string | null = null;
const assetPreprocessScriptRelativePath = "scripts/asset_preprocess.py";
const assetManager = new AssetManager({
  launchScript: (scriptPath, scriptArgs) =>
    buildPythonScriptLaunch({
      pythonPath: pythonExec!,
      scriptPath,
      scriptArgs,
    }),
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

function isLikelyMacLocalNetworkPermissionFailure(message: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("handshake") ||
    normalized.includes("connection lost before handshake") ||
    normalized.includes("ehostunreach") ||
    normalized.includes("enetwork") ||
    normalized.includes("econnrefused") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket") ||
    normalized.includes("permission")
  );
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

function readCommunityWorkspaceDefaults(): CommunityWorkspaceDefaults {
  const elig = readDeployEligibilityFromWorkspace();
  const fallback = {
    eligible: false,
    appId: "",
    projectType: null,
    appName: "",
    version: "",
    description: "",
    widgetSize: ""
  };
  if (!workspaceRoot || !elig.ok) {
    return fallback;
  }
  const confPath = path.join(workspaceRoot, "conf.json");
  try {
    const conf = JSON.parse(fs.readFileSync(confPath, "utf-8")) as Record<string, unknown>;
    return {
      eligible: elig.projectType === "game" || elig.projectType === "widget",
      appId: elig.appId,
      projectType: elig.projectType,
      appName: String(conf.name || elig.appId).trim(),
      version: String(conf.version || "1.0.0").trim(),
      description: String(conf.description || "").trim(),
      widgetSize: String(conf.size || "").trim()
    };
  } catch {
    return { ...fallback, appId: elig.appId, projectType: elig.projectType };
  }
}

function fileBlobFromPath(filePath: string, mimeType = "application/octet-stream"): Blob {
  return new Blob([fs.readFileSync(filePath)], { type: mimeType });
}

function authRequiredResponse(code: string, message: string): { ok: false; code: string; message: string; authRequired?: boolean } {
  return { ok: false, code, message, authRequired: code === "session_expired" };
}

function clearAuthIfExpired(code: string): void {
  if (code === "session_expired") {
    clearCommunityAuth(getCommunityUserDataPath());
  }
}

function hasResolvableCommunityAppSystemId(id: number | string): boolean {
  if (typeof id === "number") {
    return Number.isFinite(id) && id > 0;
  }
  const parsed = Number(String(id).trim());
  return Number.isFinite(parsed) && parsed > 0;
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

/** Agent tool `check_python`: `python -m py_compile` syntax check (no execution) on workspace files. */
function executeHostCheckPythonForAgent(args?: { paths?: string[] }): string {
  if (!workspaceRoot) {
    return JSON.stringify({ ok: false, error: "No workspace is selected." });
  }
  if (!pythonExec) {
    return JSON.stringify({ ok: false, error: "Python runtime is not ready yet." });
  }
  const requested =
    Array.isArray(args?.paths) && args!.paths!.length > 0
      ? args!.paths!.filter((p) => typeof p === "string" && p.trim().length > 0)
      : ["main.py"];
  const baseRoot = getEmulatorWorkspaceRoot();
  const absPaths: string[] = [];
  for (const rel of requested) {
    const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
    if (!isWithinDirectory(workspaceRoot, abs)) {
      return JSON.stringify({ ok: false, error: `Path escapes workspace: ${rel}` });
    }
    if (!fs.existsSync(abs)) {
      return JSON.stringify({ ok: false, error: `File not found: ${rel}` });
    }
    absPaths.push(abs);
  }
  const launch = buildPythonScriptLaunch({
    pythonPath: pythonExec,
    scriptPath: "-m",
    scriptArgs: ["py_compile", ...absPaths]
  });
  const result = spawnSync(launch.command, launch.args, {
    cwd: baseRoot,
    env: launch.env,
    encoding: "utf-8",
    timeout: 30_000
  });
  const errorText = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
  if (result.status === 0) {
    return JSON.stringify({ ok: true, errors: [], checked: requested });
  }
  return JSON.stringify({
    ok: false,
    errors: errorText ? [errorText] : ["py_compile failed"],
    checked: requested,
    hint: "Fix the SyntaxError above, then re-run check_python."
  });
}

const emulatorState: EmulatorStateSnapshot = {
  widgetPath: null,
  running: false,
  fps: 0,
  status: "Idle",
  lastCapturePath: null,
};

const proofStatePath = () => path.join(app.getPath("userData"), "first-run-proof.json");
const tempWorkspaceRecordPath = () => path.join(app.getPath("userData"), "temp-workspace.json");
const emulatorStatePath = () => path.join(app.getPath("userData"), "emulator-state.json");
const providerSettingsPath = () => path.join(app.getPath("userData"), "provider-settings.json");
const windowStatePath = () => path.join(app.getPath("userData"), "window-state.json");

function readWindowState(): PersistedWindowState | null {
  const file = windowStatePath();
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<PersistedWindowState>;
    const bounds = normalizeWindowBounds(content, screen.getAllDisplays());
    if (!bounds) {
      return null;
    }
    return {
      ...bounds,
      isMaximized: Boolean(content.isMaximized),
      isFullScreen: Boolean(content.isFullScreen)
    };
  } catch {
    return null;
  }
}

function captureWindowState(window: BrowserWindow): PersistedWindowState {
  const bounds = window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds();
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height)),
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen() || window.isSimpleFullScreen()
  };
}

function writeWindowState(state: PersistedWindowState): void {
  const normalizedBounds = normalizeWindowBounds(state, screen.getAllDisplays());
  if (!normalizedBounds) {
    return;
  }
  fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
  fs.writeFileSync(
    windowStatePath(),
    JSON.stringify(
      {
        ...normalizedBounds,
        isMaximized: state.isMaximized,
        isFullScreen: state.isFullScreen
      },
      null,
      2
    )
  );
}

function normalizeUserDefineSettings(input?: Partial<UserDefineProviderSettings> | null): UserDefineProviderSettings {
  return {
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : ""
  };
}

type LegacyProviderSettingsFile = Omit<Partial<ProviderSettings>, "activeProvider" | "custom"> & {
  activeProvider?: string;
  custom?: Partial<UserDefineProviderSettings>;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function normalizeProviderId(value: unknown): ProviderId {
  return value === "custom" ? "custom" : "dartsnut-llm";
}

function providerSettingsForDisk(settings: ProviderSettings): Omit<ProviderSettings, "userDefine"> {
  return {
    activeProvider: settings.activeProvider,
    custom: settings.custom
  };
}

function persistProviderSettings(settings: ProviderSettings): void {
  fs.mkdirSync(path.dirname(providerSettingsPath()), { recursive: true });
  fs.writeFileSync(providerSettingsPath(), JSON.stringify(providerSettingsForDisk(settings), null, 2));
}

function sameProviderSettings(a: UserDefineProviderSettings, b: UserDefineProviderSettings): boolean {
  return a.baseUrl === b.baseUrl && a.apiKey === b.apiKey && a.model === b.model;
}

function normalizeProviderSettings(input?: LegacyProviderSettingsFile | null): ProviderSettings {
  const legacyFlat =
    input != null &&
    (typeof input.baseUrl === "string" ||
      typeof input.apiKey === "string" ||
      typeof input.model === "string") &&
    input.userDefine == null;

  if (legacyFlat) {
    const custom = normalizeUserDefineSettings({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model
    });
    return {
      activeProvider: "custom",
      custom,
      userDefine: custom
    };
  }

  const legacyUserDefine = normalizeUserDefineSettings(input?.userDefine);
  const customSource = input?.custom ?? input?.userDefine;
  let custom = normalizeUserDefineSettings(customSource);
  const builtin = normalizeUserDefineSettings(readCachedRuntimeDartsnutLlmConfig());
  if (custom.apiKey && sameProviderSettings(custom, builtin)) {
    custom = normalizeUserDefineSettings();
  }
  const activeProvider =
    input == null
      ? "dartsnut-llm"
      : input.activeProvider === "user-define"
        ? "custom"
        : normalizeProviderId(input.activeProvider);
  const legacyBuiltinProvider =
    input != null &&
    typeof input.activeProvider === "string" &&
    input.activeProvider !== "user-define" &&
    input.custom == null &&
    !legacyUserDefine.apiKey &&
    !legacyUserDefine.model &&
    !legacyUserDefine.baseUrl;
  if (legacyBuiltinProvider) {
    const envCustom = normalizeUserDefineSettings();
    return {
      activeProvider: "dartsnut-llm",
      custom: envCustom,
      userDefine: envCustom
    };
  }
  return {
    activeProvider,
    custom,
    userDefine: custom
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
    const hadLegacyShape =
      content.activeProvider === "user-define" ||
      (typeof content.activeProvider === "string" &&
        content.activeProvider !== "dartsnut-llm" &&
        content.activeProvider !== "custom") ||
      (content.userDefine == null &&
        (typeof content.baseUrl === "string" ||
          typeof content.apiKey === "string" ||
          typeof content.model === "string")) ||
      content.userDefine != null;
    if (hadLegacyShape) {
      persistProviderSettings(normalized);
    }
    return normalized;
  } catch {
    return normalizeProviderSettings();
  }
}

async function validateProviderSettingsInput(input: SaveProviderSettingsRequest): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = normalizeProviderSettings(input);
  let ud: UserDefineProviderSettings;
  if (normalized.activeProvider === "dartsnut-llm") {
    try {
      ud = await ensureRuntimeDartsnutLlmConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Dartsnut LLM configuration could not be loaded. ${message}` };
    }
  } else {
    ud = normalized.custom;
  }
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

async function writeProviderSettings(input: SaveProviderSettingsRequest): Promise<ProviderSettings> {
  const validation = await validateProviderSettingsInput(input);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const normalized = normalizeProviderSettings(input);
  persistProviderSettings(normalized);
  return normalized;
}

async function resolveProviderConfigForDesktop(providerSettings: ProviderSettings) {
  if (providerSettings.activeProvider === "dartsnut-llm") {
    try {
      return await ensureRuntimeDartsnutLlmConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Dartsnut LLM configuration could not be loaded. ${message}`);
    }
  }
  return loadProviderConfig({ providerSettings });
}

function resolveCachedProviderConfigForDesktop(providerSettings: ProviderSettings) {
  if (providerSettings.activeProvider === "dartsnut-llm") {
    const config = readCachedRuntimeDartsnutLlmConfig();
    if (!config) {
      return null;
    }
    return config;
  }
  return loadProviderConfig({ providerSettings });
}

async function buildAgentModelConfigFromProviderSettings(providerSettings: ProviderSettings) {
  const config = await resolveProviderConfigForDesktop(providerSettings);
  return buildAgentModelConfig({
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey
  });
}

async function reconfigureAgentsSdkFromProviderSettings(providerSettings: ProviderSettings): Promise<void> {
  configureAgentsSdk(await buildAgentModelConfigFromProviderSettings(providerSettings), { force: true });
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

function removeDirectoryDeferredOnQuit(dir: string): void {
  try {
    if (process.platform === "win32") {
      const escaped = dir.replace(/"/g, "\"\"");
      const child = spawn("cmd.exe", ["/d", "/s", "/c", `rmdir /s /q "${escaped}"`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return;
    }
    const child = spawn("/bin/rm", ["-rf", "--", dir], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Fall back to best-effort sync removal if detached cleanup cannot be started.
    removeDirectoryBestEffort(dir);
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gracefulStopEmulatorBridge(
  timeoutMs = 3000,
  options?: { permanent?: boolean }
): Promise<void> {
  if (emulatorBridgeTeardownDone) {
    return;
  }
  const proc = bridgeProcess;
  if (!proc) {
    if (options?.permanent) {
      emulatorBridgeTeardownDone = true;
    }
    return;
  }

  try {
    if (proc.stdin && !proc.stdin.destroyed) {
      proc.stdin.write(`${JSON.stringify({ command: { type: "stop_widget" } })}\n`);
      proc.stdin.write(`${JSON.stringify({ command: { type: "shutdown" } })}\n`);
    }
  } catch {
    /* bridge stdin may already be closed */
  }

  await new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (proc.exitCode === null) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await sleepMs(400);
    if (proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  bridgeProcess = null;
  bridgeRuntimeKey = null;
  emulatorState.running = false;
  emulatorState.status = "Bridge stopped";
  if (options?.permanent) {
    emulatorBridgeTeardownDone = true;
  }
}

function stopPythonBridgeProcess(): void {
  if (emulatorBridgeTeardownDone || !bridgeProcess) {
    return;
  }
  try {
    bridgeProcess.kill();
  } catch {
    /* ignore */
  }
  bridgeProcess = null;
  bridgeRuntimeKey = null;
  emulatorBridgeTeardownDone = true;
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
    clearSessionStateForQuitDiscard(toRemove);
    return;
  }
  if (workspaceRoot && path.resolve(workspaceRoot) === toRemove) {
    performSessionCleanup({ clearWorkspace: true });
  } else {
    writeTempWorkspaceRecordToDisk(null);
  }
  removeDirectoryBestEffort(toRemove);
  if (shouldAllocateTempWorkspaceAfterDiscard(reason)) {
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
  if (isDirectoryEmpty(tp)) {
    const resolved = path.resolve(tp);
    writeTempWorkspaceRecordToDisk(resolved);
    applyWorkspaceRoot(resolved);
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
  const config = resolveCachedProviderConfigForDesktop(stored);
  if (!config) {
    return "missing_config";
  }
  const validation = validateProviderConfig(config);
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

type CreatorTemplateMode = "game-creator" | "widget-creator";

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
  state: IntakeToolState,
  lastUserPrompt?: string
): Promise<string> {
  const root = workspaceRoot;
  if (!root) {
    return JSON.stringify({ ok: false, error: "No workspace is active." });
  }
  return executeIntakeHostTool(args, state, root, { lastUserPrompt });
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

function buildRoutedPrompt(request: PromptRequest, intakeState?: IntakeToolState): string {
  if (request.templateMode === "asset-applier") {
    return buildAssetApplierPrompt(request);
  }

  const effectiveWorkspacePath =
    typeof request.workspacePath === "string" && request.workspacePath
      ? request.workspacePath
      : workspaceRoot;
  const confPath =
    effectiveWorkspacePath && effectiveWorkspacePath.length > 0
      ? path.join(effectiveWorkspacePath, "conf.json")
      : "";
  const confJsonExists = confPath.length > 0 && fs.existsSync(confPath);
  const intakeReady = intakeState != null && isIntakeStateReady(intakeState);
  const needsCreationIntake =
    Boolean(effectiveWorkspacePath) &&
    effectiveWorkspacePath!.length > 0 &&
    !confJsonExists &&
    !intakeReady;

  if (needsCreationIntake) {
    return buildCreationIntakeUserPrompt(request.prompt, {
      projectTypeFromPicker:
        request.projectType === "game" || request.projectType === "widget"
          ? request.projectType
          : undefined,
      widgetSizeFromPicker: request.widgetSize
    });
  }

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
  const resolvedProjectType: ProjectType =
    projectType === "game" || projectType === "widget" ? projectType : templateMode === "widget-creator" ? "widget" : "game";
  return [
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

function clearSessionStateForQuitDiscard(toRemove: string): void {
  // During quit, avoid renderer reset churn to prevent visible timeline flicker.
  if (workspaceRoot && path.resolve(workspaceRoot) === toRemove) {
    workspaceRoot = null;
  }
  assetManager.stop();
  stopDeployConfWatcher();
  lastWidgetDir = null;
  writeTempWorkspaceRecordToDisk(null);
  writeEmulatorState();
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

function emitPythonRuntimeProgress() {
  sendToRenderer(IPCChannels.subscribePythonRuntimeProgress, pythonRuntimeProgress);
}

function setPythonRuntimeStatus(status: string | null) {
  pythonRuntimeStatus = status;
  emitPythonRuntimeStatus();
}

function setPythonRuntimeProgress(progress: PythonRuntimeProgress) {
  pythonRuntimeProgress = progress;
  emitPythonRuntimeProgress();
}

function setPythonRuntimeProgressFromDownload(progress: DownloadProgress) {
  setPythonRuntimeProgress({
    running: progress.stage !== "complete",
    stage: progress.stage,
    percent: progress.percent,
    message: progress.message
  });
}

function startPythonBridge() {
  if (pythonRuntimeStatus !== null) {
    emulatorState.status = pythonRuntimeStatus;
    emulatorState.running = false;
    emitEmulatorState();
    return;
  }
  const bridgeLaunch = buildPythonScriptLaunch({
    pythonPath: pythonExec!,
    scriptPath: path.join(repoRoot, "services", "emulator-core", "bridge_service.py"),
  });
  if (bridgeProcess && bridgeRuntimeKey === bridgeLaunch.runtimeKey) {
    return;
  }
  void gracefulStopEmulatorBridge().then(() => {
    if (emulatorBridgeTeardownDone || bridgeProcess) {
      return;
    }
    spawnBridgeAfterStop();
  });
}

function spawnBridgeAfterStop() {
  if (emulatorBridgeTeardownDone) {
    return;
  }
  const bridgePath = path.join(repoRoot, "services", "emulator-core", "bridge_service.py");
  const launch = buildPythonScriptLaunch({
    pythonPath: pythonExec!,
    scriptPath: bridgePath,
  });
  bridgeProcess = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repoRoot,
    env: launch.env,
  });
  bridgeRuntimeKey = launch.runtimeKey;
  emulatorState.status = `Bridge starting with ${launch.label}`;
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
        if (typeof payload.lastCapturePath !== "undefined") {
          emulatorState.lastCapturePath = payload.lastCapturePath ?? null;
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
    bridgeRuntimeKey = null;
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

async function buildSession(
  templateMode: PromptRequest["templateMode"] | undefined,
  extras?: {
    workspacePath?: string;
    completionTools?: typeof AGENT_TOOL_SCHEMAS;
    hostIntakeToolHandler?: (args: Record<string, unknown>) => Promise<string>;
    hostAskQuestionHandler?: (args: Record<string, unknown>) => Promise<string>;
    hostIntakeReadyToFinish?: () => boolean;
    skipInitialWorkspaceResolve?: boolean;
    skillBundleMode?: PromptRequest["templateMode"] | "creation-intake" | null;
    sessionPersistence?: AgentSessionPersistence;
    initialConversation?: ChatMessage[];
    preferredUserLocale?: UserLocale | null;
    latestUserTextForLocale?: string;
    intakeState?: IntakeToolState;
    getIntakeState?: () => IntakeToolState;
    projectType?: ProjectType;
    widgetSize?: WidgetSize;
    assetApplierMode?: boolean;
  }
): Promise<AgentSessionRuntime> {
  const workspacePath = extras?.workspacePath ?? workspaceRoot;
  if (!workspacePath) {
    throw new Error("Workspace is not selected.");
  }
  const providerSettings = readProviderSettings();
  const config = await resolveProviderConfigForDesktop(providerSettings);
  const validation = validateProviderConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const skillBundleMode =
    extras?.skillBundleMode !== undefined ? extras.skillBundleMode : templateMode ?? null;
  const { skillPrompt, skillLibrary } = resolveSkillSessionContext(skillBundleMode);
  const preferredUserLocale =
    extras?.preferredUserLocale ??
    (extras?.latestUserTextForLocale != null
      ? resolvePreferredUserLocaleForSession(extras.latestUserTextForLocale, extras.sessionPersistence)
      : null);
  const engine = new SessionEngine({
    agentModelConfig: buildAgentModelConfig({
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey
    }),
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
    hostReloadEmulatorHandler: () => executeHostReloadEmulatorForAgent(),
    hostGetEmulatorLogsHandler: (args) => Promise.resolve(executeHostGetEmulatorLogsForAgent(args)),
    hostCheckPythonHandler: (args) => Promise.resolve(executeHostCheckPythonForAgent(args)),
    skipInitialWorkspaceResolve: extras?.skipInitialWorkspaceResolve,
    sessionPersistence: extras?.sessionPersistence,
    initialConversation: extras?.initialConversation,
    sessionTemplateMode: templateMode ?? null,
    sessionSection: skillBundleMode === null ? null : String(skillBundleMode),
    runContextSeed: {
      skillsDir: resolveAgentRuntimeSkillsDir(),
      projectType: extras?.projectType,
      widgetSize: extras?.widgetSize,
      templateMode: templateMode ?? skillBundleMode ?? null,
      assetApplierMode: extras?.assetApplierMode ?? templateMode === "asset-applier",
      intakeState: extras?.intakeState,
      originalUserPrompt: extras?.latestUserTextForLocale
    },
    getIntakeState: extras?.getIntakeState
  });
  return new AgentSessionRuntime({
    workspacePath,
    engine
  });
}

async function createWindow() {
  readProofState();
  readEmulatorState();
  const restoredWindowState = readWindowState();
  const restoredBounds = restoredWindowState
    ? {
      x: restoredWindowState.x,
      y: restoredWindowState.y,
      width: restoredWindowState.width,
      height: restoredWindowState.height
    }
    : {
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT
    };
  win = new BrowserWindow({
    ...restoredBounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
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
  if (restoredWindowState?.isMaximized) {
    win.maximize();
  }
  if (restoredWindowState?.isFullScreen) {
    win.setFullScreen(true);
  }
  const persistWindowState = () => {
    if (!win || win.isDestroyed()) {
      return;
    }
    writeWindowState(captureWindowState(win));
  };
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
    devLog.info("[quit] win.close fired", {
      t: Date.now(),
      allowWithoutPrompt: allowWindowCloseWithoutTempPrompt,
      isTempWorkspace: isTemporaryWorkspaceActiveNow(),
      appQuitRequested,
    });
    persistWindowState();
    if (allowWindowCloseWithoutTempPrompt || !isTemporaryWorkspaceActiveNow()) {
      allowWindowCloseWithoutTempPrompt = false;
      devLog.info("[quit] win.close → allowing close immediately");
      return;
    }
    event.preventDefault();
    devLog.info("[quit] win.close → prevented; running temp-workspace guard");
    // `close` can run before `before-quit` on macOS; mark quit intent now so one Cmd+Q finishes after the guard.
    appQuitRequested = true;
    void (async () => {
      const proceed = await ensureTemporaryWorkspaceResolvedForGuard("quit");
      devLog.info("[quit] win.close → guard resolved", { proceed });
      if (!proceed) {
        appQuitRequested = false;
        return;
      }
      allowWindowCloseWithoutTempPrompt = true;
      // Resume the original quit request immediately after the guard succeeds.
      app.quit();
    })();
  });
  win.on("closed", () => {
    devLog.info("[quit] win.closed fired", { t: Date.now() });
    allowWindowCloseWithoutTempPrompt = false;
    chromeInsetInsertedCssKey = undefined;
    win = null;
  });
  win.on("move", persistWindowState);
  win.on("resize", persistWindowState);
  win.on("maximize", persistWindowState);
  win.on("unmaximize", persistWindowState);
  win.on("enter-full-screen", persistWindowState);
  win.on("leave-full-screen", persistWindowState);
  win.on("resize", emitChromeInsetsAndPushStyles);
  win.on("maximize", emitChromeInsetsAndPushStyles);
  win.on("unmaximize", emitChromeInsetsAndPushStyles);
  win.on("enter-full-screen", emitChromeInsetsAndPushStyles);
  win.on("leave-full-screen", emitChromeInsetsAndPushStyles);
  emitEmulatorState();
}

app.whenReady().then(async () => {
  try {
    await createWindow();
    setPythonRuntimeProgress({
      running: true,
      stage: "check",
      percent: 0,
      message: "Checking runtime..."
    });
    devLog.info("[runtime] Starting runtime initialization");
    const runtime = await ensureRuntime(
      runtimeDir(),
      path.join(repoRoot, "requirements.txt"),
      (progress) => {
        setPythonRuntimeProgressFromDownload(progress);
        devLog.info("[runtime] Progress", { stage: progress.stage, percent: progress.percent });
      }
    );

    pythonExec = runtime.pythonPath;
    devLog.info("[runtime] Runtime ready", { pythonPath: pythonExec, uvPath: runtime.uvPath });

    setPythonRuntimeStatus(null);
    setPythonRuntimeProgress({
      running: false,
      stage: "complete",
      percent: 100,
      message: "Runtime ready"
    });

    // Workspace recovery dialogs now have the main window as a proper parent.
    await maybeRecoverTrackedTempWorkspaceAtLaunch();
    ensureTemporaryWorkspaceRootAllocated();
    startPythonBridge();
    emitBootstrapStateToRenderer();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setPythonRuntimeStatus(errorMessage);
    setPythonRuntimeProgress({
      running: false,
      stage: "error",
      percent: 100,
      message: "Runtime initialization failed",
      error: errorMessage
    });
    devLog.error("[runtime] Initialization failed", errorMessage);
    dialog.showErrorBox(
      "Runtime Initialization Failed",
      `Failed to set up Python runtime: ${errorMessage}\n\nTry clearing app data or reinstalling the application.`
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  appQuitRequested = true;
  const winState = win && !win.isDestroyed()
    ? { visible: win.isVisible(), isTempWorkspace: isTemporaryWorkspaceActiveNow() }
    : { visible: false, isTempWorkspace: isTemporaryWorkspaceActiveNow() };
  devLog.info("[quit] before-quit fired", { t: Date.now(), ...winState });
  // Hide immediately so quit feels responsive. Only keep the window visible if the
  // temp-workspace guard will actually need to show a save/discard dialog — i.e. the
  // workspace exists and is non-empty. An empty workspace auto-discards without any
  // dialog (mirrors the condition in ensureTemporaryWorkspaceResolvedForGuard).
  const needsTempWorkspaceDialog = isTemporaryWorkspaceActiveNow() && !(
    workspaceRoot != null &&
    fs.existsSync(workspaceRoot) &&
    fs.statSync(workspaceRoot).isDirectory() &&
    isDirectoryEmpty(workspaceRoot)
  );
  if (win && !win.isDestroyed() && win.isVisible() && !needsTempWorkspaceDialog) {
    devLog.info("[quit] before-quit → hiding window now", { needsTempWorkspaceDialog });
    win.hide();
  } else {
    devLog.info("[quit] before-quit → skipping hide", {
      winNull: !win,
      destroyed: win ? win.isDestroyed() : true,
      visible: win && !win.isDestroyed() ? win.isVisible() : false,
      needsTempWorkspaceDialog,
    });
  }
  const action = decideBeforeQuitBridgeAction({
    teardownDone: emulatorBridgeTeardownDone,
    hasBridgeProcess: !!bridgeProcess,
    teardownInFlight: !!emulatorBridgeTeardownInFlight
  });
  devLog.info("[quit] before-quit → bridge action", { action });
  if (action === "proceed") {
    return;
  }
  if (action === "mark_teardown_done") {
    emulatorBridgeTeardownDone = true;
    return;
  }
  event.preventDefault();
  devLog.info("[quit] before-quit → prevented; starting bridge teardown");
  if (action === "wait_for_inflight_teardown") {
    return;
  }
  emulatorBridgeTeardownInFlight = gracefulStopEmulatorBridge(3000, { permanent: true })
    .catch(() => undefined)
    .finally(() => {
      devLog.info("[quit] before-quit → bridge teardown complete, re-quitting", { t: Date.now() });
      emulatorBridgeTeardownInFlight = null;
      app.quit();
    });
});

app.on("will-quit", () => {
  devLog.info("[quit] will-quit fired", { t: Date.now() });
  stopPythonBridgeProcess();
  assetManager.stop();
  void disconnectDeployMachine();
  const pending = pendingTempDirRemovalOnQuit;
  pendingTempDirRemovalOnQuit = null;
  if (pending) {
    removeDirectoryDeferredOnQuit(pending);
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

let communityClientSingleton: CommunityClient | null = null;

function getCommunityClient(): CommunityClient {
  if (!communityClientSingleton) {
    communityClientSingleton = createCommunityClient();
  }
  return communityClientSingleton;
}

function getCommunityUserDataPath(): string {
  return app.getPath("userData");
}

ipcMain.handle(IPCChannels.communityGetSession, (): CommunitySessionInfo => {
  const config = getCommunityClient().getConfig();
  const auth = readCommunityAuth(getCommunityUserDataPath());
  return {
    loggedIn: Boolean(auth?.token),
    account: auth?.account ?? null,
    hasSupabase: config.hasSupabase,
    googleClientId: config.googleClientId
  };
});

ipcMain.handle(
  IPCChannels.communityLogin,
  async (_event: unknown, request: CommunityLoginRequest): Promise<CommunityLoginResponse> => {
    const client = getCommunityClient();
    if (request.method === "password") {
      const account = String(request.account || "").trim();
      const password = String(request.password || "");
      if (!account || !password) {
        return { ok: false, code: "invalid_credentials", message: "Please enter account and password." };
      }
      const result = await client.loginWithPassword(account, password);
      if (!result.ok) {
        return { ok: false, code: result.code, message: result.message };
      }
      writeCommunityAuth(getCommunityUserDataPath(), { token: result.token, account: result.account });
      return { ok: true, account: result.account };
    }
    const idToken = String(request.idToken || "").trim();
    if (!idToken) {
      return { ok: false, code: "invalid_credentials", message: "Google sign-in did not return a token." };
    }
    const result = await client.loginWithGoogleIdToken(idToken);
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }
    writeCommunityAuth(getCommunityUserDataPath(), { token: result.token, account: result.account });
    return { ok: true, account: result.account };
  }
);

ipcMain.handle(IPCChannels.communityLogout, (): CommunityLogoutResponse => {
  clearCommunityAuth(getCommunityUserDataPath());
  return { ok: true };
});

ipcMain.handle(
  IPCChannels.communityListDeployDevices,
  async (): Promise<CommunityListDeployDevicesResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const result = await getCommunityClient().listDeployDevices(auth.token);
    if (!result.ok) {
      if (result.code === "session_expired") {
        clearCommunityAuth(getCommunityUserDataPath());
      }
      return {
        ok: false,
        code: result.code,
        message: result.message,
        authRequired: result.code === "session_expired"
      };
    }
    return {
      ok: true,
      devices: result.devices,
      supabaseConfigured: result.supabaseConfigured
    };
  }
);

ipcMain.handle(
  IPCChannels.communityListMyGames,
  async (): Promise<CommunityListMyGamesResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const result = await getCommunityClient().listMyGames(auth.token);
    if (!result.ok) {
      if (result.code === "session_expired") {
        clearCommunityAuth(getCommunityUserDataPath());
      }
      return {
        ok: false,
        code: result.code,
        message: result.message,
        authRequired: result.code === "session_expired"
      };
    }
    return { ok: true, games: result.games, total: result.total };
  }
);

ipcMain.handle(
  IPCChannels.communityGetPublishOptions,
  async (): Promise<CommunityGetPublishOptionsResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const client = getCommunityClient();
    const [games, widgets, gameCategories, widgetCategories, gameControls, widgetStatus] = await Promise.all([
      client.listMyGames(auth.token),
      client.listMyWidgets(auth.token),
      client.listGameCategories(auth.token),
      client.listWidgetCategories(auth.token),
      client.listGameControls(auth.token),
      client.listWidgetStatusOptions(auth.token)
    ]);
    if (!games.ok) {
      clearAuthIfExpired(games.code);
      return authRequiredResponse(games.code, games.message);
    }
    if (!widgets.ok) {
      clearAuthIfExpired(widgets.code);
      return authRequiredResponse(widgets.code, widgets.message);
    }
    if (!gameCategories.ok) {
      clearAuthIfExpired(gameCategories.code);
      return authRequiredResponse(gameCategories.code, gameCategories.message);
    }
    if (!widgetCategories.ok) {
      clearAuthIfExpired(widgetCategories.code);
      return authRequiredResponse(widgetCategories.code, widgetCategories.message);
    }
    if (!gameControls.ok) {
      clearAuthIfExpired(gameControls.code);
      return authRequiredResponse(gameControls.code, gameControls.message);
    }
    if (!widgetStatus.ok) {
      clearAuthIfExpired(widgetStatus.code);
      return authRequiredResponse(widgetStatus.code, widgetStatus.message);
    }
    const workspace = readCommunityWorkspaceDefaults();
    const normalizedGames: CommunityAppSummary[] = games.games.map((game) => ({
      id: game.id,
      appId: game.gameId,
      appName: game.gameName,
      projectType: "game",
      mainCover: game.mainCover,
      description: game.description,
      status: game.status,
      createdAt: game.createdAt
    }));
    const currentApp = workspace.projectType
      ? [...normalizedGames, ...widgets.widgets].find(
          (appRow) => appRow.projectType === workspace.projectType && appRow.appId === workspace.appId
        ) || null
      : null;
    let currentVersions: CommunityVersionSummary[] = [];
    if (currentApp && hasResolvableCommunityAppSystemId(currentApp.id)) {
      const versions = await client.listAppVersions(auth.token, currentApp.projectType, currentApp.id);
      if (!versions.ok) {
        clearAuthIfExpired(versions.code);
        return authRequiredResponse(versions.code, versions.message);
      }
      currentVersions = versions.versions;
    }
    return {
      ok: true,
      games: normalizedGames,
      widgets: widgets.widgets,
      gameCategories: gameCategories.categories,
      widgetCategories: widgetCategories.categories,
      gameControls: gameControls.controls,
      widgetControls: widgetStatus.controls,
      widgetSizes: widgetStatus.sizes,
      currentVersions,
      workspace
    };
  }
);

ipcMain.handle(
  IPCChannels.communityUploadNativeImage,
  async (_event, request: CommunityUploadNativeImageRequest): Promise<CommunityUploadNativeImageResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const filePath = String(request?.filePath || "").trim();
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return { ok: false, code: "api_error", message: "Image file does not exist." };
    }
    const result = await getCommunityClient().uploadNativeImage(
      auth.token,
      fileBlobFromPath(filePath, "application/octet-stream"),
      path.basename(filePath)
    );
    if (!result.ok) {
      clearAuthIfExpired(result.code);
      return authRequiredResponse(result.code, result.message);
    }
    return { ok: true, url: result.url };
  }
);

ipcMain.handle(
  IPCChannels.communityCreateApp,
  async (_event, request: CommunityCreateAppRequest): Promise<CommunityCreateAppResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const projectType = request?.projectType === "widget" ? "widget" : "game";
    const appId = String(request?.appId || "").trim();
    const client = getCommunityClient();
    let existingApps: CommunityAppSummary[];
    if (projectType === "widget") {
      const existing = await client.listMyWidgets(auth.token);
      if (!existing.ok) {
        clearAuthIfExpired(existing.code);
        return authRequiredResponse(existing.code, existing.message);
      }
      existingApps = existing.widgets;
    } else {
      const existing = await client.listMyGames(auth.token);
      if (!existing.ok) {
        clearAuthIfExpired(existing.code);
        return authRequiredResponse(existing.code, existing.message);
      }
      existingApps = existing.games.map((game) => ({
          id: game.id,
          appId: game.gameId,
          appName: game.gameName,
          projectType: "game" as const,
          mainCover: game.mainCover,
          description: game.description,
          status: game.status,
          createdAt: game.createdAt
        }));
    }
    const found = existingApps.find((appRow) => appRow.appId === appId);
    if (found) {
      if (!hasResolvableCommunityAppSystemId(found.id)) {
        return { ok: false, code: "api_error", message: `Could not resolve backend ${projectType} id for this app.` };
      }
      return { ok: true, app: found };
    }
    const result = await client.createApp(auth.token, request);
    if (!result.ok) {
      clearAuthIfExpired(result.code);
      return authRequiredResponse(result.code, result.message);
    }
    let refreshedApps: CommunityAppSummary[] | null = null;
    if (projectType === "widget") {
      const refreshed = await client.listMyWidgets(auth.token);
      if (refreshed.ok) {
        refreshedApps = refreshed.widgets;
      }
    } else {
      const refreshed = await client.listMyGames(auth.token);
      if (refreshed.ok) {
        refreshedApps = refreshed.games.map((game) => ({
            id: game.id,
            appId: game.gameId,
            appName: game.gameName,
            projectType: "game" as const,
            mainCover: game.mainCover,
            description: game.description,
            status: game.status,
            createdAt: game.createdAt
          }));
      }
    }
    if (refreshedApps) {
      const created = refreshedApps.find((appRow) => appRow.appId === appId);
      if (created) {
        if (!hasResolvableCommunityAppSystemId(created.id)) {
          return { ok: false, code: "api_error", message: `Could not resolve backend ${projectType} id after creating app.` };
        }
        return { ok: true, app: created };
      }
    }
    if (!hasResolvableCommunityAppSystemId(result.app.id)) {
      return { ok: false, code: "api_error", message: `${projectType} app was created, but the backend id was not returned.` };
    }
    return { ok: true, app: result.app };
  }
);

ipcMain.handle(
  IPCChannels.communitySubmitAppVersion,
  async (_event, request: CommunitySubmitAppVersionRequest): Promise<CommunitySubmitAppVersionResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const projectType = request?.projectType === "widget" ? "widget" : "game";
    const elig = readDeployEligibilityFromWorkspace();
    if (!workspaceRoot || !elig.ok || elig.projectType !== projectType) {
      return { ok: false, code: "api_error", message: `Select a valid ${projectType} workspace before submitting.` };
    }
    if (!hasResolvableCommunityAppSystemId(request.appSystemId)) {
      return { ok: false, code: "api_error", message: `Could not resolve backend ${projectType} id for version submission.` };
    }
    const preview = Array.isArray(request?.preview) ? request.preview.map((url) => String(url).trim()).filter(Boolean) : [];
    if (!preview.length) {
      return { ok: false, code: "api_error", message: "Upload at least one preview image before submitting." };
    }
    let tarballPath: string | null = null;
    try {
      tarballPath = await createPublishTarball(workspaceRoot, elig.appId);
      const client = getCommunityClient();
      const packageUpload =
        projectType === "widget"
          ? await client.uploadWidgetZip(auth.token, fileBlobFromPath(tarballPath, "application/gzip"), `${elig.appId}.tar.gz`)
          : await client.uploadGameZip(auth.token, fileBlobFromPath(tarballPath, "application/gzip"), `${elig.appId}.tar.gz`);
      if (!packageUpload.ok) {
        clearAuthIfExpired(packageUpload.code);
        return authRequiredResponse(packageUpload.code, packageUpload.message);
      }
      const submit = await client.submitAppVersion(auth.token, {
        projectType,
        appSystemId: request.appSystemId,
        version: String(request.version || "").trim(),
        description: String(request.description || "").trim(),
        fields: String(request.fields || "").trim(),
        preview,
        downloadUrl: packageUpload.upload.url,
        downloadMd5: packageUpload.upload.md5
      });
      if (!submit.ok) {
        clearAuthIfExpired(submit.code);
        return authRequiredResponse(submit.code, submit.message);
      }
      return {
        ok: true,
        versionId: submit.result.versionId,
        status: submit.result.status,
        downloadUrl: packageUpload.upload.url,
        downloadMd5: packageUpload.upload.md5
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    } finally {
      if (tarballPath) {
        fs.unlink(tarballPath, () => {});
      }
    }
  }
);

ipcMain.handle(
  IPCChannels.communityWithdrawAppVersion,
  async (_event, request: CommunityWithdrawAppVersionRequest): Promise<CommunityWithdrawAppVersionResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const projectType = request?.projectType === "widget" ? "widget" : "game";
    if (!hasResolvableCommunityAppSystemId(request.appSystemId)) {
      return { ok: false, code: "api_error", message: `Could not resolve backend ${projectType} id for this app.` };
    }
    const versionId =
      typeof request.versionId === "number" ? request.versionId : String(request.versionId || "").trim();
    if (!versionId) {
      return { ok: false, code: "api_error", message: "Could not resolve version id for review withdrawal." };
    }
    const result = await getCommunityClient().withdrawAppVersion(auth.token, {
      projectType,
      versionId,
      appSystemId: request.appSystemId
    });
    if (!result.ok) {
      clearAuthIfExpired(result.code);
      return authRequiredResponse(result.code, result.message);
    }
    return { ok: true, status: result.status };
  }
);

ipcMain.handle(IPCChannels.deployGetEligibility, (): DeployEligibility => readDeployEligibilityFromWorkspace());

ipcMain.handle(IPCChannels.deployOpenLocalNetworkSettings, async (): Promise<DeployActionResponse> => {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Local Network privacy settings are only available on macOS." };
  }

  const urls = [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
    "x-apple.systempreferences:com.apple.preference.security?Privacy"
  ];
  for (const url of urls) {
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      // Try the broader fallback below.
    }
  }
  return { ok: false, error: "Could not open macOS Privacy settings." };
});

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
      if (isLikelyMacLocalNetworkPermissionFailure(message)) {
        return {
          ok: false,
          error: "macOS may be waiting for Local Network approval. Allow Dartsnut Agent in the system prompt, then retry the connection.",
          needsLocalNetworkPermission: true,
          canRetry: true
        };
      }
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
ipcMain.handle(IPCChannels.getProviderSettings, () => readProviderSettings());
ipcMain.handle(IPCChannels.getPythonRuntimeStatus, () => pythonRuntimeStatus);
ipcMain.handle(IPCChannels.getPythonRuntimeProgress, () => pythonRuntimeProgress);
ipcMain.handle(IPCChannels.saveProviderSettings, async (_event: unknown, request: SaveProviderSettingsRequest) => {
  const saved = await writeProviderSettings(request);
  await reconfigureAgentsSdkFromProviderSettings(saved);
  emitBootstrapStateToRenderer();
  return saved;
});

ipcMain.handle(IPCChannels.startNewProject, async () => {
  const ws = workspaceRoot;
  if (
    isTemporaryWorkspaceActiveNow() &&
    ws &&
    fs.existsSync(ws) &&
    fs.statSync(ws).isDirectory() &&
    isDirectoryEmpty(ws)
  ) {
    performSessionCleanup({ clearWorkspace: false });
    return getBootstrapState();
  }
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
      state.projectTypeUserConfirmed = true;
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
      state.widgetSizeUserConfirmed = true;
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
      const session = await buildSession("asset-applier", {
        workspacePath: targetWorkspace,
        assetApplierMode: true
      });
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
    const lastIntakeUserPrompt = req.prompt;
    const sharedIntakeHandler = async (args: Record<string, unknown>) =>
      intakeHostToolExecute(args, hostState, lastIntakeUserPrompt);

    const intent = req.agentSession?.intent ?? "auto";
    const persistence = buildWorkspaceSessionPersistence(workspaceRoot);
    if (intent === "fresh" && persistence) {
      persistence.archiveOrResetSession("renderer-fresh");
    }
    const initialConversation =
      persistence && intent !== "fresh" ? persistence.readConversation() : [];
    const effectiveWorkspacePath =
      typeof req.workspacePath === "string" && req.workspacePath.length > 0 ? req.workspacePath : workspaceRoot;
    const hintedRouting =
      effectiveWorkspacePath && fs.existsSync(effectiveWorkspacePath)
        ? readWorkspaceCreatorHints(effectiveWorkspacePath)
        : null;
    const routedTemplateMode =
      req.templateMode === "game-creator" || req.templateMode === "widget-creator"
        ? req.templateMode
        : hintedRouting?.templateMode;
    const routedProjectType =
      req.projectType ??
      hintedRouting?.projectType ??
      (routedTemplateMode === "widget-creator"
        ? "widget"
        : routedTemplateMode === "game-creator"
          ? "game"
          : undefined);
    const routedWidgetSize = req.widgetSize ?? hintedRouting?.widgetSize;
    const session = await buildSession(req.templateMode, {
      completionTools: AGENT_TOOL_SCHEMAS,
      hostIntakeToolHandler: sharedIntakeHandler,
      hostAskQuestionHandler: (args) => askQuestionHostExecute(args, hostState),
      hostIntakeReadyToFinish: () => isIntakeStateReady(hostState),
      sessionPersistence: persistence,
      initialConversation,
      latestUserTextForLocale: req.prompt,
      intakeState: hostState,
      projectType: routedProjectType ?? hintedRouting?.projectType,
      widgetSize: routedWidgetSize ?? hintedRouting?.widgetSize,
      getIntakeState: () => hostState
    });
    if (routedTemplateMode) {
      sessionRouting = {
        templateMode: routedTemplateMode,
        projectType:
          routedProjectType ??
          (routedTemplateMode === "widget-creator" ? "widget" : "game"),
        ...(routedWidgetSize ? { widgetSize: routedWidgetSize } : {})
      };
    }
    const prompt = buildRoutedPrompt(req, hostState);
    terminalAgentLifecycleLog("[agent] runPrompt start", { promptChars: prompt.length });
    await session.runPrompt(prompt, emitAgent, runAbort.signal, { userPrompt: req.prompt });

    if (!firstRunComplete) {
      writeProofState(true);
    }
    if (isIntakeStateReady(hostState)) {
      const pt = hostState.projectType;
      if (pt === "game" || pt === "widget") {
        sessionRouting = {
          templateMode: pt === "game" ? "game-creator" : "widget-creator",
          projectType: pt,
          ...(pt === "widget" && hostState.widgetSize ? { widgetSize: hostState.widgetSize } : {})
        };
      }
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

ipcMain.handle(EMULATOR_IPC_CHANNELS.emulatorOpenCaptureFolder, async (_event, folderPath: string) => {
  try {
    await shell.openPath(folderPath);
  } catch (err) {
    console.error("Failed to open capture folder:", err);
  }
});
