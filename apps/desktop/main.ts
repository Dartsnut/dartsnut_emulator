import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { spawn, spawnSync } from "node:child_process";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell } from "electron";
import type { MessageBoxOptions } from "electron";
import { createAgentEventBatcher, type AgentEventBatcher } from "./agentEventBatcher";
import { AgentRunCoordinator } from "./agentRunCoordinator";
import { appendDevFileLog, devLog, getDevLogPath, isDevLoggingEnabled } from "./devOnlyLog";
import { createPublishTarball } from "./publishPackage";
import {
  readWorkspaceProjectClassification,
  syncWorkspaceProjectMetadata
} from "./workspaceProjectMetadata";
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
  type ProjectTree,
  type ProjectCreateRequest,
  type ProjectSelectRequest,
  type ChatCreateRequest,
  type ProjectSwitchProgress,
  type AppUpdateStatus,
  type AppUpdateInstallResponse,
  type AppUpdateDownloadResponse,
  type AppUpdateCheckResponse,
  type DeployActionResponse,
  type DeployConnectRequest,
  type DeployConnectResponse,
  type DeployConnectionState,
  type DeployEligibility,
  type DeployFrameEvent,
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
  type CustomProviderSettings,
  type UnbindSlotRequest,
  type UnbindSlotResponse,
  type WidgetSize,
  type ShellUiTheme,
  type WindowChromeInsets,
  type SendPromptResponse,
  type MainProcessConsoleMirrorPayload,
  type MachineMcpQuestionMachine,
  type MachineMcpSubmitQuestionAnswerRequest,
  type MachineMcpSubmitQuestionAnswerResponse,
  type AgentQuestionPrompt,
  type AgentQuestionAnswerRequest,
  type AgentQuestionAnswerResponse,
  type CommunitySessionInfo,
  type CommunityCancelGoogleLoginResponse,
  type CommunitySetPasswordRequest,
  type CommunitySetPasswordResponse,
  type CommunityLoginRequest,
  type CommunityLoginResponse,
  type CommunityLogoutResponse,
  type CommunityGetLlmQuotaResponse,
  type CommunityListDeployDevicesResponse,
  type CommunityListMyGamesResponse,
  type CommunityGetPublishOptionsResponse,
  type CommunityListAppVersionsRequest,
  type CommunityListAppVersionsResponse,
  type CommunityCreateAppRequest,
  type CommunityCreateAppResponse,
  type CommunityUploadNativeImageRequest,
  type CommunityUploadNativeImageResponse,
  type CommunitySubmitAppVersionRequest,
  type CommunitySubmitAppVersionResponse,
  type CommunityUpdateWorkspaceVersionRequest,
  type CommunityUpdateWorkspaceVersionResponse,
  type CommunitySubmitProgress,
  type CommunitySubmitProgressStage,
  type CommunityWithdrawAppVersionRequest,
  type CommunityWithdrawAppVersionResponse,
  type CommunityAppSummary,
  type CommunityWorkspaceDefaults,
  type AgentSessionWorkspaceSummary,
  type AgentProfileId,
  normalizeAgentProfileId,
  buildPromptWithChatMediaAttachments,
  parseWidgetFontCatalogFromManifest,
  type WidgetFontCatalogEntry,
  type RendererErrorPayload,
  type WidgetConfigScope,
  type WidgetConfigSnapshot
} from "@dartsnut/shared-ipc";
import {
  loadProviderConfig,
  validateProviderConfig,
  configureAgentsSdk,
  buildAgentModelConfig,
  SessionEngine,
  AgentSessionRuntime,
  WorkspacePolicy,
  allowedDeferredSkillIdsForMode,
  AGENT_TOOL_SCHEMAS,
  AgentSessionPersistence,
  isAgentSessionPersistenceDisabledByEnv,
  AGENT_STOPPED_MESSAGE,
  readWorkspaceCreatorHints,
  resolveCreatorRouting,
  type AgentInputItem,
  type AgentModelConfig,
  type ProviderConfig
} from "@dartsnut/agent-runtime";
import { formatAgentEventForConsole } from "./agentEventConsole";
import { fallbackChatTitle, generateChatTitle } from "./chatTitle";
import { PACKAGED_ENV } from "./packagedEnv.generated";
import {
  DARTSNUT_LLM_BRIDGE_API_KEY_PLACEHOLDER,
  DARTSNUT_LLM_MODEL_ALIAS,
  dartsnutLlmBridgeModelBaseUrl,
  startDartsnutLlmBridgeRun,
  type DartsnutLlmBridgeFailure,
  type DartsnutLlmBridgeRun
} from "./dartsnutLlmBridge";
import {
  EMULATOR_IPC_CHANNELS,
  beginEmulatorSwitch,
  buildEmulatorObservationFromFrame,
  handleEmulatorSwitchFrame,
  handleEmulatorSwitchState,
  type EmulatorCommand,
  type EmulatorFrame,
  type EmulatorInputAction,
  type EmulatorLogEntry,
  type EmulatorScenarioStep,
  type EmulatorStateSnapshot,
  type EmulatorSwitchGate,
} from "@dartsnut/emulator-protocol";
import {
  encodeHardwareMockupPngBase64,
  encodePanelPngsBase64,
  encodeRgbPngBase64,
  normalizeEmulatorInputAction,
  summarizeScenarioRequest
} from "./emulatorAgentTools";
import { copyEmulatorStateSnapshot } from "./emulatorState";
import { executePixelLabGenerationForAgent } from "./pixellabAgentTool";
import { AssetManager } from "./assetManager";
import { ProjectStore } from "./projectStore";
import { DeployMachineSession } from "./deployMachine";
import type { SideloadFrameEvent } from "./deployMachineSideload";
import { createCommunityClient, type CommunityClient } from "./communityClient";
import { clearCommunityAuth, readCommunityAuth, writeCommunityAuth } from "./communityAuth";
import { readWidgetConfigSnapshot, watchWidgetConfigFile, widgetConfigPathForScope } from "./widgetConfig";
const DEPLOY_APPLY_WIDGET_PARAMS = "deploy:apply-widget-params";
import { signInWithGoogleOAuth } from "./googleOAuth";
import {
  configureSystemProxySession,
  initializeDesktopNetwork,
  type DesktopNetwork
} from "./desktopNetwork";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  normalizeWindowBounds,
  type PersistedWindowState
} from "./windowState";
import {
  createShutdownCleanupRunner
} from "./quitFlow";
import {
  getAppUpdateStatus,
  getAutoUpdateEnabled,
  setAutoUpdateEnabled,
  downloadAvailableAppUpdate,
  checkForAppUpdate,
  installDownloadedAppUpdate,
  isDownloadedAppUpdateReady,
  isAppUpdateInstallRequested,
  startAppUpdateCheck
} from "./appUpdater";
import { normalizePoloAiResponse } from "./responsesCompatibility";
import { fetchBufferedModelResponse } from "./bufferedModelFetch";

let win: BrowserWindow | null = null;
let workspaceRoot: string | null = null;
let activeProjectId: string | null = null;
let activeChatId: string | null = null;
let projectStore: ProjectStore | null = null;
let projectSwitchInFlight: Promise<boolean> | null = null;
let firstRunComplete = false;
let bridgeProcess: ReturnType<typeof spawn> | null = null;
/** Launch config key for the current bridge (restart bridge when this changes). */
let bridgeRuntimeKey: string | null = null;
/** True after graceful bridge teardown so quit does not orphan pygame/SDL audio. */
let emulatorBridgeTeardownDone = false;
/** Current backend-backed LLM run, closed immediately when a user stops or quits the app. */
let activeDartsnutLlmBridgeRun: DartsnutLlmBridgeRun | null = null;
let desktopNetwork: DesktopNetwork | null = null;
let rendererRecoveryReloads = 0;
let startupShown = false;
const startupDiagnostics: string[] = [];
const STARTUP_LOG_MAX_BYTES = 1024 * 1024;

function startupLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "startup.log");
}

function safeStartupText(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|access[_-]?token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 4000);
}

function recordStartupDiagnostic(stage: string, details?: unknown): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    stage,
    ...(details === undefined ? {} : { details: safeStartupText(details) })
  });
  startupDiagnostics.push(line);
  while (startupDiagnostics.length > 200) startupDiagnostics.shift();
  try {
    const file = startupLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > STARTUP_LOG_MAX_BYTES) fs.writeFileSync(file, "", "utf8");
    fs.appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    // Diagnostics must never prevent startup.
  }
}

function startupDiagnosticsText(): string {
  return [
    `Dartsnut Agent ${app.getVersion()}`,
    `Electron ${process.versions.electron ?? "unknown"} / Chromium ${process.versions.chrome ?? "unknown"}`,
    `Platform ${process.platform}/${process.arch}`,
    `GPU safe mode ${process.argv.includes("--disable-gpu") ? "enabled" : "disabled"}`,
    ...startupDiagnostics
  ].join("\n");
}

function cloudFetch(): typeof fetch {
  return desktopNetwork?.fetch ?? fetch;
}

function customProviderFetch(): typeof fetch {
  const fetchImpl = cloudFetch();
  return async (input, init) => {
    const startedAt = Date.now();
    const requestUrl = input instanceof Request ? input.url : String(input);
    let parsedBody: Record<string, unknown> | null = null;
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (body) {
      try {
        const value = JSON.parse(body) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsedBody = value as Record<string, unknown>;
        }
      } catch {
        // Keep diagnostics structural when request body is not JSON.
      }
    }
    let url: URL | null = null;
    try {
      url = new URL(requestUrl);
    } catch {
      // URL validation happens before run; retain safe fallback below.
    }
    const inputValue = parsedBody?.input;
    const inputItems = Array.isArray(inputValue) ? inputValue.length : inputValue == null ? undefined : 1;
    const tools = Array.isArray(parsedBody?.tools) ? parsedBody.tools : [];
    terminalAgentLifecycleLog("[agent] custom model request", {
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      host: url?.host,
      path: url?.pathname,
      model: typeof parsedBody?.model === "string" ? parsedBody.model : undefined,
      stream: parsedBody?.stream === true,
      inputItems,
      toolCount: tools.length,
      bodyBytes: body ? Buffer.byteLength(body, "utf8") : undefined
    });
    try {
      const response = normalizePoloAiResponse(await fetchBufferedModelResponse(fetchImpl, input, init), requestUrl);
      const meta = {
        host: url?.host,
        path: url?.pathname,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") ?? undefined,
        requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
        elapsedMs: Date.now() - startedAt
      };
      if (!response.ok) {
        let errorBody: string | undefined;
        try {
          errorBody = (await response.clone().text()).slice(0, 2000);
        } catch {
          // Some streaming responses cannot be cloned/read after failure.
        }
        terminalAgentLifecycleLog("[agent] custom model rejected", {
          ...meta,
          ...(errorBody ? { errorBody } : {})
        });
      } else {
        terminalAgentLifecycleLog("[agent] custom model response", meta);
      }
      return response;
    } catch (error) {
      terminalAgentLifecycleLog("[agent] custom model request failed", {
        host: url?.host,
        path: url?.pathname,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? `${error.name} ${error.message}` : String(error)
      });
      throw error;
    }
  };
}

// Ensure consistent app name for getPath('userData') in both dev and packaged modes
if (!app.isPackaged) {
  app.setName("DartsnutAgent-Dev");
}

// Bypass system proxy/VPN for localhost in development to prevent SSL interception
// of the Vite dev server connection by tools like Surge Enhanced Mode
if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch("proxy-bypass-list", "<local>;127.0.0.1;localhost");
}

app.on("login", (event, _webContents, _details, authInfo, callback) => {
  if (!authInfo.isProxy) {
    return;
  }
  event.preventDefault();
  console.warn("[network] authenticated system proxies are unsupported", {
    scheme: authInfo.scheme,
    host: authInfo.host,
    port: authInfo.port
  });
  callback();
});

const repoRoot = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, "../../..");
process.env.DARTSNUT_REPO_ROOT = repoRoot;
process.env.DARTSNUT_ALLOW_RESOURCES_ENV_FILE = app.isPackaged ? "0" : "1";
const repoEnvPath = path.join(repoRoot, ".env");
if (app.isPackaged) {
  for (const [key, value] of Object.entries(PACKAGED_ENV)) {
    if (!process.env[key]) {
      process.env[key] = String(value);
    }
  }
} else if (fs.existsSync(repoEnvPath)) {
  dotenv.config({ path: repoEnvPath });
}
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

/** Serializes prompt replacement/cancellation through provider and backend run cleanup. */
const sendPromptCoordinator = new AgentRunCoordinator();
/** Background title runs yield immediately when a real agent prompt starts. */
const chatTitleCoordinator = new AgentRunCoordinator();

/** Set while desktop Google OAuth is waiting for the browser callback or login API. */
let communityGoogleLoginAbortController: AbortController | null = null;

/** Poll project metadata files; survives atomic writes and works before either file exists. */
const PROJECT_FILE_POLL_MS = 600;
let deployConfWatch: { watchedPaths: string[]; workspacePath: string } | null = null;
const widgetConfigWatches = new Map<WidgetConfigScope, () => void>();

function currentWidgetConfigSnapshot(scope: WidgetConfigScope): WidgetConfigSnapshot {
  return readWidgetConfigSnapshot(scope, workspaceRoot, lastWidgetDir);
}

function emitWidgetConfigSnapshot(scope: WidgetConfigScope): void {
  sendToRenderer(IPCChannels.widgetConfigChanged, currentWidgetConfigSnapshot(scope));
}

function stopWidgetConfigWatchers(): void {
  for (const stopWatching of widgetConfigWatches.values()) {
    try {
      stopWatching();
    } catch {
      // ignore
    }
  }
  widgetConfigWatches.clear();
}

function startWidgetConfigWatchers(): void {
  stopWidgetConfigWatchers();
  for (const scope of ["workspace", "emulator"] as const) {
    const watchedPath = widgetConfigPathForScope(scope, workspaceRoot, lastWidgetDir);
    if (watchedPath) {
      const pyprojectPath = path.join(path.dirname(watchedPath), "pyproject.toml");
      const stopConfWatch = watchWidgetConfigFile(watchedPath, () => emitWidgetConfigSnapshot(scope), PROJECT_FILE_POLL_MS);
      const stopPyprojectWatch = watchWidgetConfigFile(pyprojectPath, () => emitWidgetConfigSnapshot(scope), PROJECT_FILE_POLL_MS);
      widgetConfigWatches.set(
        scope,
        () => {
          stopConfWatch();
          stopPyprojectWatch();
        },
      );
    }
    emitWidgetConfigSnapshot(scope);
  }
}

function stopDeployConfWatcher(): void {
  if (deployConfWatch) {
    for (const watchedPath of deployConfWatch.watchedPaths) {
      try {
        fs.unwatchFile(watchedPath);
      } catch {
        // ignore
      }
    }
    deployConfWatch = null;
  }
  stopWidgetConfigWatchers();
}

function startDeployConfWatcher(workspacePath: string): void {
  stopDeployConfWatcher();
  const watchedPaths = [path.join(workspacePath, "pyproject.toml"), path.join(workspacePath, "conf.json")];
  for (const watchedPath of watchedPaths) {
    fs.watchFile(watchedPath, { interval: PROJECT_FILE_POLL_MS }, () => {
      if (!deployConfWatch || deployConfWatch.workspacePath !== workspaceRoot) return;
      sendToRenderer(IPCChannels.deployEligibilityChanged, readDeployEligibilityFromWorkspace());
    });
  }
  deployConfWatch = { watchedPaths, workspacePath };
  sendToRenderer(IPCChannels.deployEligibilityChanged, readDeployEligibilityFromWorkspace());
  startWidgetConfigWatchers();
}

function emitDeployLog(line: string): void {
  sendToRenderer(IPCChannels.deployLog, line);
}

function emitDeployConnection(state: DeployConnectionState): void {
  sendToRenderer(IPCChannels.deployConnectionChanged, state);
}

function emitDeployFrame(frame: SideloadFrameEvent | null): void {
  if (!frame) {
    sendToRenderer(IPCChannels.deployFrame, { active: false } satisfies DeployFrameEvent);
    return;
  }
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(frame.frame, "base64"));
    const size = image.getSize();
    const bitmap = image.toBitmap();
    if (size.width !== frame.width || size.height !== frame.height || bitmap.length !== size.width * size.height * 4) {
      throw new Error("invalid PNG dimensions");
    }
    const rgb = Buffer.allocUnsafe(size.width * size.height * 3);
    for (let src = 0, dst = 0; src < bitmap.length; src += 4, dst += 3) {
      rgb[dst] = bitmap[src + 2];
      rgb[dst + 1] = bitmap[src + 1];
      rgb[dst + 2] = bitmap[src];
    }
    sendToRenderer(IPCChannels.deployFrame, {
      active: true,
      frame: {
        width: size.width,
        height: size.height,
        rgbBase64: rgb.toString("base64"),
        timestampMs: Date.now(),
      },
    } satisfies DeployFrameEvent);
  } catch (error) {
    emitDeployLog(`[sideload] frame decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function emitCommunitySubmitProgress(stage: CommunitySubmitProgressStage, message: string): void {
  const progress: CommunitySubmitProgress = { stage, message };
  sendToRenderer(IPCChannels.communitySubmitProgress, progress);
}

function getDeployMachineSession(): DeployMachineSession {
  if (!deployMachineSession) {
    deployMachineSession = new DeployMachineSession(emitDeployLog, emitDeployFrame, emitDeployConnection);
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
  emitDeployConnection({ connected: false, deviceName: null, deployMode: null });
}

async function restoreDeployMachineForQuit(): Promise<void> {
  const session = deployMachineSession;
  if (!session || !session.connected) {
    await disconnectDeployMachine();
    return;
  }
  try {
    if (session.safeSideloadSupported) {
      emitDeployLog("[sideload] Quit — stopping local sideload session…");
      await session.stopSideload();
      return;
    }
    emitDeployLog("[deploy] Quit — restore machine, stop debug apps, restart dartsnut_python.service…");
    const elig = readDeployEligibilityFromWorkspace();
    const failures = await session.cleanupForQuit(elig.ok ? elig.appId : undefined);
    for (const failure of failures) {
      emitDeployLog(`[deploy] Quit cleanup failed: ${failure}`);
    }
    if (failures.length > 0) {
      throw new Error(failures.join(", "));
    }
  } finally {
    await disconnectDeployMachine();
  }
}

function readSideloadSizeFromWorkspace(projectType: ProjectType): readonly [number, number] {
  if (projectType === "game") return [128, 160];
  if (!workspaceRoot) throw new Error("No workspace open.");
  const classification = readWorkspaceProjectClassification(workspaceRoot);
  if (!classification.ok || classification.projectType !== "widget") {
    throw new Error("Could not read widget size.");
  }
  const rawSize = classification.conf?.size;
  const size = Array.isArray(rawSize) && rawSize.length === 2
    ? `${Number(rawSize[0])}x${Number(rawSize[1])}`
    : String(rawSize ?? "").trim().replace(/\s*,\s*/, "x");
  const supported: Record<string, readonly [number, number]> = {
    "128x128": [128, 128],
    "128x64": [128, 64],
    "64x32": [64, 32],
  };
  const dimensions = supported[size];
  if (!dimensions) throw new Error(`Unsupported widget sideload size: ${size || "missing"}.`);
  return dimensions;
}

function readDeployEligibilityFromWorkspace(): DeployEligibility {
  if (!workspaceRoot) {
    return { ok: false, reason: "no_workspace" };
  }
  try {
    const classification = readWorkspaceProjectClassification(workspaceRoot);
    if (!classification.ok) return { ok: false, reason: classification.reason };
    return {
      ok: true,
      appId: classification.appId,
      version: classification.version,
      projectType: classification.projectType
    };
  } catch {
    return { ok: false, reason: "invalid_project" };
  }
}

function readCommunityWorkspaceDefaults(): CommunityWorkspaceDefaults {
  const fallback = {
    eligible: false,
    appId: "",
    projectType: null,
    appName: "",
    version: "",
    description: "",
    widgetSize: ""
  };
  let classification: ReturnType<typeof readWorkspaceProjectClassification> | null;
  try {
    classification = workspaceRoot ? readWorkspaceProjectClassification(workspaceRoot) : null;
  } catch {
    return fallback;
  }
  if (!workspaceRoot || !classification?.ok) {
    return fallback;
  }
  const conf = classification.conf;
  return {
    eligible: true,
    appId: classification.appId,
    projectType: classification.projectType,
    appName: String(conf?.name || classification.appId).trim(),
    version: classification.version,
    description: String(conf?.description || "").trim(),
    widgetSize: String(conf?.size || "").trim()
  };
}

function fileBlobFromPath(filePath: string, mimeType = "application/octet-stream"): Blob {
  return new Blob([fs.readFileSync(filePath)], { type: mimeType });
}

function authRequiredResponse(
  code: string,
  message: string,
  serverMessage?: string
): { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean } {
  return { ok: false, code, message, serverMessage, authRequired: code === "session_expired" };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recentEmulatorLogs(maxLines?: number): EmulatorLogEntry[] {
  const requested =
    typeof maxLines === "number" && Number.isFinite(maxLines)
      ? Math.min(EMULATOR_LOG_MAX_REQUEST, Math.max(1, Math.floor(maxLines)))
      : EMULATOR_LOG_DEFAULT_TAIL;
  return emulatorLogRing.slice(-requested);
}

function ensureBridgeReady(): { ok: true } | { ok: false; error: string } {
  if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
    startPythonBridge();
  }
  if (!bridgeProcess?.stdin || bridgeProcess.stdin.destroyed) {
    return { ok: false, error: "Emulator bridge is not available." };
  }
  return { ok: true };
}

function sendBridgeCommand(command: EmulatorCommand): void {
  const ready = ensureBridgeReady();
  if (!ready.ok || !bridgeProcess?.stdin || bridgeProcess.stdin.destroyed) {
    throw new Error(ready.ok ? "Emulator bridge is not available." : ready.error);
  }
  bridgeProcess.stdin.write(`${JSON.stringify({ command })}\n`);
}

async function waitForEmulatorFrame(timeoutMs: number, afterTimestampMs = 0): Promise<EmulatorFrame | null> {
  const deadline = Date.now() + Math.max(0, Math.floor(timeoutMs));
  while (Date.now() <= deadline) {
    if (latestEmulatorFrame && latestEmulatorFrame.timestampMs >= afterTimestampMs) {
      return latestEmulatorFrame;
    }
    await sleep(25);
  }
  return latestEmulatorFrame && latestEmulatorFrame.timestampMs >= afterTimestampMs ? latestEmulatorFrame : null;
}

async function executeHostObserveEmulatorForAgent(args?: Record<string, unknown>): Promise<string> {
  const waitMs =
    typeof args?.wait_for_frame_ms === "number" && Number.isFinite(args.wait_for_frame_ms)
      ? Math.min(10_000, Math.max(0, Math.floor(args.wait_for_frame_ms)))
      : 1000;
  const observeStartedAt = Date.now();
  const freshFrame = waitMs > 0 ? await waitForEmulatorFrame(waitMs, observeStartedAt) : null;
  const frame = freshFrame ?? latestEmulatorFrame;
  if (!frame) {
    return JSON.stringify({
      ok: false,
      error: "No emulator frame is available yet. Call reload_emulator with wait_for_frame_ms, then observe again.",
      emulator: emulatorState,
      logs: recentEmulatorLogs(typeof args?.max_log_lines === "number" ? args.max_log_lines : undefined)
    });
  }
  const includePng = args?.include_png === true;
  const includeHardwareMockup = includePng && args?.include_hardware_mockup === true;
  const surfacePngBase64 = includePng ? encodeRgbPngBase64(frame) : undefined;
  const panelPngBase64 = includePng ? encodePanelPngsBase64(frame) : undefined;
  const hardwarePngBase64 = includeHardwareMockup ? encodeHardwareMockupPngBase64(frame) : undefined;
  const observation = buildEmulatorObservationFromFrame({
    frame,
    state: { ...emulatorState },
    logs: recentEmulatorLogs(typeof args?.max_log_lines === "number" ? args.max_log_lines : undefined),
    previousSurfaceHash: previousAgentObservationSurfaceHash,
    includePngBase64: includePng,
    surfacePngBase64,
    panelPngBase64,
    hardwarePngBase64
  });
  if (observation.frame?.surfaceHash) {
    previousAgentObservationSurfaceHash = observation.frame.surfaceHash;
  }
  return JSON.stringify(observation);
}

async function executeHostControlEmulatorInputForAgent(args?: Record<string, unknown>): Promise<string> {
  try {
    const normalized = normalizeEmulatorInputAction(args?.action, agentDartSlots);
    const applied: unknown[] = [];
    for (const command of normalized.commands) {
      if (command.type === "delay") {
        await sleep(command.ms);
        applied.push(command);
        continue;
      }
      sendBridgeCommand(command);
      applied.push(command);
      if (command.type === "clear_darts") {
        agentDartSlots = Array.from({ length: 12 }, () => [-1, -1]);
      } else if (command.type === "throw_dart") {
        agentDartSlots[command.index] = [command.x, command.y];
      } else if (command.type === "remove_dart_at") {
        agentDartSlots = agentDartSlots.map((slot) =>
          slot[0] === command.x && slot[1] === command.y ? [-1, -1] : slot
        );
      }
    }
    return JSON.stringify({ ok: true, applied, darts: agentDartSlots });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Agent tool `reload_emulator`: sync bridge path, reload widget (Python re-reads conf.json), refresh deploy UI. */
async function executeHostReloadEmulatorForAgent(args?: {
  params?: Record<string, unknown>;
  clear_inputs?: boolean;
  wait_for_frame_ms?: number;
}): Promise<string> {
  if (!workspaceRoot) {
    return JSON.stringify({
      ok: false,
      error: "No workspace is selected. Pick a project folder first."
    });
  }
  const ready = ensureBridgeReady();
  if (!ready.ok) {
    return JSON.stringify({ ok: false, error: ready.error });
  }
  const baseRoot = getEmulatorWorkspaceRoot();
  let selectedPath = path.isAbsolute(workspaceRoot) ? workspaceRoot : path.join(baseRoot, workspaceRoot);
  if (!isWithinDirectory(workspaceRoot, selectedPath)) {
    selectedPath = workspaceRoot;
  }
  if (args?.clear_inputs) {
    sendBridgeCommand({ type: "clear_darts" });
    agentDartSlots = Array.from({ length: 12 }, () => [-1, -1]);
    for (const button of ["A", "B", "UP", "DOWN", "LEFT", "RIGHT"] as const) {
      sendBridgeCommand({ type: "set_button", button, pressed: false });
    }
  }
  if (args?.params && typeof args.params === "object" && !Array.isArray(args.params)) {
    sendBridgeCommand({ type: "set_params", params: args.params });
  }
  const setPath: EmulatorCommand = { type: "set_path", path: selectedPath };
  const reload: EmulatorCommand = { type: "reload_widget" };
  sendBridgeCommand(setPath);
  clearEmulatorLogsForReload();
  beginPendingEmulatorSwitch(selectedPath);
  const reloadStartedAt = Date.now();
  sendBridgeCommand(reload);
  lastWidgetDir = selectedPath;
  writeEmulatorState();
  startDeployConfWatcher(workspaceRoot);
  let observedFrame: EmulatorFrame | null = null;
  if (typeof args?.wait_for_frame_ms === "number" && args.wait_for_frame_ms > 0) {
    observedFrame = await waitForEmulatorFrame(Math.min(10_000, Math.floor(args.wait_for_frame_ms)), reloadStartedAt);
  }
  return JSON.stringify({
    ok: true,
    observedFrame: observedFrame
      ? { width: observedFrame.width, height: observedFrame.height, timestampMs: observedFrame.timestampMs }
      : null,
    message:
      "Emulator path re-applied and reload_widget sent; conf.json re-read on the Python side and deploy eligibility refreshed. Call observe_emulator and get_emulator_logs next to confirm the widget starts without errors and renders a nonblank frame."
  });
}

async function executeHostRunEmulatorScenarioForAgent(args?: Record<string, unknown>): Promise<string> {
  const summary = summarizeScenarioRequest({
    steps: Array.isArray(args?.steps) ? (args.steps as EmulatorScenarioStep[]) : [],
    timeout_ms: typeof args?.timeout_ms === "number" ? args.timeout_ms : undefined
  });
  const startedAt = Date.now();
  const trace: unknown[] = [];
  let observations = 0;
  const observeStepIndices = summary.steps
    .map((step, index) => (step.type === "observe" ? index : -1))
    .filter((index) => index >= 0)
    .slice(0, summary.observationLimit);
  const finalObserveStepIndex = observeStepIndices.length > 0 ? observeStepIndices[observeStepIndices.length - 1] : undefined;
  for (let i = 0; i < summary.steps.length; i += 1) {
    if (Date.now() - startedAt > summary.timeoutMs) {
      return JSON.stringify({ ok: false, error: "Scenario timed out.", summary, trace });
    }
    const step = summary.steps[i] as EmulatorScenarioStep;
    try {
      if (step.type === "reload") {
        const result = JSON.parse(await executeHostReloadEmulatorForAgent({
          params: step.params,
          clear_inputs: step.clear_inputs,
          wait_for_frame_ms: step.wait_for_frame_ms
        }));
        trace.push({ step: i, type: step.type, result });
      } else if (step.type === "wait_frame") {
        const waitStartedAt = Date.now();
        const frame = await waitForEmulatorFrame(Math.min(10_000, Math.max(0, step.timeout_ms ?? 1000)), waitStartedAt);
        trace.push({ step: i, type: step.type, frame: frame ? { width: frame.width, height: frame.height, timestampMs: frame.timestampMs } : null });
      } else if (step.type === "observe") {
        if (observations >= summary.observationLimit) {
          trace.push({ step: i, type: step.type, skipped: "observation_limit" });
          continue;
        }
        const includePng = step.include_png === true && (observations === 0 || i === finalObserveStepIndex);
        const result = JSON.parse(await executeHostObserveEmulatorForAgent({
          include_png: includePng,
          include_hardware_mockup: includePng,
          wait_for_frame_ms: 1000,
          max_log_lines: step.max_log_lines
        }));
        trace.push({ step: i, type: step.type, result });
        observations += 1;
      } else if (step.type === "input") {
        const result = JSON.parse(await executeHostControlEmulatorInputForAgent({ action: step.action as EmulatorInputAction }));
        trace.push({ step: i, type: step.type, result });
      } else if (step.type === "delay") {
        const ms = Math.min(5000, Math.max(0, Math.floor(step.ms)));
        await sleep(ms);
        trace.push({ step: i, type: step.type, ms });
      } else if (step.type === "logs") {
        trace.push({ step: i, type: step.type, result: JSON.parse(executeHostGetEmulatorLogsForAgent({ max_lines: step.max_lines })) });
      } else {
        trace.push({ step: i, type: "unknown", error: `Unsupported scenario step: ${(step as { type?: unknown }).type}` });
      }
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        summary,
        trace
      });
    }
  }
  return JSON.stringify({ ok: true, summary, trace });
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
  audioMuted: false,
  lastCapturePath: null,
  gifRecording: false,
  gifSaving: false,
  gifElapsedMs: 0,
};
let emulatorSwitchGate: EmulatorSwitchGate | null = null;
let pendingEmulatorPathForReload: string | null = null;
let latestEmulatorFrame: EmulatorFrame | null = null;
let previousAgentObservationSurfaceHash: string | null = null;
let agentDartSlots: [number, number][] = Array.from({ length: 12 }, () => [-1, -1]);

const proofStatePath = () => path.join(app.getPath("userData"), "first-run-proof.json");
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

function normalizeCustomProviderSettings(input?: Partial<CustomProviderSettings> | null): CustomProviderSettings {
  return {
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : ""
  };
}

type LegacyProviderSettingsFile = Omit<Partial<ProviderSettings>, "activeProvider" | "custom"> & {
  activeProvider?: string;
  custom?: Partial<CustomProviderSettings>;
  userDefine?: Partial<CustomProviderSettings>;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function normalizeProviderId(value: unknown): ProviderId {
  return value === "custom" ? "custom" : "dartsnut-llm";
}

function providerSettingsForDisk(settings: ProviderSettings): ProviderSettings {
  return {
    activeProvider: settings.activeProvider,
    custom: settings.custom
  };
}

function persistProviderSettings(settings: ProviderSettings): void {
  fs.mkdirSync(path.dirname(providerSettingsPath()), { recursive: true });
  fs.writeFileSync(providerSettingsPath(), JSON.stringify(providerSettingsForDisk(settings), null, 2));
}

function normalizeProviderSettings(input?: LegacyProviderSettingsFile | null): ProviderSettings {
  const legacyFlat =
    input != null &&
    (typeof input.baseUrl === "string" ||
      typeof input.apiKey === "string" ||
      typeof input.model === "string") &&
    input.userDefine == null;

  if (legacyFlat) {
    const custom = normalizeCustomProviderSettings({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model
    });
    return {
      activeProvider: "custom",
      custom
    };
  }

  const legacyUserDefine = normalizeCustomProviderSettings(input?.userDefine);
  const customSource = input?.custom ?? input?.userDefine;
  const custom = normalizeCustomProviderSettings(customSource);
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
    return {
      activeProvider: "dartsnut-llm",
      custom: normalizeCustomProviderSettings()
    };
  }
  return {
    activeProvider,
    custom
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
  if (normalized.activeProvider === "dartsnut-llm") {
    return { ok: true };
  }
  const custom = normalized.custom;
  if (!custom.baseUrl) {
    return { ok: false, error: "Endpoint is required." };
  }
  if (!custom.apiKey) {
    return { ok: false, error: "API key is required." };
  }
  if (!custom.model) {
    return { ok: false, error: "Model is required." };
  }
  try {
    new URL(custom.baseUrl);
  } catch {
    return { ok: false, error: "Endpoint must be a valid URL." };
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

function resolveDartsnutBridgeProviderConfig(): ProviderConfig {
  const baseApi = getCommunityClient().getConfig().baseApi;
  return {
    baseUrl: dartsnutLlmBridgeModelBaseUrl(baseApi),
    apiKey: DARTSNUT_LLM_BRIDGE_API_KEY_PLACEHOLDER,
    model: DARTSNUT_LLM_MODEL_ALIAS
  };
}

function resolveProviderConfigForDesktop(providerSettings: ProviderSettings): ProviderConfig {
  if (providerSettings.activeProvider === "dartsnut-llm") {
    return resolveDartsnutBridgeProviderConfig();
  }
  return loadProviderConfig({ providerSettings, fetchImpl: customProviderFetch() });
}

function resolveCachedProviderConfigForDesktop(providerSettings: ProviderSettings): ProviderConfig {
  return resolveProviderConfigForDesktop(providerSettings);
}

function buildAgentModelConfigFromProviderSettings(providerSettings: ProviderSettings) {
  const config = resolveProviderConfigForDesktop(providerSettings);
  return buildAgentModelConfig({
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetchImpl: config.fetchImpl
  });
}

function reconfigureAgentsSdkFromProviderSettings(providerSettings: ProviderSettings): void {
  if (providerSettings.activeProvider === "dartsnut-llm") {
    return;
  }
  configureAgentsSdk(buildAgentModelConfigFromProviderSettings(providerSettings), { force: true });
}

type PreparedAgentProvider =
  | { ok: true; modelConfig: AgentModelConfig; bridgeRun: DartsnutLlmBridgeRun | null }
  | { ok: false; failure: DartsnutLlmBridgeFailure };

async function prepareAgentProvider(providerSettings: ProviderSettings): Promise<PreparedAgentProvider> {
  if (providerSettings.activeProvider === "custom") {
    const config = resolveProviderConfigForDesktop(providerSettings);
    const validation = validateProviderConfig(config);
    if (!validation.ok) {
      return {
        ok: false,
        failure: { reason: "service_unavailable", message: validation.error || "Custom provider is not configured." }
      };
    }
    return {
      ok: true,
      bridgeRun: null,
      modelConfig: buildAgentModelConfig({
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        fetchImpl: config.fetchImpl
      })
    };
  }

  const auth = readCommunityAuth(getCommunityUserDataPath());
  if (!auth?.token) {
    return {
      ok: false,
      failure: {
        reason: "auth_required",
        message: "Sign in to your Dartsnut account to use Dartsnut LLM."
      }
    };
  }
  const started = await startDartsnutLlmBridgeRun({
    baseApi: getCommunityClient().getConfig().baseApi,
    token: auth.token,
    accountScope: auth.account,
    runId: randomUUID(),
    fetchImpl: cloudFetch(),
    onDiagnostic: (message, meta) => terminalAgentLifecycleLog(`[agent] ${message}`, meta)
  });
  if (!started.ok) {
    if (started.failure.reason === "auth_required") {
      clearCommunityAuth(getCommunityUserDataPath());
    }
    return started;
  }
  return {
    ok: true,
    modelConfig: started.run.modelConfig,
    bridgeRun: started.run
  };
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

function getDialogParent(): BrowserWindow | undefined {
  return win && !win.isDestroyed() ? win : undefined;
}

async function showAppMessageBox(options: MessageBoxOptions) {
  const parent = getDialogParent();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
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
  emulatorState.gifRecording = false;
  emulatorState.gifSaving = false;
  emulatorState.gifElapsedMs = 0;
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
    activeProjectId,
    activeChatId,
    providerStatus: providerStatus(),
    firstRunComplete
  };
}

function getProjectStore(): ProjectStore {
  if (!projectStore) projectStore = new ProjectStore(app.getPath("userData"));
  return projectStore;
}

function projectTree(): ProjectTree { return getProjectStore().list(); }

function emitProjectSwitchProgress(progress: ProjectSwitchProgress): void {
  sendToRenderer(IPCChannels.projectSwitchProgress, progress);
}

async function stopRuntimeForProjectTransition(confirmStop = true): Promise<"ready" | "stopped" | "cancelled"> {
  const runtimeActive = Boolean(emulatorState.running || deployMachineSession?.connected || deployMachineSession?.connecting);
  if (!runtimeActive) return "ready";
  if (confirmStop) {
    const { response } = await showAppMessageBox({ type: "question", buttons: ["Switch project", "Cancel"], defaultId: 1, cancelId: 1, title: "Switch project", message: "Emulator or remote deployment is active. Stop it and switch project?" });
    if (response !== 0) return "cancelled";
  }
  emitProjectSwitchProgress({ active: true, stage: "stopping-deployment", message: "Stopping remote deployment…" });
  if (deployMachineSession?.connected || deployMachineSession?.connecting) {
    const session = deployMachineSession;
    try {
      if (session?.safeSideloadSupported) {
        await session.stopSideload();
      } else if (session?.connected && !session.connecting) {
        session.stopLogTail();
        await session.killDebugPython();
        await session.killAppMainPyProcesses();
        await session.restartSystemdService();
      }
    } finally {
      await disconnectDeployMachine();
    }
  }
  emitProjectSwitchProgress({ active: true, stage: "stopping-emulator", message: "Stopping emulator…" });
  if (emulatorState.running) await gracefulStopEmulatorBridge();
  return "stopped";
}

async function switchToProject(projectId: string, chatId?: string): Promise<boolean> {
  const store = getProjectStore();
  const project = store.getProject(projectId);
  if (!project) return false;
  store.migrateLegacy(project);
  if (chatId) {
    const chat = store.getChat(chatId);
    if (!chat || chat.projectId !== project.id) return false;
  }
  if (activeProjectId === project.id) {
    activeChatId = chatId ?? null;
    if (activeChatId) store.markChatOpened(activeChatId);
    store.touchProject(project.id);
    emitBootstrapStateToRenderer();
    return true;
  }
  if (projectSwitchInFlight) return projectSwitchInFlight;
  projectSwitchInFlight = (async () => {
    if (await stopRuntimeForProjectTransition() === "cancelled") return false;
    emitProjectSwitchProgress({ active: true, stage: "switching", message: "Switching project…" });
    performSessionCleanup({ clearWorkspace: false });
    activeProjectId = project.id;
    activeChatId = chatId ?? null;
    if (activeChatId) store.markChatOpened(activeChatId);
    store.touchProject(project.id);
    applyWorkspaceRoot(project.folderPath);
    emitProjectSwitchProgress({ active: true, stage: "reloading", message: "Reloading emulator…" });
    if (bridgeProcess?.stdin && !bridgeProcess.stdin.destroyed) bridgeProcess.stdin.write(`${JSON.stringify({ command: { type: "set_path", path: project.folderPath } })}\n${JSON.stringify({ command: { type: "reload_widget" } })}\n`);
    emitBootstrapStateToRenderer();
    emitProjectSwitchProgress({ active: false, stage: "ready" });
    return true;
  })().catch((error) => { emitProjectSwitchProgress({ active: false, stage: "error", message: error instanceof Error ? error.message : String(error) }); return false; }).finally(() => { projectSwitchInFlight = null; });
  return projectSwitchInFlight;
}

async function clearActiveProject(options: { confirmRuntimeStop?: boolean; progressMessage?: string } = {}): Promise<boolean> {
  if (!activeProjectId) {
    activeChatId = null;
    return true;
  }
  if (projectSwitchInFlight) return projectSwitchInFlight;
  projectSwitchInFlight = (async () => {
    const runtimeTransition = await stopRuntimeForProjectTransition(options.confirmRuntimeStop ?? true);
    if (runtimeTransition === "cancelled") return false;
    if (runtimeTransition === "stopped") {
      emitProjectSwitchProgress({ active: true, stage: "switching", message: options.progressMessage ?? "Starting a new chat…" });
    }
    performSessionCleanup({ clearWorkspace: true });
    activeProjectId = null;
    activeChatId = null;
    workspaceRoot = null;
    emitBootstrapStateToRenderer();
    if (runtimeTransition === "stopped") {
      emitProjectSwitchProgress({ active: false, stage: "ready" });
    }
    return true;
  })().catch((error) => { emitProjectSwitchProgress({ active: false, stage: "error", message: error instanceof Error ? error.message : String(error) }); return false; }).finally(() => { projectSwitchInFlight = null; });
  return projectSwitchInFlight;
}

function emitBootstrapStateToRenderer(): void {
  sendToRenderer(IPCChannels.bootstrapStateChanged, getBootstrapState());
}

function isDirectoryEmpty(directoryPath: string): boolean {
  const entries = fs.readdirSync(directoryPath);
  return entries.length === 0;
}

let agentEventEmitter: ((event: AgentEvent) => void) | null = null;

interface MachineMcpQuestionPending {
  resolve: (answer: { host: string; deviceId?: string } | null) => void;
  machines: MachineMcpQuestionMachine[];
}

let machineMcpQuestionPending: MachineMcpQuestionPending | null = null;

interface AgentQuestionPending {
  questionId: string;
  prompt: AgentQuestionPrompt;
  resolve: (answer: string | null) => void;
}

let agentQuestionPending: AgentQuestionPending | null = null;

type MachineMcpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type MachineMcpSession = {
  url: string;
  host: string;
  deviceId?: string;
  protocolVersion: string;
  tools: MachineMcpToolInfo[];
};

let machineMcpSession: MachineMcpSession | null = null;
let machineMcpRequestId = 1;

function cancelPendingAgentInput(): void {
  if (machineMcpQuestionPending) {
    const { resolve } = machineMcpQuestionPending;
    machineMcpQuestionPending = null;
    agentEventEmitter?.({ type: "machine_mcp_prompt", at: Date.now(), visible: false });
    resolve(null);
  }
  if (agentQuestionPending) {
    const { questionId, resolve } = agentQuestionPending;
    agentQuestionPending = null;
    agentEventEmitter?.({ type: "agent_question", questionId, visible: false, question: "" });
    resolve(null);
  }
}

async function askUserQuestionForAgent(prompt: AgentQuestionPrompt): Promise<string | null> {
  if (agentQuestionPending) {
    return null;
  }
  const questionId = randomUUID();
  agentEventEmitter?.({ type: "agent_question", questionId, visible: true, ...prompt });
  return await new Promise((resolve) => {
    agentQuestionPending = { questionId, prompt, resolve };
  });
}

/**
 * Waits for the prompt handler's finalizer, which finishes the backend Dartsnut LLM run
 * before settling the coordinator lease. Used by both the Stop control and app shutdown.
 */
async function stopActiveAgentRun(reason: "user_stop" | "app_quit"): Promise<boolean> {
  cancelPendingAgentInput();
  terminalAgentLifecycleLog("[agent] cancellation requested", {
    reason,
    hasActiveRun: sendPromptCoordinator.hasActiveRun(),
    hasBridgeRun: Boolean(activeDartsnutLlmBridgeRun)
  });
  // Prompt finalizer closes backend run after SDK fetch has observed abort. Finishing in
  // parallel races the still-active Responses request and can make backend cleanup return 503.
  const cancelled = await sendPromptCoordinator.cancelAndWait(reason);
  return cancelled;
}

function applyWorkspaceRoot(selectedPath: string): void {
  if (workspaceRoot && workspaceRoot !== selectedPath) {
    performSessionCleanup({ clearWorkspace: false });
  }
  workspaceRoot = selectedPath;
  if (!bridgeProcess || bridgeProcess.stdin?.destroyed) {
    startPythonBridge();
  }
  if (bridgeProcess?.stdin && !bridgeProcess.stdin.destroyed) {
    bridgeProcess.stdin.write(
      `${JSON.stringify({ command: { type: "set_path", path: selectedPath } satisfies EmulatorCommand })}\n`,
    );
    clearEmulatorLogsForReload();
    beginPendingEmulatorSwitch(selectedPath);
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

function normalizeMachineHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[/?#\s]/.test(trimmed)) {
    return null;
  }
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const host = withoutProtocol.replace(/\/+$/, "");
  if (!host || /[/?#\s]/.test(host)) {
    return null;
  }
  return host;
}

function machineMcpUrlForHost(host: string): string {
  const hasPort = /:\d+$/.test(host);
  return `http://${hasPort ? host : `${host}:9252`}/mcp`;
}

async function fetchMachineMcpQuestionMachines(): Promise<MachineMcpQuestionMachine[]> {
  const auth = readCommunityAuth(getCommunityUserDataPath());
  if (!auth?.token) {
    return [];
  }
  const result = await getCommunityClient().listDeployDevices(auth.token);
  if (!result.ok) {
    if (result.code === "session_expired") {
      clearCommunityAuth(getCommunityUserDataPath());
    }
    return [];
  }
  return result.devices
    .filter((device) => normalizeMachineHost(device.ipAddress) !== null)
    .map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      model: device.model,
      ipAddress: device.ipAddress,
      ssid: device.ssid,
      updatedAt: device.updatedAt
    }));
}

async function askMachineForMcp(): Promise<{ host: string; deviceId?: string } | null> {
  if (machineMcpQuestionPending) {
    return null;
  }
  const machines = await fetchMachineMcpQuestionMachines();
  agentEventEmitter?.({
    type: "machine_mcp_prompt",
    at: Date.now(),
    visible: true,
    machines,
    manualOnly: machines.length === 0
  });
  return await new Promise((resolve) => {
    machineMcpQuestionPending = { resolve, machines };
  });
}

async function machineMcpJsonRpc(url: string, method: string, params?: unknown): Promise<unknown> {
  const id = machineMcpRequestId++;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params })
    })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text) as { result?: unknown; error?: { message?: string; code?: number } };
  if (data.error) {
    throw new Error(data.error.message || `MCP JSON-RPC error ${data.error.code ?? ""}`.trim());
  }
  return data.result;
}

function normalizeMachineMcpTools(result: unknown): MachineMcpToolInfo[] {
  const rawTools =
    result && typeof result === "object" && Array.isArray((result as { tools?: unknown }).tools)
      ? (result as { tools: unknown[] }).tools
      : [];
  return rawTools
    .map((toolInfo) => {
      if (!toolInfo || typeof toolInfo !== "object") {
        return null;
      }
      const record = toolInfo as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) {
        return null;
      }
      return {
        name,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(record.inputSchema !== undefined ? { inputSchema: record.inputSchema } : {})
      };
    })
    .filter((toolInfo): toolInfo is MachineMcpToolInfo => toolInfo !== null);
}

async function connectMachineMcp(force = false): Promise<MachineMcpSession> {
  if (machineMcpSession && !force) {
    return machineMcpSession;
  }
  const selected = await askMachineForMcp();
  if (!selected) {
    throw new Error("Machine selection was cancelled.");
  }
  const url = machineMcpUrlForHost(selected.host);
  const initialized = await machineMcpJsonRpc(url, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dartsnut-agent-desktop", version: app.getVersion() }
  });
  const protocolVersion =
    initialized && typeof initialized === "object" && typeof (initialized as { protocolVersion?: unknown }).protocolVersion === "string"
      ? (initialized as { protocolVersion: string }).protocolVersion
      : "2024-11-05";
  const tools = normalizeMachineMcpTools(await machineMcpJsonRpc(url, "tools/list"));
  machineMcpSession = {
    url,
    host: selected.host,
    ...(selected.deviceId ? { deviceId: selected.deviceId } : {}),
    protocolVersion,
    tools
  };
  return machineMcpSession;
}

async function executeMachineMcpForAgent(args: Record<string, unknown>): Promise<string> {
  const action = typeof args.action === "string" ? args.action : "";
  try {
    if (action === "connect") {
      const session = await connectMachineMcp(args.force === true);
      return JSON.stringify({
        ok: true,
        connected: true,
        url: session.url,
        host: session.host,
        deviceId: session.deviceId,
        tools: session.tools
      });
    }
    if (action === "list_tools") {
      const session = await connectMachineMcp(false);
      session.tools = normalizeMachineMcpTools(await machineMcpJsonRpc(session.url, "tools/list"));
      return JSON.stringify({ ok: true, tools: session.tools });
    }
    if (action === "call_tool") {
      const session = await connectMachineMcp(false);
      const toolName = typeof args.tool_name === "string" ? args.tool_name.trim() : "";
      if (!toolName) {
        return JSON.stringify({ ok: false, error: "tool_name is required for call_tool." });
      }
      if (!session.tools.some((toolInfo) => toolInfo.name === toolName)) {
        return JSON.stringify({ ok: false, error: `Unknown MCP tool: ${toolName}. Call list_tools first.` });
      }
      const result = await machineMcpJsonRpc(session.url, "tools/call", {
        name: toolName,
        arguments:
          args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
            ? args.arguments
            : {}
      });
      return JSON.stringify({ ok: true, result });
    }
    if (action === "disconnect") {
      machineMcpSession = null;
      return JSON.stringify({ ok: true, connected: false });
    }
    return JSON.stringify({ ok: false, error: "action must be connect, list_tools, call_tool, or disconnect." });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function buildAssetApplierPrompt(request: PromptRequest): string {
  const apply = request.assetApply ?? { slotIds: [], projectType: "game" };
  const slotIds = Array.isArray(apply.slotIds) ? apply.slotIds : [];
  const workspacePath = request.workspacePath ?? workspaceRoot ?? "";
  const directives = [
    `Asset apply context: ${apply.projectType} project at ${workspacePath}.`,
    `Changed slot ids: ${slotIds.length > 0 ? slotIds.join(", ") : "(none)"}.`
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
  let templateMode: "game-creator" | "widget-creator" | undefined =
    request.templateMode === "game-creator" || request.templateMode === "widget-creator"
      ? request.templateMode
      : undefined;
  let projectType = request.projectType;
  let widgetSize = request.widgetSize;

  const hints =
    effectiveWorkspacePath && fs.existsSync(effectiveWorkspacePath)
      ? readWorkspaceCreatorHints(effectiveWorkspacePath)
      : null;
  ({ templateMode, projectType, widgetSize } = resolveCreatorRouting(
    { templateMode, projectType, widgetSize },
    hints
  ));

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
  const existing = candidates.find((dir) => fs.existsSync(path.join(dir, "dartsnut-core.md")));
  if (!existing) {
    throw new Error(`Skill directory not found (expected dartsnut-core.md); tried: ${candidates.join(", ")}`);
  }
  return existing;
}

function resolveSkillSessionContext(
  templateMode?: PromptRequest["templateMode"] | null
): {
  skillLibrary: { skillsDir: string; allowedIds: ReturnType<typeof allowedDeferredSkillIdsForMode> };
} {
  const skillsDir = resolveAgentRuntimeSkillsDir();
  return {
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
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  try {
    win.webContents.send(channel, ...(args as [unknown, ...unknown[]]));
  } catch (error) {
    // Window teardown can race with async startup/runtime events.
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return;
    }
    throw error;
  }
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
  appendDevFileLog("log", message, meta ?? {});
  mirrorMainProcessConsole({ level: "log", prefix: "", message: line });
}

function logAgentEventToConsole(event: AgentEvent, mirrorToDevtools: boolean): void {
  if (!isDevLoggingEnabled()) {
    return;
  }
  if (event.type === "raw_model_stream_event") {
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
type ResolvedShellUiTheme = Exclude<ShellUiTheme, "system">;

/** Keep Windows caption controls readable over the renderer's transparent floating header. */
const WINDOWS_SHELL_UI: Record<
  ResolvedShellUiTheme,
  { titleBarColor: string; symbolColor: string; windowBackground: string }
> = {
  dark: {
    titleBarColor: "#00000000",
    symbolColor: "#e0e0e0",
    windowBackground: "#161210"
  },
  light: {
    titleBarColor: "#00000000",
    symbolColor: "#1a2332",
    windowBackground: "#ffffff"
  }
};

function applyWindowsShellUiTheme(theme: ResolvedShellUiTheme): void {
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

function applyShellUiTheme(theme: ShellUiTheme): void {
  nativeTheme.themeSource = theme;
  applyWindowsShellUiTheme(nativeTheme.shouldUseDarkColors ? "dark" : "light");
}

nativeTheme.on("updated", () => {
  applyWindowsShellUiTheme(nativeTheme.shouldUseDarkColors ? "dark" : "light");
});

async function syncShellUiThemeFromDomSnapshot(): Promise<void> {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    const preference = await win.webContents.executeJavaScript(
      `(function () {
        try {
          var stored = localStorage.getItem("dartsnut-theme");
          if (stored === "system" || stored === "light" || stored === "dark") return stored;
        } catch (e) {}
        return "system";
      })()`,
      true
    );
    applyShellUiTheme(
      preference === "light" || preference === "dark" || preference === "system"
        ? preference
        : "system"
    );
  } catch {
    applyShellUiTheme("system");
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
  emulatorSwitchGate = null;
  pendingEmulatorPathForReload = null;
  latestEmulatorFrame = null;
  previousAgentObservationSurfaceHash = null;
  agentDartSlots = Array.from({ length: 12 }, () => [-1, -1]);
  emulatorState.widgetPath = null;
  emulatorState.widgetId = null;
  emulatorState.widgetType = null;
  emulatorState.running = false;
  emulatorState.gifRecording = false;
  emulatorState.gifSaving = false;
  emulatorState.gifElapsedMs = 0;
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
    writeEmulatorState();
  }
  sendToRenderer(IPCChannels.sessionReset);
  emitEmulatorState();
}

function emitEmulatorState() {
  sendToRenderer(EMULATOR_IPC_CHANNELS.emulatorState, emulatorState);
}

function applyEmulatorStateSnapshot(nextState: EmulatorStateSnapshot): void {
  copyEmulatorStateSnapshot(emulatorState, nextState);
}

function beginPendingEmulatorSwitch(targetWidgetPath: string): void {
  if (!targetWidgetPath) {
    return;
  }
  const pending = beginEmulatorSwitch(targetWidgetPath, emulatorState);
  emulatorSwitchGate = pending.gate;
  applyEmulatorStateSnapshot(pending.stateForRenderer);
  emitEmulatorState();
}

function emitEmulatorFrame(frame: EmulatorFrame) {
  latestEmulatorFrame = frame;
  const gated = handleEmulatorSwitchFrame(emulatorSwitchGate, frame);
  emulatorSwitchGate = gated.gate;
  if (gated.state) {
    applyEmulatorStateSnapshot(gated.state);
    emitEmulatorState();
  }
  if (gated.frame) {
    sendToRenderer(EMULATOR_IPC_CHANNELS.emulatorFrame, gated.frame);
  }
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
        const incomingState: EmulatorStateSnapshot = {
          widgetPath:
            typeof payload.widgetPath !== "undefined"
              ? payload.widgetPath ?? null
              : emulatorState.widgetPath,
          widgetId:
            typeof payload.widgetId !== "undefined"
              ? payload.widgetId ?? null
              : emulatorState.widgetId,
          widgetType:
            typeof payload.widgetType !== "undefined"
              ? payload.widgetType ?? null
              : emulatorState.widgetType,
          running: typeof payload.running === "boolean" ? payload.running : emulatorState.running,
          fps: typeof payload.fps === "number" ? payload.fps : emulatorState.fps,
          status: typeof payload.status === "string" ? payload.status : emulatorState.status,
          audioMuted: typeof payload.audioMuted === "boolean" ? payload.audioMuted : emulatorState.audioMuted,
          lastError:
            typeof payload.lastError !== "undefined"
              ? payload.lastError
              : emulatorState.lastError,
          lastCapturePath:
            typeof payload.lastCapturePath !== "undefined"
              ? payload.lastCapturePath ?? null
              : emulatorState.lastCapturePath,
          gifRecording:
            typeof payload.gifRecording === "boolean"
              ? payload.gifRecording
              : emulatorState.gifRecording ?? false,
          gifSaving:
            typeof payload.gifSaving === "boolean"
              ? payload.gifSaving
              : emulatorState.gifSaving ?? false,
          gifElapsedMs:
            typeof payload.gifElapsedMs === "number"
              ? payload.gifElapsedMs
              : emulatorState.gifElapsedMs ?? 0,
        };
        const gated = handleEmulatorSwitchState(emulatorSwitchGate, incomingState, emulatorState);
        emulatorSwitchGate = gated.gate;
        applyEmulatorStateSnapshot(gated.state);
        emitEmulatorState();
      } catch {
        emulatorState.status = jsonLine.trim();
        emitEmulatorState();
      }
    }
  });

  bridgeProcess.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    emulatorSwitchGate = null;
    pendingEmulatorPathForReload = null;
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
    emulatorSwitchGate = null;
    pendingEmulatorPathForReload = null;
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
  if (!shouldAttachAgentSessionPersistence(workspaceForSession) || !activeChatId) {
    return undefined;
  }
  return getProjectStore().sessionPersistence(activeChatId);
}

async function buildSession(
  templateMode: PromptRequest["templateMode"] | undefined,
  extras?: {
    workspacePath?: string;
    toolSchemas?: typeof AGENT_TOOL_SCHEMAS;
    chatMediaAttachments?: PromptRequest["chatMediaAttachments"];
    skipInitialWorkspaceResolve?: boolean;
    skillBundleMode?: PromptRequest["templateMode"] | null;
    sessionPersistence?: AgentSessionPersistence;
    initialItems?: AgentInputItem[];
    originalUserPrompt?: string;
    projectType?: ProjectType;
    widgetSize?: WidgetSize;
    assetApplierMode?: boolean;
    agentModelConfig?: AgentModelConfig;
    agentProfileId?: AgentProfileId | null;
  }
): Promise<AgentSessionRuntime> {
  const workspacePath = extras?.workspacePath ?? workspaceRoot;
  if (!workspacePath) {
    throw new Error("Workspace is not selected.");
  }
  const agentModelConfig = extras?.agentModelConfig ?? buildAgentModelConfigFromProviderSettings(readProviderSettings());
  const skillBundleMode =
    extras?.skillBundleMode !== undefined ? extras.skillBundleMode : templateMode ?? null;
  const { skillLibrary } = resolveSkillSessionContext(skillBundleMode);
  const engine = new SessionEngine({
    agentModelConfig,
    workspacePolicy: new WorkspacePolicy(workspacePath),
    skillLibrary,
    agentProfileId: extras?.agentProfileId ?? extras?.sessionPersistence?.readAgentProfileId() ?? "export",
    assetRoots: {
      widgetFonts: path.join(repoRoot, "assets", "fonts", "widgets"),
      chatAttachments: extras?.chatMediaAttachments
    },
    toolSchemas: extras?.toolSchemas,
    hostReloadEmulatorHandler: (args) => executeHostReloadEmulatorForAgent(args),
    hostGetEmulatorLogsHandler: (args) => Promise.resolve(executeHostGetEmulatorLogsForAgent(args)),
    hostCheckPythonHandler: (args) => Promise.resolve(executeHostCheckPythonForAgent(args)),
    hostMachineMcpHandler: (args) => executeMachineMcpForAgent(args),
    hostObserveEmulatorHandler: (args) => executeHostObserveEmulatorForAgent(args),
    hostControlEmulatorInputHandler: (args) => executeHostControlEmulatorInputForAgent(args),
    hostRunEmulatorScenarioHandler: (args) => executeHostRunEmulatorScenarioForAgent(args),
    hostPixelLabGenerateHandler: (args) => {
      const auth = readCommunityAuth(getCommunityUserDataPath());
      if (!auth?.token) {
        return Promise.resolve(JSON.stringify({
          ok: false,
          code: "AUTH_REQUIRED",
          error: "Sign in to your Dartsnut account to use PixelLab generation."
        }));
      }
      return executePixelLabGenerationForAgent({
        args,
        workspacePath,
        baseApi: getCommunityClient().getConfig().baseApi,
        token: auth.token,
        fetchImpl: cloudFetch()
      });
    },
    askUserQuestionHandler: (prompt) => askUserQuestionForAgent(prompt),
    skipInitialWorkspaceResolve: extras?.skipInitialWorkspaceResolve,
    sessionPersistence: extras?.sessionPersistence,
    initialItems: extras?.initialItems,
    sessionTemplateMode: templateMode ?? null,
    sessionSection: skillBundleMode === null ? null : String(skillBundleMode),
    runContextSeed: {
      skillsDir: resolveAgentRuntimeSkillsDir(),
      projectType: extras?.projectType,
      widgetSize: extras?.widgetSize,
      templateMode: templateMode ?? skillBundleMode ?? null,
      assetApplierMode: extras?.assetApplierMode ?? templateMode === "asset-applier",
      originalUserPrompt: extras?.originalUserPrompt,
      agentProfileId: extras?.agentProfileId ?? extras?.sessionPersistence?.readAgentProfileId() ?? "export"
    },
    onDiagnostic: (message, meta) => terminalAgentLifecycleLog(`[agent] ${message}`, meta)
  });
  return new AgentSessionRuntime({
    workspacePath,
    engine
  });
}

async function createWindow() {
  recordStartupDiagnostic("window-create");
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
    show: false,
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
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      recordStartupDiagnostic("did-fail-load", { errorCode, errorDescription, validatedURL });
      if (rendererRecoveryReloads < 1 && win && !win.isDestroyed()) {
        rendererRecoveryReloads += 1;
        void win.webContents.reloadIgnoringCache();
      }
    }
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    recordStartupDiagnostic("preload-error", { preloadPath, error });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    recordStartupDiagnostic("render-process-gone", details);
    if (rendererRecoveryReloads < 1 && win && !win.isDestroyed()) {
      rendererRecoveryReloads += 1;
      void win.webContents.reloadIgnoringCache();
    }
  });
  win.webContents.on("unresponsive", () => recordStartupDiagnostic("unresponsive"));
  win.webContents.on("responsive", () => recordStartupDiagnostic("responsive"));
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) recordStartupDiagnostic("renderer-console", { level, message, line, sourceId });
  });
  win.webContents.on("did-finish-load", () => {
    recordStartupDiagnostic("document-loaded");
    if (!startupShown && win && !win.isDestroyed()) {
      startupShown = true;
      win.show();
    }
    void syncShellUiThemeFromDomSnapshot().catch(() => {
      /* Theme sync uses executeJavaScript; failures are non-fatal. */
    });
    emitChromeInsetsAndPushStyles();
    setTimeout(emitChromeInsetsAndPushStyles, 50);
    setTimeout(emitChromeInsetsAndPushStyles, 300);
  });
  setTimeout(() => {
    if (!startupShown && win && !win.isDestroyed()) {
      recordStartupDiagnostic("startup-visibility-timeout");
      startupShown = true;
      win.show();
    }
  }, 2500);
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  win.on("close", () => {
    devLog.info("[quit] win.close fired", { t: Date.now() });
    persistWindowState();
  });
  win.on("closed", () => {
    devLog.info("[quit] win.closed fired", { t: Date.now() });
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
    terminalAgentLifecycleLog("[dev-log] writing agent diagnostics", { path: getDevLogPath() });
    desktopNetwork = await initializeDesktopNetwork(session.defaultSession, {
      onDiagnostic: (diagnostic) => {
        console.info("[network] system proxy", diagnostic);
      },
      onError: (error) => {
        console.warn("[network] system proxy initialization or resolution failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    recordStartupDiagnostic("proxy-ready");
    try {
      await configureSystemProxySession(session.fromPartition("electron-updater", { cache: false }));
    } catch (error) {
      console.warn("[network] updater system proxy initialization failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await createWindow();
    startAppUpdateCheck(sendToRenderer);
    setPythonRuntimeProgress({
      running: true,
      stage: "check",
      percent: 0,
      message: "Checking runtime..."
    });
    devLog.info("[runtime] Starting runtime initialization");
    recordStartupDiagnostic("runtime-initialization-started");
    const runtime = await ensureRuntime(
      runtimeDir(),
      path.join(repoRoot, "requirements.txt"),
      (progress) => {
        setPythonRuntimeProgressFromDownload(progress);
        devLog.info("[runtime] Progress", { stage: progress.stage, percent: progress.percent });
      },
      { fetchImpl: cloudFetch() }
    );

    pythonExec = runtime.pythonPath;
    recordStartupDiagnostic("runtime-initialization-finished");
    devLog.info("[runtime] Runtime ready", { pythonPath: pythonExec, uvPath: runtime.uvPath });

    setPythonRuntimeStatus(null);
    setPythonRuntimeProgress({
      running: false,
      stage: "complete",
      percent: 100,
      message: "Runtime ready"
    });

    projectStore = new ProjectStore(app.getPath("userData"));
    const previousChat = projectStore.lastOpenedChat();
    const previousProject = previousChat ? projectStore.getProject(previousChat.projectId) : null;
    if (previousProject) {
      await switchToProject(previousProject.id);
    }
    if (workspaceRoot) startPythonBridge();
    emitBootstrapStateToRenderer();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[startup] initialization failed", error);
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

let quitCleanupComplete = false;
let quitCleanupRequitScheduled = false;
const runQuitCleanup = createShutdownCleanupRunner(
  () => [
    { name: "agent", run: () => stopActiveAgentRun("app_quit") },
    { name: "emulator", run: () => gracefulStopEmulatorBridge(3000, { permanent: true }) },
    { name: "deploy", run: () => restoreDeployMachineForQuit() },
  ],
  ({ name, reason }) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    devLog.warn(`[quit] ${name} cleanup failed`, message);
  },
);

app.on("before-quit", (event) => {
  devLog.info("[quit] before-quit fired", { t: Date.now(), cleanupComplete: quitCleanupComplete });
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide();
  }
  assetManager.stop();
  stopDeployConfWatcher();
  if (isAppUpdateInstallRequested()) {
    quitCleanupComplete = true;
    return;
  }
  if (quitCleanupComplete) {
    return;
  }
  const hasAsyncCleanup = sendPromptCoordinator.hasActiveRun() || !!bridgeProcess || !!deployMachineSession?.connected;
  if (!hasAsyncCleanup) {
    quitCleanupComplete = true;
    return;
  }
  event.preventDefault();
  if (!quitCleanupRequitScheduled) {
    quitCleanupRequitScheduled = true;
    devLog.info("[quit] starting concurrent cleanup", { t: Date.now() });
    void runQuitCleanup().finally(() => {
      quitCleanupComplete = true;
      devLog.info("[quit] cleanup complete, re-quitting", { t: Date.now() });
      app.quit();
    });
  }
});

app.on("will-quit", () => {
  devLog.info("[quit] will-quit fired", { t: Date.now() });
  stopPythonBridgeProcess();
  assetManager.stop();
  stopDeployConfWatcher();
  void disconnectDeployMachine();
});

ipcMain.handle(IPCChannels.rendererReady, () => {
  recordStartupDiagnostic("renderer-ready");
  if (!startupShown && win && !win.isDestroyed()) {
    startupShown = true;
    win.show();
  }
});

ipcMain.handle(IPCChannels.reportRendererError, (_event: unknown, payload: RendererErrorPayload) => {
  recordStartupDiagnostic("renderer-error", {
    source: payload?.source,
    message: payload?.message,
    stack: payload?.stack
  });
});

ipcMain.handle(IPCChannels.openStartupLogs, async () => {
  await shell.openPath(path.dirname(startupLogPath()));
});

ipcMain.handle(IPCChannels.copyStartupDiagnostics, () => {
  clipboard.writeText(startupDiagnosticsText());
});

ipcMain.handle(IPCChannels.resetRendererState, async () => {
  if (!win || win.isDestroyed()) return;
  await win.webContents.executeJavaScript(`(() => {
    for (const key of ["dartsnut-theme", "dartsnut-analytics-enabled", "dartsnut-chat-pane-width", "dartsnut-chat-pane-ratio", "dartsnut-workspace-menu-width", "dartsnut-workspace-menu-collapsed"]) localStorage.removeItem(key);
    sessionStorage.clear();
  })()`);
  await win.webContents.reload();
});

ipcMain.handle(IPCChannels.restartWithoutGpu, () => {
  if (process.argv.includes("--disable-gpu")) return;
  recordStartupDiagnostic("gpu-safe-restart-requested");
  app.relaunch({ args: [...process.argv.slice(1), "--disable-gpu"] });
  app.quit();
});

ipcMain.handle(IPCChannels.windowChromeInsets, (): WindowChromeInsets => {
  if (!win || win.isDestroyed()) {
    return { top: 0, left: 0, right: 0, bottom: 0 };
  }
  return computeWindowChromeInsets(win);
});

ipcMain.handle(IPCChannels.shellUiTheme, (_event: unknown, theme: unknown): void => {
  if (theme === "system" || theme === "light" || theme === "dark") {
    applyShellUiTheme(theme);
  }
});

ipcMain.handle(IPCChannels.appUpdateStatus, (): AppUpdateStatus => getAppUpdateStatus());
ipcMain.handle(IPCChannels.appUpdateAutoDownload, (): boolean => getAutoUpdateEnabled());
ipcMain.handle(IPCChannels.appUpdateSetAutoDownload, (_event: unknown, enabled: unknown): boolean =>
  setAutoUpdateEnabled(enabled === true)
);
ipcMain.handle(IPCChannels.appUpdateDownload, (): Promise<AppUpdateDownloadResponse> =>
  downloadAvailableAppUpdate()
);
ipcMain.handle(IPCChannels.appUpdateCheck, (): Promise<AppUpdateCheckResponse> =>
  checkForAppUpdate()
);
ipcMain.handle(IPCChannels.appUpdateInstallNow, async (): Promise<AppUpdateInstallResponse> => {
  if (!isDownloadedAppUpdateReady() || !installDownloadedAppUpdate()) {
    return { ok: false, reason: "not_ready" };
  }
  return { ok: true };
});

ipcMain.handle(IPCChannels.bootstrapState, () => getBootstrapState());

ipcMain.handle(IPCChannels.projectsList, () => projectTree());
ipcMain.handle(IPCChannels.projectCreate, async (_event: unknown, request: ProjectCreateRequest) => {
  const store = getProjectStore();
  const project = store.ensureProject(request.folderPath, request.name);
  const agentProfileId = request.agentProfileId ? normalizeAgentProfileId(request.agentProfileId) : null;
  const chat = agentProfileId ? store.createChat(project.id) : null;
  if (chat && agentProfileId) {
    try {
      store.sessionPersistence(chat.id).setAgentProfileId(agentProfileId);
    } catch (error) {
      store.archiveChat(chat.id);
      throw error;
    }
  }
  const accepted = await switchToProject(project.id, chat?.id);
  if (!accepted) {
    if (chat) store.archiveChat(chat.id);
    throw new Error("Project creation was cancelled.");
  }
  return { state: getBootstrapState(), tree: projectTree() };
});
ipcMain.handle(IPCChannels.projectRemove, async (_event: unknown, projectId: string) => {
  const store = getProjectStore();
  const project = store.getProject(projectId);
  if (!project) throw new Error("Project does not exist.");
  if (sendPromptCoordinator.hasActiveRun()) throw new Error("Wait for the active agent request to finish.");
  if (projectSwitchInFlight) throw new Error("Wait for the current project switch to finish.");
  if (activeProjectId === project.id) {
    const cleared = await clearActiveProject({
      confirmRuntimeStop: false,
      progressMessage: "Removing local project…"
    });
    if (!cleared) throw new Error("Could not stop the active project.");
  }
  if (!store.removeProject(project.id)) throw new Error("Project does not exist.");
  emitBootstrapStateToRenderer();
  return { state: getBootstrapState(), tree: projectTree() };
});
ipcMain.handle(IPCChannels.projectSelect, async (_event: unknown, request: ProjectSelectRequest) => {
  if (request.projectId === null) {
    const accepted = await clearActiveProject();
    return { state: getBootstrapState(), tree: projectTree(), accepted };
  }
  const accepted = await switchToProject(request.projectId, request.chatId);
  return { state: getBootstrapState(), tree: projectTree(), accepted };
});
ipcMain.handle(IPCChannels.chatCreate, async (_event: unknown, request: ChatCreateRequest) => {
  const store = getProjectStore();
  const project = store.getProject(request.projectId);
  if (!project) throw new Error("Project does not exist.");
  if (activeProjectId !== project.id) throw new Error("Project is not active.");
  const agentProfileId = normalizeAgentProfileId(request.agentProfileId);
  const chat = store.createChat(project.id);
  try {
    store.sessionPersistence(chat.id).setAgentProfileId(agentProfileId);
  } catch (error) {
    store.archiveChat(chat.id);
    throw error;
  }
  const accepted = await switchToProject(project.id, chat.id);
  if (!accepted) throw new Error("Could not start chat.");
  return { state: getBootstrapState(), tree: projectTree() };
});
ipcMain.handle("agent:chat-archive", (_event: unknown, chatId: string) => {
  const store = getProjectStore();
  const chat = store.archiveChat(chatId);
  if (!chat) throw new Error("Chat does not exist.");
  if (activeChatId === chat.id) {
    activeChatId = null;
    emitBootstrapStateToRenderer();
  }
  return { state: getBootstrapState(), tree: projectTree() };
});
ipcMain.handle("agent:chat-generate-title", async (_event: unknown, request: { chatId: string; firstUserMessage: string; fallbackOnly?: boolean }) => {
  const store = getProjectStore();
  const chat = store.getChat(request.chatId);
  if (!chat || chat.archivedAt || chat.title !== "New chat") {
    return { tree: projectTree(), updated: false };
  }
  if (request.fallbackOnly) {
    const updated = store.updateDefaultChatTitle(request.chatId, fallbackChatTitle(request.firstUserMessage));
    return { tree: projectTree(), updated: Boolean(updated) };
  }
  const titleLease = await chatTitleCoordinator.begin();
  let title = fallbackChatTitle(request.firstUserMessage);
  let bridgeRun: DartsnutLlmBridgeRun | null = null;
  try {
    const prepared = await prepareAgentProvider(readProviderSettings());
    if (prepared.ok) {
      bridgeRun = prepared.bridgeRun;
      try {
        title = await generateChatTitle(prepared.modelConfig, request.firstUserMessage, titleLease.abortController.signal);
      } catch {
        // Deterministic fallback already selected.
      }
    }
  } catch {
    // Title generation must not affect the completed agent request.
  } finally {
    try {
      await bridgeRun?.finish("title_finalizer");
    } catch {
      // Keep deterministic fallback available even when bridge cleanup fails.
    }
    titleLease.settle();
  }
  const updated = store.updateDefaultChatTitle(request.chatId, title);
  return { tree: projectTree(), updated: Boolean(updated) };
});
ipcMain.handle(IPCChannels.chatSelect, async (_event: unknown, chatId: string) => {
  const store = getProjectStore(); const chat = store.getChat(chatId);
  if (!chat || chat.archivedAt) throw new Error("Chat does not exist.");
  const accepted = await switchToProject(chat.projectId, chat.id);
  return { state: getBootstrapState(), tree: projectTree(), accepted };
});

ipcMain.handle(IPCChannels.getWorkspaceSessionSummary, (
  _event: unknown,
  requestedChatId?: unknown
): AgentSessionWorkspaceSummary => {
  const ws = workspaceRoot;
  const summaryChatId = typeof requestedChatId === "string" ? requestedChatId : activeChatId;
  const chat = summaryChatId ? getProjectStore().getChat(summaryChatId) : null;
  if (!ws || !shouldAttachAgentSessionPersistence(ws) || !chat || chat.archivedAt) {
    return {
      chatId: null,
      hasPersistedSession: false,
      sessionId: null,
      updatedAt: null,
      templateMode: null,
      transcriptTail: [],
      tokenUsage: null,
      agentProfileId: null
    };
  }
  const persistence = getProjectStore().sessionPersistence(chat.id);
  persistence.readConversationItems();
  const manifest = persistence.readManifest();
  return {
    chatId: chat.id,
    hasPersistedSession: persistence.hasPersistedSession(),
    sessionId: manifest?.sessionId ?? null,
    updatedAt: manifest?.updatedAt ?? null,
    templateMode: manifest?.templateMode ?? null,
    transcriptTail: persistence.readTranscriptTail(200),
    tokenUsage: persistence.readTokenUsage(),
    agentProfileId: persistence.readAgentProfileId()
  };
});

ipcMain.handle(
  IPCChannels.resetWorkspaceSession,
  (): { ok: true } | { ok: false; reason: "no_workspace" | "persistence_disabled" } => {
    const ws = workspaceRoot;
    if (!ws) {
      return { ok: false, reason: "no_workspace" };
    }
    const persistence = activeChatId ? getProjectStore().sessionPersistence(activeChatId) : buildWorkspaceSessionPersistence(ws);
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
    communityClientSingleton = createCommunityClient(process.env, cloudFetch());
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
    analyticsUserId: auth?.analyticsUserId ?? null,
    authMethod: auth?.authMethod ?? null,
    hasSupabase: config.hasSupabase,
    googleClientId: config.googleClientId,
    googleDesktopClientId: config.googleDesktopClientId,
    googleSignInAvailable: Boolean(config.googleDesktopClientId)
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
      writeCommunityAuth(getCommunityUserDataPath(), {
        token: result.token,
        account: result.account,
        analyticsUserId: result.analyticsUserId,
        authMethod: "password"
      });
      return { ok: true, account: result.account, needsPasswordSetup: false };
    }
    if (request.method === "googleOAuth") {
      const config = client.getConfig();
      communityGoogleLoginAbortController?.abort();
      const loginAbort = new AbortController();
      communityGoogleLoginAbortController = loginAbort;
      try {
        const oauthResult = await signInWithGoogleOAuth({
          clientId: config.googleDesktopClientId,
          clientSecret: config.googleDesktopClientSecret,
          openExternal: (url) => shell.openExternal(url),
          fetchImpl: cloudFetch(),
          signal: loginAbort.signal
        });
        if (!oauthResult.ok) {
          return { ok: false, code: oauthResult.code, message: oauthResult.message };
        }
        const result = await client.loginWithGoogleIdToken(oauthResult.idToken, loginAbort.signal);
        if (loginAbort.signal.aborted) {
          return { ok: false, code: "cancelled", message: "Google sign-in was cancelled." };
        }
        if (!result.ok) {
          return { ok: false, code: result.code, message: result.message };
        }
        writeCommunityAuth(getCommunityUserDataPath(), {
          token: result.token,
          account: result.account,
          analyticsUserId: result.analyticsUserId,
          authMethod: "google"
        });
        return { ok: true, account: result.account, needsPasswordSetup: result.needsPasswordSetup };
      } finally {
        if (communityGoogleLoginAbortController === loginAbort) {
          communityGoogleLoginAbortController = null;
        }
      }
    }
    const idToken = String(request.idToken || "").trim();
    if (!idToken) {
      return { ok: false, code: "invalid_credentials", message: "Google sign-in did not return a token." };
    }
    const result = await client.loginWithGoogleIdToken(idToken);
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }
    writeCommunityAuth(getCommunityUserDataPath(), {
      token: result.token,
      account: result.account,
      analyticsUserId: result.analyticsUserId,
      authMethod: "google"
    });
    return { ok: true, account: result.account, needsPasswordSetup: result.needsPasswordSetup };
  }
);

ipcMain.handle(
  IPCChannels.communitySetPassword,
  async (_event: unknown, request: CommunitySetPasswordRequest): Promise<CommunitySetPasswordResponse> => {
    const password = String(request.password || "");
    if (!password) {
      return { ok: false, code: "invalid_credentials", message: "Please enter a password." };
    }
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    const result = await getCommunityClient().setPassword(auth.token, password);
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }
    return { ok: true, account: result.account || auth.account };
  }
);

ipcMain.handle(IPCChannels.communityCancelGoogleLogin, (): CommunityCancelGoogleLoginResponse => {
  communityGoogleLoginAbortController?.abort();
  return { ok: true };
});

ipcMain.handle(IPCChannels.communityLogout, (): CommunityLogoutResponse => {
  clearCommunityAuth(getCommunityUserDataPath());
  return { ok: true };
});

ipcMain.handle(
  IPCChannels.communityGetLlmQuota,
  async (): Promise<CommunityGetLlmQuotaResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const result = await getCommunityClient().getLlmQuota(auth.token);
    if (!result.ok) {
      if (result.code === "session_expired") {
        clearCommunityAuth(getCommunityUserDataPath());
      }
      return {
        ok: false,
        code: result.code,
        message: result.message,
        serverMessage: result.serverMessage,
        authRequired: result.code === "session_expired"
      };
    }
    return { ok: true, quota: result.quota };
  }
);

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
      return authRequiredResponse(games.code, games.message, games.serverMessage);
    }
    if (!widgets.ok) {
      clearAuthIfExpired(widgets.code);
      return authRequiredResponse(widgets.code, widgets.message, widgets.serverMessage);
    }
    if (!gameCategories.ok) {
      clearAuthIfExpired(gameCategories.code);
      return authRequiredResponse(gameCategories.code, gameCategories.message, gameCategories.serverMessage);
    }
    if (!widgetCategories.ok) {
      clearAuthIfExpired(widgetCategories.code);
      return authRequiredResponse(widgetCategories.code, widgetCategories.message, widgetCategories.serverMessage);
    }
    if (!gameControls.ok) {
      clearAuthIfExpired(gameControls.code);
      return authRequiredResponse(gameControls.code, gameControls.message, gameControls.serverMessage);
    }
    if (!widgetStatus.ok) {
      clearAuthIfExpired(widgetStatus.code);
      return authRequiredResponse(widgetStatus.code, widgetStatus.message, widgetStatus.serverMessage);
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
    return {
      ok: true,
      games: normalizedGames,
      widgets: widgets.widgets,
      gameCategories: gameCategories.categories,
      widgetCategories: widgetCategories.categories,
      gameControls: gameControls.controls,
      widgetControls: widgetStatus.controls,
      widgetSizes: widgetStatus.sizes,
      workspace
    };
  }
);

ipcMain.handle(
  IPCChannels.communityListAppVersions,
  async (_event, request: CommunityListAppVersionsRequest): Promise<CommunityListAppVersionsResponse> => {
    const auth = readCommunityAuth(getCommunityUserDataPath());
    if (!auth?.token) {
      return { ok: false, code: "session_expired", message: "Please sign in first.", authRequired: true };
    }
    const projectType = request?.projectType === "widget" ? "widget" : "game";
    if (!hasResolvableCommunityAppSystemId(request?.appSystemId)) {
      return { ok: false, code: "api_error", message: `Could not resolve backend ${projectType} id.` };
    }
    const result = await getCommunityClient().listAppVersions(auth.token, projectType, request.appSystemId);
    if (!result.ok) {
      clearAuthIfExpired(result.code);
      return authRequiredResponse(result.code, result.message, result.serverMessage);
    }
    return { ok: true, versions: result.versions, total: result.total };
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
      return authRequiredResponse(result.code, result.message, result.serverMessage);
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
        return authRequiredResponse(existing.code, existing.message, existing.serverMessage);
      }
      existingApps = existing.widgets;
    } else {
      const existing = await client.listMyGames(auth.token);
      if (!existing.ok) {
        clearAuthIfExpired(existing.code);
        return authRequiredResponse(existing.code, existing.message, existing.serverMessage);
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
      return authRequiredResponse(result.code, result.message, result.serverMessage);
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
  IPCChannels.communityUpdateWorkspaceVersion,
  async (
    _event,
    request: CommunityUpdateWorkspaceVersionRequest
  ): Promise<CommunityUpdateWorkspaceVersionResponse> => {
    if (!workspaceRoot) {
      return { ok: false, code: "no_workspace", message: "Open a workspace before changing its version." };
    }
    const version = String(request?.version || "").trim();
    if (!version) {
      return { ok: false, code: "invalid_version", message: "Enter a new version." };
    }
    try {
      syncWorkspaceProjectMetadata(workspaceRoot, version);
      const workspace = readCommunityWorkspaceDefaults();
      if (!workspace.eligible) {
        return { ok: false, code: "invalid_workspace", message: "The current workspace configuration is invalid." };
      }
      sendToRenderer(IPCChannels.deployEligibilityChanged, readDeployEligibilityFromWorkspace());
      return { ok: true, workspace };
    } catch (error) {
      return {
        ok: false,
        code: "write_failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
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
      const metadata = syncWorkspaceProjectMetadata(workspaceRoot);
      if (metadata.appId !== elig.appId) {
        return { ok: false, code: "api_error", message: "Workspace identity changed. Refresh Community and try again." };
      }
      if (String(request.version || "").trim() !== metadata.version) {
        return { ok: false, code: "api_error", message: "Submission version must match pyproject.toml." };
      }
      emitCommunitySubmitProgress("packaging", "Packaging workspace and running tar...");
      tarballPath = await createPublishTarball(workspaceRoot, elig.appId);
      const client = getCommunityClient();
      emitCommunitySubmitProgress("uploading", "Uploading packaged workspace...");
      const packageUpload =
        projectType === "widget"
          ? await client.uploadWidgetZip(
              auth.token,
              fileBlobFromPath(tarballPath, "application/gzip"),
              `${elig.appId}.tar.gz`,
              request.appSystemId,
              metadata.appId
            )
          : await client.uploadGameZip(
              auth.token,
              fileBlobFromPath(tarballPath, "application/gzip"),
              `${elig.appId}.tar.gz`,
              request.appSystemId,
              metadata.appId
            );
      if (!packageUpload.ok) {
        clearAuthIfExpired(packageUpload.code);
        return authRequiredResponse(packageUpload.code, packageUpload.message, packageUpload.serverMessage);
      }
      emitCommunitySubmitProgress("submitting", "Submitting version for community review...");
      const submit = await client.submitAppVersion(auth.token, {
        projectType,
        appSystemId: request.appSystemId,
        appId: metadata.appId,
        version: String(request.version || "").trim(),
        description: String(request.description || "").trim(),
        fields: String(request.fields || "").trim(),
        preview,
        downloadUrl: packageUpload.upload.url,
        downloadMd5: packageUpload.upload.md5
      });
      if (!submit.ok) {
        clearAuthIfExpired(submit.code);
        return authRequiredResponse(submit.code, submit.message, submit.serverMessage);
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
        emitCommunitySubmitProgress("cleaning", "Cleaning up temporary package...");
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
    const versionId =
      typeof request.versionId === "number" ? request.versionId : String(request.versionId || "").trim();
    if (!versionId) {
      return { ok: false, code: "api_error", message: "Could not resolve version id for review withdrawal." };
    }
    const result = await getCommunityClient().withdrawAppVersion(auth.token, {
      projectType,
      versionId
    });
    if (!result.ok) {
      clearAuthIfExpired(result.code);
      return authRequiredResponse(result.code, result.message, result.serverMessage);
    }
    return { ok: true, status: result.status };
  }
);

ipcMain.handle(IPCChannels.deployGetEligibility, (): DeployEligibility => readDeployEligibilityFromWorkspace());
ipcMain.handle(IPCChannels.widgetConfigGet, (_event, scope: WidgetConfigScope): WidgetConfigSnapshot => {
  if (scope !== "workspace" && scope !== "emulator") {
    return {
      scope: "workspace",
      status: "unavailable",
      configKey: null,
      confPath: null,
      message: "Unknown widget configuration scope.",
    };
  }
  return currentWidgetConfigSnapshot(scope);
});

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
      const { deviceName, deployMode } = await session.connect(request.host.trim());
      try {
        if (deployMode === "safe_sideload") {
          return { ok: true, deviceName, deployMode };
        }
        emitDeployLog("[deploy] Stopping any ~/dartsnut_rpi/apps/*/main.py still running on device…");
        await session.killAppMainPyProcesses();
        await session.restartDartsnutPythonServiceIfInactive();
        return { ok: true, deviceName, deployMode };
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
    if (!session.connected && !session.connecting) {
      return { ok: false, error: "SSH not connected." };
    }
    if (!session.connected) {
      await disconnectDeployMachine();
      return { ok: true };
    }
    if (session.safeSideloadSupported) {
      emitDeployLog("[sideload] Disconnect — stop local session and restore production…");
      await session.stopSideload();
      await disconnectDeployMachine();
      return { ok: true };
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
      if (session.safeSideloadSupported) {
        emitDeployLog("[sideload] Run — upload local files and start exclusive session…");
        await session.startSideload(
          workspaceRoot,
          elig.appId,
          readSideloadSizeFromWorkspace(elig.projectType),
          widgetParams ?? {},
        );
        return { ok: true };
      }
      emitDeployLog("[deploy] WARNING: using legacy unsafe deploy; production service will stop.");
      emitDeployLog("[deploy] Run — sync, stop service, start debug Python…");
      await session.syncWorkspace(workspaceRoot, elig.appId);
      await session.stopSystemdService();
      await session.stopDebugApp(elig.appId);
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
        throw new Error("SSH not connected.");
      }
      if (session.safeSideloadSupported) {
        emitDeployLog("[sideload] Reload — replace exclusive local session…");
        await session.startSideload(
          workspaceRoot,
          elig.appId,
          readSideloadSizeFromWorkspace(elig.projectType),
          widgetParams ?? {},
        );
        return { ok: true };
      }
      emitDeployLog("[deploy] WARNING: using legacy unsafe deploy; production service will stop.");
      emitDeployLog("[deploy] Reload — sync, restart debug Python…");
      await session.syncWorkspace(workspaceRoot, elig.appId);
      await session.stopSystemdService();
      await session.stopDebugApp(elig.appId);
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

ipcMain.handle(
  DEPLOY_APPLY_WIDGET_PARAMS,
  async (_event: unknown, request?: DeployLaunchRequest): Promise<DeployActionResponse> => {
    const elig = readDeployEligibilityFromWorkspace();
    if (!elig.ok || elig.projectType !== "widget") {
      return { ok: false, error: "Widget workspace required." };
    }
    let params: Record<string, unknown>;
    try {
      params = parseDeployWidgetParamsJson(request?.widgetParamsJson) ?? {};
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const session = getDeployMachineSession();
      if (!session.connected || !session.safeSideloadSupported) {
        throw new Error("No active safe sideload session. Run widget first.");
      }
      await session.applySideloadParams(params);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitDeployLog(`[sideload] Apply parameters failed: ${message}`);
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
    if (session.safeSideloadSupported) {
      emitDeployLog("[sideload] Stop — restore production display…");
      await session.stopSideload();
      return { ok: true };
    }
    emitDeployLog("[deploy] Stop — remove app folder, restore dartsnut_python.service…");
    session.stopLogTail();
    await session.stopDebugApp(elig.appId);
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
  reconfigureAgentsSdkFromProviderSettings(saved);
  emitBootstrapStateToRenderer();
  return saved;
});

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
  return {
    state: getBootstrapState(),
    selectedPath,
    accepted: true
  } satisfies PickWorkspaceResponse;
});

ipcMain.handle(
  IPCChannels.machineMcpSubmitQuestionAnswer,
  async (_event: unknown, body: MachineMcpSubmitQuestionAnswerRequest): Promise<MachineMcpSubmitQuestionAnswerResponse> => {
    if (!machineMcpQuestionPending) {
      return { ok: false, reason: "no_pending" };
    }
    if (body.kind === "machine") {
      const host = normalizeMachineHost(body.ipAddress);
      if (!host) {
        return { ok: false, reason: "invalid_value" };
      }
      const pending = machineMcpQuestionPending;
      const known = pending.machines.find((machine) => machine.deviceId === body.deviceId && machine.ipAddress === body.ipAddress);
      if (!known) {
        return { ok: false, reason: "invalid_value" };
      }
      machineMcpQuestionPending = null;
      agentEventEmitter?.({ type: "machine_mcp_prompt", at: Date.now(), visible: false });
      pending.resolve({ host, deviceId: body.deviceId });
      return { ok: true };
    }
    if (body.kind === "manual_ip") {
      const host = normalizeMachineHost(body.value);
      if (!host) {
        return { ok: false, reason: "invalid_value" };
      }
      const pending = machineMcpQuestionPending;
      machineMcpQuestionPending = null;
      agentEventEmitter?.({ type: "machine_mcp_prompt", at: Date.now(), visible: false });
      pending.resolve({ host });
      return { ok: true };
    }
    return { ok: false, reason: "invalid_value" };
  }
);

ipcMain.handle(
  IPCChannels.agentQuestionSubmitAnswer,
  async (_event: unknown, body: AgentQuestionAnswerRequest): Promise<AgentQuestionAnswerResponse> => {
    if (!agentQuestionPending) {
      return { ok: false, reason: "no_pending" };
    }
    if (!body || typeof body.questionId !== "string" || typeof body.value !== "string") {
      return { ok: false, reason: "invalid_value" };
    }
    if (body.questionId !== agentQuestionPending.questionId) {
      return { ok: false, reason: "stale_question" };
    }
    const value = typeof body.value === "string" ? body.value.trim() : "";
    if (!value || value.length > 4_000) {
      return { ok: false, reason: "invalid_value" };
    }
    const pending = agentQuestionPending;
    const matchesOption = pending.prompt.options?.some((option) => option.value === value) === true;
    if (!matchesOption && pending.prompt.allowFreeText !== true) {
      return { ok: false, reason: "invalid_value" };
    }
    agentQuestionPending = null;
    agentEventEmitter?.({ type: "agent_question", questionId: pending.questionId, visible: false, question: "" });
    pending.resolve(value);
    return { ok: true };
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
    const classification = readWorkspaceProjectClassification(targetWorkspace);
    if (!classification.ok) {
      return { ok: false, reason: "unknown", message: classification.message };
    }
    const projectType = classification.projectType;
    let bridgeRun: DartsnutLlmBridgeRun | null = null;
    try {
      const prepared = await prepareAgentProvider(readProviderSettings());
      if (!prepared.ok) {
        return { ok: false, reason: "unknown", message: prepared.failure.message };
      }
      bridgeRun = prepared.bridgeRun;
      const session = await buildSession("asset-applier", {
        workspacePath: targetWorkspace,
        assetApplierMode: true,
        agentModelConfig: prepared.modelConfig
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
      const bridgeFailure = bridgeRun?.readFailure();
      if (bridgeFailure) {
        return { ok: false, reason: "unknown", message: bridgeFailure.message };
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
    } finally {
      await bridgeRun?.finish("asset_finalizer");
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
  await chatTitleCoordinator.cancelAndWait("agent_prompt_started");
  const runLease = await sendPromptCoordinator.begin("replacement_prompt");
  const runAbort = runLease.abortController;
  const emitAgentSink = createEmitAgentToRenderer();
  const emitAgent = (agentEvent: AgentEvent) => emitAgentSink.emit(agentEvent);
  let bridgeRun: DartsnutLlmBridgeRun | null = null;
  try {
    if (!activeProjectId || !workspaceRoot) {
      return { ok: false, message: "Select a project before sending." };
    }
    agentEventEmitter = emitAgent;
    const prepared = await prepareAgentProvider(readProviderSettings());
    if (!prepared.ok) {
      emitAgent({ type: "error", message: prepared.failure.message, at: Date.now() });
      return {
        ok: false,
        failureReason: prepared.failure.reason,
        message: prepared.failure.message
      };
    }
    bridgeRun = prepared.bridgeRun;
    activeDartsnutLlmBridgeRun = bridgeRun;
    if (!activeChatId) {
      const store = getProjectStore();
      const chat = store.createChat(activeProjectId);
      activeChatId = chat.id;
      store.markChatOpened(chat.id);
      store.touchProject(activeProjectId);
      emitBootstrapStateToRenderer();
    }
    let sessionRouting: SendPromptResponse["sessionRouting"];
    const effectiveWorkspacePath =
      typeof req.workspacePath === "string" && req.workspacePath.length > 0 ? req.workspacePath : workspaceRoot;
    const request: PromptRequest = {
      ...req,
      chatId: activeChatId,
      prompt: buildPromptWithChatMediaAttachments(req.prompt, req.chatMediaAttachments ?? [])
    };
    const intent = request.agentSession?.intent ?? "auto";
    const persistence = buildWorkspaceSessionPersistence(workspaceRoot);
    if (intent === "fresh" && persistence) {
      persistence.archiveOrResetSession("renderer-fresh");
    }
    const initialItems =
      persistence && intent !== "fresh" ? persistence.readConversationItems() : [];
    const agentProfileId = normalizeAgentProfileId(
      request.agentProfileId ?? persistence?.readAgentProfileId() ?? "export"
    );
    const hintedRouting =
      effectiveWorkspacePath && fs.existsSync(effectiveWorkspacePath)
        ? readWorkspaceCreatorHints(effectiveWorkspacePath)
        : null;
    const {
      templateMode: routedTemplateMode,
      projectType: routedProjectType,
      widgetSize: routedWidgetSize
    } = resolveCreatorRouting(
      {
        templateMode:
          request.templateMode === "game-creator" || request.templateMode === "widget-creator"
            ? request.templateMode
            : undefined,
        projectType: request.projectType,
        widgetSize: request.widgetSize
      },
      hintedRouting
    );
    const session = await buildSession(routedTemplateMode, {
      toolSchemas: AGENT_TOOL_SCHEMAS,
      chatMediaAttachments: request.chatMediaAttachments,
      sessionPersistence: persistence,
      initialItems,
      agentProfileId,
      originalUserPrompt: request.prompt,
      projectType: routedProjectType,
      widgetSize: routedWidgetSize,
      agentModelConfig: prepared.modelConfig
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
    const prompt = buildRoutedPrompt({
      ...request,
      templateMode: routedTemplateMode,
      projectType: routedProjectType,
      widgetSize: routedWidgetSize
    });
    terminalAgentLifecycleLog("[agent] runPrompt start", { promptChars: prompt.length });
    await session.runPrompt(prompt, emitAgent, runAbort.signal, { userPrompt: request.prompt });

    const bridgeFailure = bridgeRun?.readFailure();
    if (bridgeFailure) {
      if (bridgeFailure.reason === "auth_required") {
        clearCommunityAuth(getCommunityUserDataPath());
      }
      return {
        ok: false,
        failureReason: bridgeFailure.reason,
        message: bridgeFailure.message
      };
    }

    if (!firstRunComplete) {
      writeProofState(true);
    }
    const createdRouting = effectiveWorkspacePath
      ? readWorkspaceCreatorHints(effectiveWorkspacePath)
      : null;
    if (createdRouting) {
      sessionRouting = createdRouting;
    }
    return { ok: true, sessionRouting };
  } catch (error) {
    const bridgeFailure = bridgeRun?.readFailure();
    const message = bridgeFailure?.message ?? (error instanceof Error ? error.message : "Unknown prompt error");
    if (message !== AGENT_STOPPED_MESSAGE) {
      const event: AgentEvent = { type: "error", message, at: Date.now() };
      logAgentEventToConsole(event, true);
      sendToRenderer(IPCChannels.subscribeEvents, event);
    }
    if (bridgeFailure?.reason === "auth_required") {
      clearCommunityAuth(getCommunityUserDataPath());
    }
    return {
      ok: false,
      ...(bridgeFailure ? { failureReason: bridgeFailure.reason, message: bridgeFailure.message } : {})
    };
  } finally {
    await bridgeRun?.finish("prompt_finalizer");
    if (activeDartsnutLlmBridgeRun === bridgeRun) {
      activeDartsnutLlmBridgeRun = null;
    }
    emitAgentSink.flush();
    cancelPendingAgentInput();
    agentEventEmitter = null;
    runLease.settle();
  }
});

ipcMain.handle(IPCChannels.cancelAgent, async () => {
  await stopActiveAgentRun("user_stop");
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
      startWidgetConfigWatchers();
      if (emulatorState.widgetPath !== selectedPath) {
        pendingEmulatorPathForReload = selectedPath;
      }
    }
    if (commandToSend.type === "reload_widget") {
      clearEmulatorLogsForReload();
      beginPendingEmulatorSwitch(pendingEmulatorPathForReload ?? emulatorState.widgetPath ?? lastWidgetDir ?? "");
      pendingEmulatorPathForReload = null;
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
  startWidgetConfigWatchers();
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
