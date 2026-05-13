import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import {
  IPCChannels,
  type AgentEvent,
  type ApplyAssetsRequest,
  type ApplyAssetsResponse,
  type BindSlotRequest,
  type BindSlotResponse,
  type BootstrapState,
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
  type ProviderSettings,
  type ReadPreviewRequest,
  type ReadPreviewResponse,
  type SaveProviderSettingsRequest,
  type UnbindSlotRequest,
  type UnbindSlotResponse,
  validateDeployWorkspaceConf,
  INTAKE_UI_SHOW_PROJECT_TYPE_MARKER,
  INTAKE_UI_SHOW_WIDGET_SIZE_MARKER,
  WIDGET_DISPLAY_SIZES,
  type WidgetSize,
  type ShellUiTheme,
  type WindowChromeInsets,
  type SendPromptResponse
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
  AGENT_TOOL_SCHEMAS
} from "@dartsnut/agent-runtime";
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
let firstRunComplete = false;
let bridgeProcess: ReturnType<typeof spawn> | null = null;
const repoRoot = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, "../../..");
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
  bridgeProcess.stdin.write(`${JSON.stringify({ command: reload })}\n`);
  lastWidgetDir = selectedPath;
  writeEmulatorState();
  startDeployConfWatcher(workspaceRoot);
  return JSON.stringify({
    ok: true,
    message:
      "Emulator path re-applied and reload_widget sent; conf.json re-read on the Python side and deploy eligibility refreshed."
  });
}

const emulatorState: EmulatorStateSnapshot = {
  widgetPath: null,
  running: false,
  fps: 0,
  status: "Idle",
};

const proofStatePath = () => path.join(app.getPath("userData"), "first-run-proof.json");
const emulatorStatePath = () => path.join(app.getPath("userData"), "emulator-state.json");
const providerSettingsPath = () => path.join(app.getPath("userData"), "provider-settings.json");
const pythonSettingsPath = () => path.join(app.getPath("userData"), "python-settings.json");

function normalizeProviderSettings(input?: Partial<ProviderSettings> | null): ProviderSettings {
  return {
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : ""
  };
}

function readProviderSettings(): ProviderSettings {
  const file = providerSettingsPath();
  if (!fs.existsSync(file)) {
    return normalizeProviderSettings();
  }
  try {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<ProviderSettings>;
    return normalizeProviderSettings(content);
  } catch {
    return normalizeProviderSettings();
  }
}

function validateProviderSettingsInput(input: SaveProviderSettingsRequest): { ok: true } | { ok: false; error: string } {
  const normalized = normalizeProviderSettings(input);
  if (!normalized.apiKey) {
    return { ok: false, error: "API key is required." };
  }
  if (!normalized.model) {
    return { ok: false, error: "Model is required." };
  }
  if (normalized.baseUrl) {
    try {
      new URL(normalized.baseUrl);
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
  return normalized;
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

function providerStatus(): BootstrapState["providerStatus"] {
  const validation = validateProviderConfig(loadProviderConfig(readProviderSettings()));
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

type CreatorTemplateMode = keyof typeof creatorTemplatePaths;

function resolveCreatorTemplatePath(templateMode: CreatorTemplateMode): string {
  return path.join(repoRoot, creatorTemplatePaths[templateMode]);
}

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
  return WIDGET_DISPLAY_SIZES.includes(key) ? key : undefined;
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

interface IntakeToolState {
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
}

function getIntakePlaceholderWorkspacePath(): string {
  return path.join(repoRoot, ".dartsnut-chat-intake-placeholder");
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
    bridgeProcess.stdin.write(
      `${JSON.stringify({ command: { type: "reload_widget" } satisfies EmulatorCommand })}\n`,
    );
    lastWidgetDir = selectedPath;
    writeEmulatorState();
  }
  assetManager.watch(selectedPath);
  startDeployConfWatcher(selectedPath);
}

function readWorkspaceConfIntakeSnapshot(
  absoluteWorkspacePath: string,
  intent?: IntakeToolState
): Record<string, unknown> {
  const confPath = path.join(absoluteWorkspacePath, "conf.json");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(absoluteWorkspacePath);
  } catch {
    entries = [];
  }
  const base: Record<string, unknown> = {
    workspacePath: absoluteWorkspacePath,
    directoryEntryCount: entries.length,
    confPath
  };
  if (!fs.existsSync(confPath)) {
    return {
      ...base,
      conf_status: "missing",
      guidance:
        "No conf.json yet — safe for a brand-new scaffold. Confirm the user's goal in one sentence, then the next agent phase can create conf.json + main.py."
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(confPath, "utf-8"));
  } catch {
    return {
      ...base,
      conf_status: "invalid_json",
      guidance:
        "conf.json exists but is not valid JSON. Ask whether to repair/replace it or pick a different empty folder."
    };
  }
  const deploy = validateDeployWorkspaceConf(raw);
  const hints = readWorkspaceCreatorHints(absoluteWorkspacePath);
  const conf = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const size = conf.size;
  const parsedSize = parseConfWidgetSize(size);
  const notes: string[] = [];
  if (intent?.projectType && deploy.ok && deploy.projectType !== intent.projectType) {
    notes.push(
      `User chose "${intent.projectType}" but conf.json declares "${deploy.projectType}". Ask one question: extend the existing project or use another folder.`
    );
  }
  if (
    intent?.projectType === "widget" &&
    intent.widgetSize &&
    parsedSize &&
    parsedSize !== intent.widgetSize
  ) {
    notes.push(
      `User chose widget size ${intent.widgetSize} but conf.json size maps to ${parsedSize}. Ask which size to follow.`
    );
  }
  if (deploy.ok && entries.some((n) => n === "main.py")) {
    notes.push("main.py is already present — confirm whether to modify it or start fresh.");
  }
  return {
    ...base,
    conf_status: deploy.ok ? "valid" : "invalid",
    deploy_eligibility: deploy,
    creator_hints: hints,
    conf_size_parsed: parsedSize ?? null,
    guidance_notes: notes
  };
}

async function intakeHostToolExecute(
  args: Record<string, unknown>,
  state: IntakeToolState
): Promise<string> {
  const action = args.action;
  if (typeof action !== "string") {
    return JSON.stringify({ ok: false, error: "action is required" });
  }
  if (action === "set_project_type") {
    const pt = args.project_type;
    if (pt !== "game" && pt !== "widget") {
      return JSON.stringify({ ok: false, error: "project_type must be \"game\" or \"widget\"." });
    }
    state.projectType = pt;
    if (pt === "game") {
      state.widgetSize = undefined;
    }
    return JSON.stringify({
      ok: true,
      recorded: { projectType: pt },
      next:
        pt === "widget"
          ? "Widget display size: if the user's message already names a supported WxH (128x160, 128x128, 128x64, 64x32), call set_widget_size with that value next. Otherwise reply listing those four options and ask which they want — do **not** pick a default, invent a size, or call set_widget_size or pick_workspace until they choose (or their next message is only one of those tokens — then call set_widget_size with it)."
          : "Call pick_workspace (empty folder), then read_workspace_conf."
    });
  }
  if (action === "set_widget_size") {
    if (state.projectType !== "widget") {
      return JSON.stringify({
        ok: false,
        error: "set_widget_size requires project_type widget (call set_project_type first)."
      });
    }
    const sz = args.widget_size;
    if (typeof sz !== "string" || !WIDGET_DISPLAY_SIZES.includes(sz as WidgetSize)) {
      return JSON.stringify({
        ok: false,
        error: `widget_size must be one of: ${WIDGET_DISPLAY_SIZES.join(", ")}.`
      });
    }
    state.widgetSize = sz as WidgetSize;
    return JSON.stringify({
      ok: true,
      recorded: { widgetSize: state.widgetSize },
      next: "Call pick_workspace, then read_workspace_conf."
    });
  }
  if (action === "pick_workspace") {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) {
      return JSON.stringify({ ok: false, cancelled: true, message: "Folder dialog was cancelled." });
    }
    const selectedPath = result.filePaths[0];
    if (!isDirectoryEmpty(selectedPath)) {
      return JSON.stringify({
        ok: false,
        reason: "non_empty",
        message: "Folder must be empty for a new scaffold from this flow. Ask the user to pick another folder."
      });
    }
    applyWorkspaceRoot(selectedPath);
    const snapshot = readWorkspaceConfIntakeSnapshot(selectedPath, state);
    return JSON.stringify({ ok: true, workspace_selected: selectedPath, ...snapshot });
  }
  if (action === "read_workspace_conf") {
    const root = workspaceRoot;
    if (!root) {
      return JSON.stringify({
        ok: false,
        need_workspace: true,
        message: "No workspace is selected yet — call pick_workspace first."
      });
    }
    return JSON.stringify({ ok: true, ...readWorkspaceConfIntakeSnapshot(root, state) });
  }
  return JSON.stringify({ ok: false, error: `Unknown intake action: ${action}` });
}

function buildCreationIntakeUserPrompt(
  userRequest: string,
  opts?: { widgetSizeFromPicker?: WidgetSize; projectTypeFromPicker?: ProjectType }
): string {
  const projectTypeLine =
    opts?.projectTypeFromPicker != null
      ? `\n\n[UI] User chose project type **${opts.projectTypeFromPicker}** from the in-app **Game / Widget** chip row. Call \`set_project_type\` with that exact \`project_type\` value, then continue intake per the procedure (widget size if \`widget\`, then \`pick_workspace\`, \`read_workspace_conf\`). Do not ask game vs widget again.`
      : "";
  const pickerLine =
    opts?.widgetSizeFromPicker != null
      ? `\n\n[UI] User chose widget display size **${opts.widgetSizeFromPicker}** from the in-app size chip row. Call \`set_project_type\` with \`widget\` then \`set_widget_size\` with exactly that WxH token, then continue intake (\`pick_workspace\`, \`read_workspace_conf\`). Do not ask for size again.`
      : "";
  return [
    "## New project intake (mandatory tool use)",
    "The user has **not** chosen a workspace folder in the shell yet. You cannot read or write project files until intake completes.",
    "Use **only** the `dartsnut_project_intake` tool (native `tool_calls`).",
    "**Desktop chip rows:** The app shows **Game / Widget** and **widget size** chip rows only after you ask for that choice. When you ask the user to pick game vs widget (because it is not already obvious from their message), include this exact substring on its own line in your visible reply (markdown prose or inside the JSON `response` string):",
    INTAKE_UI_SHOW_PROJECT_TYPE_MARKER,
    "When you ask for widget display size, include this exact substring on its own line the same way:",
    INTAKE_UI_SHOW_WIDGET_SIZE_MARKER,
    "Emit each marker only in the same turn where you ask that question. The UI strips these lines from the chat bubble. Users may answer via chips or by typing.",
    "Procedure:",
    "1. Infer **game** vs **widget** from the user's text when it is obvious; otherwise ask one short question, include the project-type marker line above, then call `set_project_type`.",
    "2. For **widget** display size: supported values are exactly **128x160**, **128x128**, **128x64**, **64x32**. If the user's message already includes one of those literals, call `set_widget_size` with it. Otherwise ask one short question and include the widget-size marker line — **never** assume a default, pick a size for them, or call `set_widget_size` / `pick_workspace` until they have chosen (via chips or typed). If the user's message is **only** one of those four literals (no other words), treat it as their size choice for a widget: call `set_project_type` with `widget` then `set_widget_size` with that token, then continue.",
    "3. Call `pick_workspace` so the user selects an **empty** directory.",
    "4. Call `read_workspace_conf`. Use `guidance_notes`, `deploy_eligibility`, and `conf_status` to ask **at most one** focused follow-up when the folder is not a blank slate or types disagree.",
    "5. Close with a one- or two-sentence confirmation of what will be built next (no code, no file paths invented).",
    "",
    "User request:",
    `${userRequest}${projectTypeLine}${pickerLine}`
  ].join("\n");
}

/** User line for the automatic creator run after creation intake — avoids re-welcoming on stale first messages like "hello". */
function buildPostIntakeCreatorUserPrompt(originalUserPrompt: string): string {
  const original = originalUserPrompt.trim();
  const originalLine =
    original.length > 0
      ? `Original first message (use only if it already states what to build): ${original}`
      : "There was no substantive first message before intake.";
  return [
    "Creation **intake just finished**: the empty workspace is selected and **Creation context** above already has project type and (for widgets) display size.",
    "Do **not** open with a generic **Hello / Welcome to Dartsnut Chat** or repeat product onboarding — the user already completed intake.",
    "Give a **one-sentence** acknowledgement that the folder is ready (you may mention type/size from context), then ask what they want this project to display or do, with a few short examples if helpful.",
    originalLine
  ].join("\n");
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
  win.setTitleBarOverlay({
    color: colors.titleBarColor,
    symbolColor: colors.symbolColor,
    height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT
  });
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
      console.error("[dartsnut] window chrome insertCSS failed:", err);
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

function emitEmulatorFrame(frame: EmulatorFrame) {
  sendToRenderer(EMULATOR_IPC_CHANNELS.emulatorFrame, frame);
}

function emitEmulatorLog(entry: EmulatorLogEntry) {
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
  if (process.env.DARTSNUT_PYTHON) {
    return process.env.DARTSNUT_PYTHON;
  }
  const selectedPythonPath = readSelectedPythonPath();
  if (
    selectedPythonPath &&
    canRunEmulatorDeps(selectedPythonPath) &&
    isPythonVersionSupportedSync(selectedPythonPath)
  ) {
    return selectedPythonPath;
  }
  const packagedRuntimePython = await ensurePackagedPythonRuntime(selectedPythonPath);
  if (packagedRuntimePython) {
    return packagedRuntimePython;
  }
  const bundledVenvPython = venvPythonPath(path.join(repoRoot, ".venv"));
  const bundledVenvPython312 =
    process.platform === "win32"
      ? path.join(repoRoot, ".venv", "Scripts", "python3.12.exe")
      : path.join(repoRoot, ".venv", "bin", "python3.12");
  const candidates = [bundledVenvPython, bundledVenvPython312, ...pythonCandidates()];
  for (const candidate of candidates) {
    if (
      canRunEmulatorDeps(candidate) &&
      isPythonVersionSupportedSync(candidate)
    ) {
      return candidate;
    }
  }
  emulatorState.status = "Missing Python 3.10+ or emulator deps (pydartsnut/pygame-ce/Pillow). Run: pnpm setup:python";
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

function buildSession(
  templateMode: PromptRequest["templateMode"] | undefined,
  extras?: {
    workspacePath?: string;
    completionTools?: typeof AGENT_TOOL_SCHEMAS | typeof AGENT_CREATION_INTAKE_TOOL_SCHEMAS;
    hostIntakeToolHandler?: (args: Record<string, unknown>) => Promise<string>;
    skipInitialWorkspaceResolve?: boolean;
    skillBundleMode?: PromptRequest["templateMode"] | "creation-intake" | null;
  }
): SessionEngine {
  const workspacePath = extras?.workspacePath ?? workspaceRoot;
  if (!workspacePath) {
    throw new Error("Workspace is not selected.");
  }
  const providerSettings = readProviderSettings();
  const config = loadProviderConfig(providerSettings);
  const validation = validateProviderConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const skillBundleMode =
    extras?.skillBundleMode !== undefined ? extras.skillBundleMode : templateMode ?? null;
  const { skillPrompt, skillLibrary } = resolveSkillSessionContext(skillBundleMode);
  const intakeToolsOnly = extras?.completionTools === AGENT_CREATION_INTAKE_TOOL_SCHEMAS;
  return new SessionEngine({
    provider: new ProviderClient(config),
    workspacePolicy: new WorkspacePolicy(workspacePath),
    skillPrompt,
    skillLibrary,
    assetRoots: {
      widgetFonts: path.join(repoRoot, "assets", "fonts", "widgets")
    },
    completionTools: extras?.completionTools,
    hostIntakeToolHandler: extras?.hostIntakeToolHandler,
    hostReloadEmulatorHandler: intakeToolsOnly ? undefined : () => executeHostReloadEmulatorForAgent(),
    skipInitialWorkspaceResolve: extras?.skipInitialWorkspaceResolve
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
    void syncShellUiThemeFromDomSnapshot();
    emitChromeInsetsAndPushStyles();
    setTimeout(emitChromeInsetsAndPushStyles, 50);
    setTimeout(emitChromeInsetsAndPushStyles, 300);
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  win.on("closed", () => {
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
  await createWindow();
  pythonExec = await resolvePythonExecutable();
  startPythonBridge();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (bridgeProcess) {
    bridgeProcess.kill();
  }
  assetManager.stop();
  void disconnectDeployMachine();
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
ipcMain.handle(IPCChannels.getProviderSettings, () => readProviderSettings());
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
  const persistedPath = writeSelectedPythonPath(selectedPath);
  pythonExec = await resolvePythonExecutable();
  if (bridgeProcess) {
    bridgeProcess.kill();
  } else {
    startPythonBridge();
  }
  return {
    accepted: true,
    selectedPath: persistedPath
  };
});

ipcMain.handle(IPCChannels.startNewProject, () => {
  performSessionCleanup({ clearWorkspace: true });
  return getBootstrapState();
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
  applyWorkspaceRoot(selectedPath);
  return {
    state: getBootstrapState(),
    selectedPath,
    accepted: true
  } satisfies PickWorkspaceResponse;
});

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
      console.log("[agent] runPrompt asset-applier", {
        slotIds: requestedSlots,
        projectType,
        promptChars: prompt.length
      });
      await session.runPrompt(prompt, (agentEvent: AgentEvent) => {
        console.log("[agent-stream]", JSON.stringify(agentEvent));
        sendToRenderer(IPCChannels.subscribeEvents, agentEvent);
      });
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

ipcMain.handle(IPCChannels.sendPrompt, async (_event: unknown, req: PromptRequest): Promise<SendPromptResponse> => {
  sendPromptAbortController?.abort();
  const runAbort = new AbortController();
  sendPromptAbortController = runAbort;
  const emitAgent = (agentEvent: AgentEvent) => {
    console.log("[agent-stream]", JSON.stringify(agentEvent));
    sendToRenderer(IPCChannels.subscribeEvents, agentEvent);
  };
  try {
    let sessionRouting: SendPromptResponse["sessionRouting"];
    const hostState: IntakeToolState = {};
    const sharedIntakeHandler = async (args: Record<string, unknown>) =>
      intakeHostToolExecute(args, hostState);

    const shouldRunCreationIntake = Boolean(req.creationIntake && !workspaceRoot);

    if (shouldRunCreationIntake) {
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
      const showProjectTypeChips =
        !req.intakeProjectTypeChoice && !req.intakeWidgetSizeChoice;
      if (showProjectTypeChips) {
        emitAgent({
          type: "intake_project_type_prompt",
          at: Date.now(),
          visible: true,
          options: ["game", "widget"]
        });
      }
      const placeholder = getIntakePlaceholderWorkspacePath();
      fs.mkdirSync(placeholder, { recursive: true });
      const intakeSession = buildSession(undefined, {
        workspacePath: placeholder,
        completionTools: AGENT_CREATION_INTAKE_TOOL_SCHEMAS,
        hostIntakeToolHandler: async (args) => {
          const out = await intakeHostToolExecute(args, intakeState);
          const act = args.action;
          if (typeof act === "string") {
            if (act === "set_project_type" && intakeState.projectType) {
              emitAgent({ type: "intake_project_type_prompt", at: Date.now(), visible: false });
            }
            if (act === "set_project_type" && intakeState.projectType === "widget" && !intakeState.widgetSize) {
              emitAgent({
                type: "intake_widget_size_prompt",
                at: Date.now(),
                visible: true,
                sizes: [...WIDGET_DISPLAY_SIZES]
              });
            } else if (act === "set_widget_size" && intakeState.widgetSize) {
              emitAgent({ type: "intake_widget_size_prompt", at: Date.now(), visible: false });
            } else if (act === "set_project_type" && intakeState.projectType === "game") {
              emitAgent({ type: "intake_widget_size_prompt", at: Date.now(), visible: false });
            }
          }
          return out;
        },
        skipInitialWorkspaceResolve: true,
        skillBundleMode: "creation-intake"
      });
      console.log("[agent] runPrompt creation-intake start");
      await intakeSession.runPrompt(
        buildCreationIntakeUserPrompt(req.prompt, {
          widgetSizeFromPicker: req.intakeWidgetSizeChoice,
          projectTypeFromPicker: req.intakeProjectTypeChoice
        }),
        emitAgent,
        runAbort.signal
      );

      const canChain =
        Boolean(workspaceRoot) &&
        intakeState.projectType &&
        (intakeState.projectType === "game" ||
          (intakeState.projectType === "widget" && intakeState.widgetSize));

      if (canChain && intakeState.projectType && workspaceRoot) {
        const templateMode =
          intakeState.projectType === "game" ? "game-creator" : "widget-creator";
        sessionRouting = {
          templateMode,
          projectType: intakeState.projectType,
          widgetSize: intakeState.projectType === "widget" ? intakeState.widgetSize : undefined
        };
        const followUp = buildSession(templateMode);
        const routed = buildRoutedPrompt({
          prompt: buildPostIntakeCreatorUserPrompt(req.prompt),
          templateMode,
          projectType: intakeState.projectType,
          widgetSize: intakeState.widgetSize,
          workspacePath: workspaceRoot
        });
        console.log("[agent] runPrompt chained creator", { templateMode });
        await followUp.runPrompt(routed, emitAgent, runAbort.signal);
      }
    } else {
      const session = buildSession(req.templateMode, {
        completionTools: AGENT_TOOL_SCHEMAS,
        hostIntakeToolHandler: sharedIntakeHandler
      });
      const prompt = buildRoutedPrompt(req);
      console.log("[agent] runPrompt start", { promptChars: prompt.length });
      await session.runPrompt(prompt, emitAgent, runAbort.signal);
    }

    if (!firstRunComplete) {
      writeProofState(true);
    }
    return { ok: true, sessionRouting };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown prompt error";
    const event: AgentEvent = { type: "error", message, at: Date.now() };
    console.error("[agent-stream]", JSON.stringify(event));
    sendToRenderer(IPCChannels.subscribeEvents, event);
    return { ok: false };
  } finally {
    if (sendPromptAbortController === runAbort) {
      sendPromptAbortController = null;
    }
  }
});

ipcMain.handle(IPCChannels.cancelAgent, () => {
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
