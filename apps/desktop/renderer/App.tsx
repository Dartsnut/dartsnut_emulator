import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type AgentEvent,
  type AgentSessionTokenUsage,
  type AgentTokenUsage,
  type AppUpdateStatus,
  type AssetManifest,
  type BootstrapState,
  type DeployEligibility,
  type ManifestSnapshot,
  type ProviderId,
  type ProviderSettings,
  type PythonRuntimeProgress,
  type ProjectType,
  type UserDefineProviderSettings,
  type PromptRequest,
  type SendPromptResponse,
  type SaveTempWorkspaceResponse,
  type MainProcessConsoleMirrorPayload,
  type MachineMcpQuestionMachine,
  type WidgetSize,
  type CommunitySessionInfo,
  type CommunitySubmitProgress
} from "@dartsnut/shared-ipc";
import { AskQuestionCard } from "./AskQuestionCard";
import { AssetManagerPanel } from "./AssetManagerPanel";
import { cn } from "./cn";
import { devLog, isDevLoggingEnabled } from "./devOnlyLog";
import {
  DeployAuthGate,
  isCommunityAuthSkippedForSession,
  setCommunityAuthSkippedForSession
} from "./DeployAuthGate";
import { DeployPanel } from "./DeployPanel";
import { EmulatorPanel } from "./EmulatorPanel";
import { MyGamesPanel } from "./MyGamesPanel";
import {
  agentEventTimelineRole,
  formatAgentEventForTimeline,
  mergeTimelineSkillStatusEntry,
  parseToolStatusMessage,
  shouldHideTimelineStatus,
  transcriptLineToTimelineEntry,
  type TimelineEntry
} from "./rawTimeline";
import { ThemeSwitcherIcon } from "./ThemeSwitcher";
import { applyTheme, resolveThemeFromEnvironment, type ThemeId } from "./theme";
import { useWindowChromeInsets } from "./useWindowChromeInsets";

/** Same order as `WIDGET_DISPLAY_SIZES` in `@dartsnut/shared-ipc` — defined here because Vite/Rollup does not resolve that value through the package’s compiled CJS `export *` shim. */
const WIDGET_DISPLAY_SIZES: readonly WidgetSize[] = ["128x160", "128x128", "128x64", "64x32"];

const CREATION_INTAKE_PROJECT_TYPES: readonly ProjectType[] = ["game", "widget"];
const AgentMarkdownRenderer = lazy(() => import("./AgentMarkdownRenderer"));

function projectTypeChipLabel(pt: ProjectType): string {
  return pt === "game" ? "Game" : "Widget";
}

function isValidMachineHost(value: string): boolean {
  const trimmed = value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return Boolean(trimmed) && !/[/?#\s]/.test(trimmed);
}

function machineOptionLabel(machine: MachineMcpQuestionMachine): string {
  const name = machine.name || machine.deviceId;
  const details = [machine.ipAddress, machine.ssid].filter(Boolean).join(" · ");
  return details ? `${name}  ${details}` : name;
}

type RightPaneTab = "emulator" | "assets";
type DeployPaneTab = "deploy" | "games";
type CommunityAuthIntent = "deploy-devices" | "my-games";

type AppScreen = "main" | "settings";
type SubmissionLockState = {
  active: boolean;
  stage: CommunitySubmitProgress["stage"] | "idle";
  message: string;
};
type UpdatePromptState = AppUpdateStatus & {
  dismissedVersion: string | null;
  installing: boolean;
  error: string | null;
};

const AUTO_SCROLL_BOTTOM_THRESHOLD = 24;
/** Keep in sync with composer textarea `max-h-[200px]` */
const COMPOSER_PROMPT_MAX_HEIGHT_PX = 200;
/**
 * Visual multiline detection can be off by a fractional pixel depending on
 * font metrics, zoom, and platform.
 */
const COMPOSER_PROMPT_MULTILINE_EPSILON_PX = 1;
const GREETING_TEXT =
  "What are we making today? Share your idea and I'll help turn it into a Dartsnut widget or game.";

const EMPTY_USER_DEFINE: UserDefineProviderSettings = {
  baseUrl: "",
  apiKey: "",
  model: ""
};

const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  activeProvider: "dartsnut-llm",
  custom: EMPTY_USER_DEFINE,
  userDefine: EMPTY_USER_DEFINE
};

const chromeIconBtnClass = "ui-chrome-btn";

function hasPrimaryShortcutModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function isSettingsShortcut(event: KeyboardEvent): boolean {
  if (event.key !== ",") {
    return false;
  }
  return hasPrimaryShortcutModifier(event);
}

function isComposerSendShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.key === "Enter" && hasPrimaryShortcutModifier(event);
}

function CommunitySubmitOverlay({ lock }: { lock: SubmissionLockState }) {
  if (!lock.active) {
    return null;
  }
  return (
    <div
      className="community-submit-overlay"
      role="status"
      aria-live="polite"
      aria-label="Community submission in progress"
    >
      <div className="community-submit-overlay__panel">
        <div className="community-submit-overlay__glyph" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="community-submit-overlay__copy">
          <p className="community-submit-overlay__eyebrow">Community review</p>
          <h2 className="community-submit-overlay__title">Submitting to Community</h2>
          <p className="community-submit-overlay__message">{lock.message}</p>
          <div className="community-submit-overlay__rail" aria-hidden>
            <span />
          </div>
          <p className="community-submit-overlay__note">Keep Dartsnut Agent open until this finishes.</p>
        </div>
      </div>
    </div>
  );
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
}

function formatTokenUsageTitle(usage: AgentTokenUsage): string {
  return `Input ${usage.inputTokens.toLocaleString()} · Output ${usage.outputTokens.toLocaleString()} · Total ${usage.totalTokens.toLocaleString()}`;
}

function UpdateDownloadPill({ status }: { status: AppUpdateStatus | null }) {
  if (!status || status.kind !== "downloading") {
    return null;
  }
  const percent = Math.round(status.percent ?? 0);
  return (
    <div className="app-update-pill" role="status" aria-label="App update downloading">
      <span className="app-update-pill__dot" aria-hidden />
      <span className="app-update-pill__text">Updating</span>
      <span className="app-update-pill__percent tabular-nums">{percent}%</span>
    </div>
  );
}

type UpdateReadyOverlayProps = {
  status: AppUpdateStatus | null;
  installing: boolean;
  error: string | null;
  onInstallNow: () => void;
  onLater: () => void;
};

function UpdateReadyOverlay({ status, installing, error, onInstallNow, onLater }: UpdateReadyOverlayProps) {
  if (!status || status.kind !== "ready") {
    return null;
  }
  return (
    <div className="app-update-overlay" role="dialog" aria-modal="true" aria-labelledby="app-update-title">
      <div className="app-update-panel">
        <div className="app-update-panel__ticker" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="app-update-panel__copy">
          <p className="app-update-panel__eyebrow">Desktop update</p>
          <h2 id="app-update-title" className="app-update-panel__title">Update ready</h2>
          <p className="app-update-panel__version">
            Dartsnut Agent {status.currentVersion}
            {status.availableVersion ? ` -> ${status.availableVersion}` : ""}
          </p>
          <p className="app-update-panel__message">
            The new version has finished downloading. Install it now to relaunch, or keep working and update the next time you open Dartsnut Agent.
          </p>
          {error ? (
            <p className="app-update-panel__error" role="alert">{error}</p>
          ) : null}
        </div>
        <div className="app-update-panel__actions">
          <button
            type="button"
            className="ui-btn-primary app-update-panel__primary"
            disabled={installing}
            onClick={onInstallNow}
          >
            {installing ? "Preparing..." : "Update now"}
          </button>
          <button type="button" className="app-update-panel__secondary" disabled={installing} onClick={onLater}>
            Next launch
          </button>
        </div>
      </div>
    </div>
  );
}

type TimelineEntryViewProps = {
  entry: TimelineEntry;
  onToggleReasoning: (entryId: string) => void;
};

const TimelineEntryView = memo(function TimelineEntryView({
  entry,
  onToggleReasoning
}: TimelineEntryViewProps) {
  return (
    <div
      className={cn(
        "entry",
        entry.role,
        entry.id.startsWith("greeting") && entry.role === "agent" && "greeting-entry"
      )}
    >
      {entry.role === "agent" && entry.id.startsWith("greeting") ? (
        <div className="greeting-card" role="status">
          <p className="greeting-card__eyebrow">Neon Pit · ready</p>
          <p className="greeting-card__title">Dartsnut Agent</p>
          <p className="greeting-card__body">{entry.text}</p>
        </div>
      ) : entry.role === "user" ? (
        <div className="entry-text">{entry.text}</div>
      ) : entry.role === "agent" ? (
        <AgentMarkdownBody source={entry.text} className="entry-text" />
      ) : entry.reasoningMode === "delta" ? (
        <div className="entry-text entry-text--subtle">
          <AgentMarkdownBody source={entry.text} className="entry-text entry-text--subtle" />
        </div>
      ) : entry.reasoningMode === "summary" || entry.reasoningMode === "expanded" ? (
        <div className="entry-reasoning-wrap">
          <button
            type="button"
            className="entry-reasoning-summary entry-text--subtle"
            onClick={() => onToggleReasoning(entry.id)}
          >
            {entry.text}
          </button>
          {entry.reasoningMode === "expanded" ? (
            <div className="entry-text entry-text--subtle">
              <AgentMarkdownBody
                source={entry.reasoningFullText ?? ""}
                className="entry-text entry-text--subtle"
              />
            </div>
          ) : null}
        </div>
      ) : entry.role === "status" && entry.toolStatusMeta ? (
        <div className="entry-status-detail">
          <span className="entry-status-detail__text">{entry.text}</span>
          {entry.toolStatusMeta.filePath ? (
            <span className="entry-status-detail__path">{entry.toolStatusMeta.filePath}</span>
          ) : null}
          {typeof entry.toolStatusMeta.added === "number" ||
          typeof entry.toolStatusMeta.deleted === "number" ? (
            <span className="entry-status-detail__diff" aria-label="Line changes">
              <span className="entry-status-detail__add">
                +{entry.toolStatusMeta.added ?? 0}
              </span>
              <span className="entry-status-detail__del">
                -{entry.toolStatusMeta.deleted ?? 0}
              </span>
            </span>
          ) : null}
        </div>
      ) : entry.role === "status" ? (
        <div className="entry-text">{entry.text}</div>
      ) : (
        <pre className="entry-json">{entry.text}</pre>
      )}
    </div>
  );
});

function maskApiKey(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  const suffix = value.slice(-4);
  return `${"*".repeat(Math.max(4, value.length - 4))}${suffix}`;
}

function withProviderCustom(
  settings: ProviderSettings,
  updater: (custom: UserDefineProviderSettings) => UserDefineProviderSettings
): ProviderSettings {
  const custom = updater(settings.custom ?? settings.userDefine ?? EMPTY_USER_DEFINE);
  return {
    ...settings,
    custom,
    userDefine: custom
  };
}

function withProviderId(settings: ProviderSettings, activeProvider: ProviderId): ProviderSettings {
  return {
    ...settings,
    activeProvider
  };
}

function providerCustom(settings: ProviderSettings): UserDefineProviderSettings {
  return settings.custom ?? settings.userDefine ?? EMPTY_USER_DEFINE;
}

function workspaceFolderBasename(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : workspaceRoot;
}

function isLikelyTempWorkspace(workspaceRoot: string | null | undefined): boolean {
  if (!workspaceRoot) {
    return false;
  }
  const basename = workspaceFolderBasename(workspaceRoot);
  return basename.startsWith("dartsnut-chat-");
}

function AgentMarkdownBody({ source, className }: { source: string; className?: string }) {
  const fallbackClass = className ?? "entry-text";
  return (
    <Suspense fallback={<div className={fallbackClass}>{source}</div>}>
      <AgentMarkdownRenderer source={source} />
    </Suspense>
  );
}

type CommunityAuthStatusProps = {
  communitySession: CommunitySessionInfo;
  onAuthRequired: () => void;
  onSignOut: () => Promise<void>;
};

function CommunityAuthStatus({ communitySession, onAuthRequired, onSignOut }: CommunityAuthStatusProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [menuOpen]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await onSignOut();
      setMenuOpen(false);
    } finally {
      setSigningOut(false);
    }
  }

  if (communitySession.loggedIn) {
    return (
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          className="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded border border-transparent bg-transparent px-2.5 py-0 text-xs font-medium text-[var(--color-app-btn-text)] transition-colors hover:bg-[var(--color-app-btn-bg-hover)] hover:text-[var(--color-app-btn-text-hover)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Account menu"
          title={communitySession.account || "Signed in"}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden className="shrink-0">
            <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
            <path
              d="M6 21c0-3.3 2.7-6 6-6s6 2.7 6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span className="whitespace-nowrap">{communitySession.account || "Signed in"}</span>
        </button>
        {menuOpen ? (
          <div
            className="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-md border border-[var(--color-emulator-toolbar-border)] bg-[var(--color-emulator-toolbar-bg)] py-1 shadow-sm"
            role="menu"
          >
            <button
              type="button"
              className="w-full border-0 bg-transparent px-3 py-1.5 text-left text-[13px] font-medium text-[var(--color-emulator-toolbar-label)] transition-colors hover:bg-[var(--color-emulator-toolbar-bg-hover)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              role="menuitem"
            >
              {signingOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={chromeIconBtnClass}
      onClick={onAuthRequired}
      aria-label="Sign in"
      title="Sign in"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="M6 21c0-3.3 2.7-6 6-6s6 2.7 6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

function extractPartialStringField(argumentsJson: string, fieldName: string): string | null {
  const key = `"${fieldName}"`;
  const keyAt = argumentsJson.indexOf(key);
  if (keyAt < 0) {
    return null;
  }
  const colonAt = argumentsJson.indexOf(":", keyAt + key.length);
  if (colonAt < 0) {
    return null;
  }
  const quoteAt = argumentsJson.indexOf("\"", colonAt + 1);
  if (quoteAt < 0) {
    return null;
  }
  let out = "";
  for (let i = quoteAt + 1; i < argumentsJson.length; i += 1) {
    const ch = argumentsJson[i];
    if (ch === "\\") {
      const next = argumentsJson[i + 1];
      if (next === "n") {
        out += "\n";
      } else if (next === "t") {
        out += "\t";
      } else if (next === "r") {
        out += "\r";
      } else if (next === "\"" || next === "\\" || next === "/") {
        out += next;
      } else if (next) {
        out += next;
      } else {
        break;
      }
      i += 1;
      continue;
    }
    if (ch === "\"") {
      return out;
    }
    out += ch;
  }
  return out;
}

function summarizeFileToolCallDelta(event: Extract<AgentEvent, { type: "tool_call_delta" }>): string {
  const args = event.argumentsJson ?? "";
  const trimmedPath = typeof event.path === "string" && event.path.trim() ? event.path.trim() : "file";
  if (event.toolName === "write_file") {
    const contentSoFar = extractPartialStringField(args, "content");
    const lineCount = contentSoFar ? contentSoFar.split(/\r?\n/).length : 0;
    return `Creating ${trimmedPath} +${lineCount}`;
  }
  if (event.toolName === "replace_in_file") {
    const findSoFar = extractPartialStringField(args, "find");
    const replaceSoFar = extractPartialStringField(args, "replace");
    const findLines = findSoFar ? findSoFar.split(/\r?\n/).length : 0;
    const replaceLines = replaceSoFar ? replaceSoFar.split(/\r?\n/).length : 0;
    return `Editing ${trimmedPath} +${replaceLines} -${findLines}`;
  }
  return `Running ${event.toolName}…`;
}


export function App() {
  useWindowChromeInsets();

  useLayoutEffect(() => {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const platform = /Macintosh|Mac OS X/i.test(ua)
      ? "darwin"
      : /Windows/i.test(ua)
        ? "win32"
        : "linux";
    document.documentElement.dataset.platform = platform;
  }, []);

  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([
    { id: "greeting-initial", role: "agent", text: GREETING_TEXT }
  ]);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [pythonRuntimeStatus, setPythonRuntimeStatus] = useState<string | null>(null);
  const [pythonRuntimeProgress, setPythonRuntimeProgress] = useState<PythonRuntimeProgress>({
    running: false,
    stage: null,
    percent: 0,
    message: null
  });
  const [screen, setScreen] = useState<AppScreen>("main");
  /** Preserves widget/game creator routing for follow-up prompts after the first send. */
  const [sessionTemplateMode, setSessionTemplateMode] = useState<
    "game-creator" | "widget-creator" | null
  >(null);
  const [sessionWidgetSize, setSessionWidgetSize] = useState<WidgetSize | null>(null);
  const [sessionProjectType, setSessionProjectType] = useState<ProjectType | null>(null);
  const [tokenUsage, setTokenUsage] = useState<AgentSessionTokenUsage | null>(null);
  /** Shown until intake records project type (`intake_project_type_prompt` from host). */
  const [projectTypePicker, setProjectTypePicker] = useState<{
    visible: boolean;
    types: ProjectType[];
  }>({ visible: false, types: [] });
  /** Shown after intake records `widget` but not yet `set_widget_size` (host pushes `intake_widget_size_prompt`). */
  const [widgetSizePicker, setWidgetSizePicker] = useState<{
    visible: boolean;
    sizes: WidgetSize[];
  }>({ visible: false, sizes: [] });
  const [machineMcpPicker, setMachineMcpPicker] = useState<{
    visible: boolean;
    machines: MachineMcpQuestionMachine[];
    manualOnly: boolean;
  }>({ visible: false, machines: [], manualOnly: true });
  const [machineMcpManualIp, setMachineMcpManualIp] = useState("");
  const [machineMcpInputError, setMachineMcpInputError] = useState<string | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const eventSeqRef = useRef(0);
  const activeStreamEntryIdRef = useRef<string | null>(null);
  const activeStreamDeltaRef = useRef("");
  const activeReasoningStreamEntryIdRef = useRef<string | null>(null);
  const activeReasoningIdRef = useRef<string | null>(null);
  const activeReasoningStreamDeltaRef = useRef("");
  const activeReasoningStartedAtRef = useRef<number | null>(null);
  const activeToolStatusEntryByKeyRef = useRef<Map<string, string>>(new Map());
  /** After session reset / new project, discard agent stream events until the next user send. */
  const discardAgentEventsRef = useRef(false);
  const lastAgentSessionHydrateKeyRef = useRef<string>("");
  const timelineRef = useRef<HTMLElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerExpandedSticky, setComposerExpandedSticky] = useState(false);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [providerSettingsError, setProviderSettingsError] = useState<string | null>(null);
  const [providerSettingsNotice, setProviderSettingsNotice] = useState<string | null>(null);
  const [savingProviderSettings, setSavingProviderSettings] = useState(false);
  const [assetManifest, setAssetManifest] = useState<AssetManifest | null>(null);
  const [pendingChangeSlotIds, setPendingChangeSlotIds] = useState<string[]>([]);
  const [rightPaneTab, setRightPaneTab] = useState<RightPaneTab>("emulator");
  const [deployPaneTab, setDeployPaneTab] = useState<DeployPaneTab>("deploy");
  const [deployEligibility, setDeployEligibility] = useState<DeployEligibility>({
    ok: false,
    reason: "no_workspace"
  });
  const [widgetParamsText, setWidgetParamsText] = useState("{}");
  const [widgetParamsError, setWidgetParamsError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeId>(() => resolveThemeFromEnvironment());
  const [communitySession, setCommunitySession] = useState<CommunitySessionInfo>({
    loggedIn: false,
    account: null,
    hasSupabase: false,
    googleClientId: "",
    googleDesktopClientId: "",
    googleSignInAvailable: false
  });
  const [deployAuthGateOpen, setDeployAuthGateOpen] = useState(false);
  const [communityAuthIntent, setCommunityAuthIntent] = useState<CommunityAuthIntent>("deploy-devices");
  const [communityAuthSkippedVersion, setCommunityAuthSkippedVersion] = useState(0);
  const [communitySessionVersion, setCommunitySessionVersion] = useState(0);
  const [submissionLock, setSubmissionLock] = useState<SubmissionLockState>({
    active: false,
    stage: "idle",
    message: "Preparing submission..."
  });
  const [appUpdate, setAppUpdate] = useState<UpdatePromptState | null>(null);

  const api = window.dartsnutApi;

  const handleCommunitySubmitProgress = useCallback((progress: CommunitySubmitProgress | null) => {
    if (!progress) {
      setSubmissionLock((current) => ({ ...current, active: false, stage: "idle" }));
      return;
    }
    setSubmissionLock({
      active: true,
      stage: progress.stage,
      message: progress.message
    });
  }, []);

  const handleInstallAppUpdateNow = useCallback(() => {
    if (!api?.installAppUpdateNow) {
      return;
    }
    setAppUpdate((current) => current ? { ...current, installing: true, error: null } : current);
    void api.installAppUpdateNow().then((result) => {
      if (!result.ok) {
        setAppUpdate((current) =>
          current
            ? {
                ...current,
                installing: false,
                error:
                  result.reason === "cancelled"
                    ? null
                    : "The downloaded update is no longer ready. It will be checked again on next launch."
              }
            : current
        );
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Could not start the update.";
      setAppUpdate((current) => current ? { ...current, installing: false, error: message } : current);
    });
  }, [api]);

  const handleUpdateNextLaunch = useCallback(() => {
    setAppUpdate((current) =>
      current
        ? {
            ...current,
            dismissedVersion: current.availableVersion,
            installing: false,
            error: null
          }
        : current
    );
  }, []);

  const refreshCommunitySession = useCallback(async () => {
    if (!api?.communityGetSession) {
      return;
    }
    try {
      const session = await api.communityGetSession();
      setCommunitySession((prev) => {
        const changed =
          prev.loggedIn !== session.loggedIn ||
          prev.account !== session.account ||
          prev.hasSupabase !== session.hasSupabase ||
          prev.googleClientId !== session.googleClientId ||
          prev.googleDesktopClientId !== session.googleDesktopClientId ||
          prev.googleSignInAvailable !== session.googleSignInAvailable;
        if (changed) {
          setCommunitySessionVersion((v) => v + 1);
          return session;
        }
        return prev;
      });
    } catch {
      // keep previous session snapshot
    }
  }, [api]);

  useEffect(() => {
    void refreshCommunitySession();
  }, [refreshCommunitySession]);

  useEffect(() => {
    if (communitySession.loggedIn) {
      setDeployAuthGateOpen(false);
    }
  }, [communitySession.loggedIn]);

  const requestCommunityAuth = useCallback((intent: CommunityAuthIntent) => {
    setCommunityAuthIntent(intent);
    if (!communitySession.loggedIn && !isCommunityAuthSkippedForSession()) {
      setDeployAuthGateOpen(true);
    }
  }, [communitySession.loggedIn]);

  const requestDeployCommunityAuth = useCallback(() => {
    requestCommunityAuth("deploy-devices");
  }, [requestCommunityAuth]);

  const requestMyGamesCommunityAuth = useCallback(() => {
    requestCommunityAuth("my-games");
  }, [requestCommunityAuth]);

  const toggleReasoningEntry = useCallback((entryId: string) => {
    setEntries((prev) =>
      prev.map((candidate) =>
        candidate.id === entryId
          ? {
            ...candidate,
            reasoningMode: candidate.reasoningMode === "expanded" ? "summary" : "expanded"
          }
          : candidate
      )
    );
  }, []);

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function handleThemeChange(next: ThemeId) {
    setTheme(next);
  }

  function clearActiveCoalescedStreamEntries(): void {
    activeStreamEntryIdRef.current = null;
    activeStreamDeltaRef.current = "";
    activeReasoningStreamEntryIdRef.current = null;
    activeReasoningIdRef.current = null;
    activeReasoningStreamDeltaRef.current = "";
    activeReasoningStartedAtRef.current = null;
  }

  function toolStatusKey(meta: { callId?: string; toolName?: string; filePath?: string }): string | null {
    if (meta.callId) {
      return `call:${meta.callId}`;
    }
    if (!meta.toolName) {
      return null;
    }
    return `${meta.toolName}\0${meta.filePath ?? ""}`;
  }

  function mergeSkillStatusIntoTimeline(entry: TimelineEntry): void {
    const seq = eventSeqRef.current;
    eventSeqRef.current += 1;
    setEntries((prev) => {
      const priorIdx = prev.findIndex(
        (candidate) =>
          candidate.role === "status" &&
          candidate.toolStatusMeta?.toolName === "get_dartsnut_skill"
      );
      if (priorIdx >= 0) {
        return prev.map((candidate, idx) =>
          idx === priorIdx ? mergeTimelineSkillStatusEntry(candidate, entry) : candidate
        );
      }
      const id = `evt-${seq}-${Date.now()}`;
      return [
        ...prev,
        mergeTimelineSkillStatusEntry(
          {
            id,
            role: "status",
            text: "Loaded Dartsnut skills.",
            toolStatusMeta: { toolName: "get_dartsnut_skill", phase: "result" }
          },
          { ...entry, id }
        )
      ];
    });
  }

  function appendRawAgentEvent(event: AgentEvent): void {
    clearActiveCoalescedStreamEntries();
    const seq = eventSeqRef.current;
    eventSeqRef.current += 1;
    const role = agentEventTimelineRole(event);
    setEntries((prev) => [
      ...prev,
      { id: `evt-${seq}-${event.at}`, role, text: formatAgentEventForTimeline(event) }
    ]);
  }

  function appendOrPatchReasoningStream(event: Extract<AgentEvent, { type: "reasoning_stream" }>): void {
    const activeId = activeReasoningStreamEntryIdRef.current;
    const activeReasoningId = activeReasoningIdRef.current;
    if (!activeId || (activeReasoningId && activeReasoningId !== event.reasoningId)) {
      const seq = eventSeqRef.current;
      eventSeqRef.current += 1;
      const id = `evt-${seq}-${event.at}`;
      activeReasoningStreamEntryIdRef.current = id;
      activeReasoningIdRef.current = event.reasoningId;
      activeReasoningStreamDeltaRef.current = event.delta;
      activeReasoningStartedAtRef.current = event.at;
      setEntries((prev) => [
        ...prev,
        {
          id,
          role: "status",
          text: activeReasoningStreamDeltaRef.current,
          reasoningMode: "delta",
          reasoningFullText: activeReasoningStreamDeltaRef.current
        }
      ]);
      return;
    }

    activeReasoningStreamDeltaRef.current += event.delta;
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === activeId
          ? {
            ...entry,
            text: activeReasoningStreamDeltaRef.current,
            reasoningMode: "delta",
            reasoningFullText: activeReasoningStreamDeltaRef.current
          }
          : entry
      )
    );
  }

  function formatReasoningElapsedSeconds(startAt: number, endAt: number): string {
    const secs = Math.max(0, (endAt - startAt) / 1000);
    if (secs < 10) {
      return secs.toFixed(1);
    }
    return Math.round(secs).toString();
  }

  function appendOrPatchStream(event: Extract<AgentEvent, { type: "stream" }>): void {
    const activeId = activeStreamEntryIdRef.current;
    if (!activeId) {
      const seq = eventSeqRef.current;
      eventSeqRef.current += 1;
      const id = `evt-${seq}-${event.at}`;
      activeStreamEntryIdRef.current = id;
      activeStreamDeltaRef.current = event.delta;
      setEntries((prev) => [
        ...prev,
        {
          id,
          role: "agent",
          text: activeStreamDeltaRef.current
        }
      ]);
      return;
    }

    activeStreamDeltaRef.current += event.delta;
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === activeId ? { ...entry, text: activeStreamDeltaRef.current } : entry
      )
    );
  }

  function isTimelineNearBottom(element: HTMLElement): boolean {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= AUTO_SCROLL_BOTTOM_THRESHOLD;
  }

  function scrollTimelineToBottom() {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const maxScroll = timeline.scrollHeight - timeline.clientHeight;
    timeline.scrollTop = maxScroll > 0 ? maxScroll : 0;
  }


  function syncComposerPromptHeight() {
    const el = promptInputRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    const scrollH = el.scrollHeight;
    const capped = Math.min(scrollH, COMPOSER_PROMPT_MAX_HEIGHT_PX);
    el.style.height = `${capped}px`;
    el.style.overflowY = scrollH > COMPOSER_PROMPT_MAX_HEIGHT_PX ? "auto" : "hidden";
    const computed = window.getComputedStyle(el);
    const computedLineHeightPx = Number.parseFloat(computed.lineHeight);
    const lineHeightPx = Number.isFinite(computedLineHeightPx) && computedLineHeightPx > 0
      ? computedLineHeightPx
      : 18;
    const paddingTopPx = Number.parseFloat(computed.paddingTop);
    const paddingBottomPx = Number.parseFloat(computed.paddingBottom);
    const minHeightPx = Number.parseFloat(computed.minHeight);
    const verticalPaddingPx =
      (Number.isFinite(paddingTopPx) ? paddingTopPx : 0) +
      (Number.isFinite(paddingBottomPx) ? paddingBottomPx : 0);
    const hasInput = el.value.length > 0;
    if (!hasInput) {
      setComposerExpandedSticky(false);
      return;
    }
    const contentSingleLineHeightPx = lineHeightPx + verticalPaddingPx;
    const baselineSingleLineHeightPx = Number.isFinite(minHeightPx) && minHeightPx > 0
      ? Math.max(contentSingleLineHeightPx, minHeightPx)
      : contentSingleLineHeightPx;
    const isVisuallyMultiline =
      scrollH > baselineSingleLineHeightPx + COMPOSER_PROMPT_MULTILINE_EPSILON_PX;
    if (isVisuallyMultiline) {
      setComposerExpandedSticky((prev) => prev || true);
    }
  }

  useLayoutEffect(() => {
    syncComposerPromptHeight();
  }, [prompt]);

  useEffect(() => {
    const onResize = () => {
      syncComposerPromptHeight();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    scrollTimelineToBottom();
  }, []);

  useLayoutEffect(() => {
    if (!autoScrollEnabled) {
      return;
    }
    scrollTimelineToBottom();
  }, [entries, autoScrollEnabled]);

  useEffect(() => {
    if (!api) {
      setRuntimeError("Desktop bridge is unavailable. Please restart the app.");
      return;
    }

    api.getBootstrapState().then(setBootstrap).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Failed to load bootstrap state.";
      setRuntimeError(message);
    });
    const unsubscribeBootstrap = api.onBootstrapStateChanged(setBootstrap);
    api.getProviderSettings().then(setProviderSettings).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Failed to load provider settings.";
      setProviderSettingsError(message);
    });
    api.getPythonRuntimeStatus().then(setPythonRuntimeStatus).catch(() => {
      setPythonRuntimeStatus(null);
    });
    api.getPythonRuntimeProgress().then(setPythonRuntimeProgress).catch(() => {
      setPythonRuntimeProgress({ running: false, stage: null, percent: 0, message: null });
    });
    api.getAppUpdateStatus?.().then((status) => {
      setAppUpdate((current) => ({
        ...status,
        dismissedVersion:
          current?.dismissedVersion === status.availableVersion ? current.dismissedVersion : null,
        installing: false,
        error: null
      }));
    }).catch(() => {
      // Update checks are best effort.
    });
    const unsubscribe = api.onAgentEvent((event) => {
      if (discardAgentEventsRef.current) {
        return;
      }
      if (event.type === "intake_project_type_prompt") {
        if (event.visible) {
          setMachineMcpPicker({ visible: false, machines: [], manualOnly: true });
        }
        setProjectTypePicker({
          visible: event.visible,
          types:
            event.visible && event.options && event.options.length > 0
              ? event.options
              : event.visible
                ? [...CREATION_INTAKE_PROJECT_TYPES]
                : []
        });
        return;
      }
      if (event.type === "intake_widget_size_prompt") {
        if (event.visible) {
          setMachineMcpPicker({ visible: false, machines: [], manualOnly: true });
        }
        setWidgetSizePicker({
          visible: event.visible,
          sizes:
            event.visible && event.sizes && event.sizes.length > 0
              ? event.sizes
              : event.visible
                ? [...WIDGET_DISPLAY_SIZES]
                : []
        });
        return;
      }
      if (event.type === "machine_mcp_prompt") {
        if (event.visible) {
          setProjectTypePicker({ visible: false, types: [] });
          setWidgetSizePicker({ visible: false, sizes: [] });
          setMachineMcpManualIp("");
          setMachineMcpInputError(null);
        }
        setMachineMcpPicker({
          visible: event.visible,
          machines: event.visible && event.machines ? event.machines : [],
          manualOnly: event.visible ? event.manualOnly === true || !event.machines?.length : true
        });
        return;
      }
      if (event.type === "token_usage") {
        setTokenUsage(event.sessionUsage);
        return;
      }
      if (event.type === "reasoning_stream") {
        appendOrPatchReasoningStream(event);
        return;
      }
      if (event.type === "stream") {
        appendOrPatchStream(event);
        return;
      }
      if (event.type === "tool_call_delta") {
        clearActiveCoalescedStreamEntries();
        const key = toolStatusKey({ callId: event.callId, toolName: event.toolName, filePath: event.path });
        if (!key) {
          return;
        }
        const priorId = activeToolStatusEntryByKeyRef.current.get(key);
        const text = summarizeFileToolCallDelta(event);
        if (priorId) {
          setEntries((prev) =>
            prev.map((entry) =>
              entry.id === priorId
                ? {
                  ...entry,
                  role: "status",
                  text,
                  toolStatusMeta: {
                    callId: event.callId,
                    toolName: event.toolName,
                    phase: "call",
                    filePath: event.path
                  }
                }
                : entry
            )
          );
          return;
        }
        const seq = eventSeqRef.current;
        eventSeqRef.current += 1;
        const id = `evt-${seq}-${event.at}`;
        setEntries((prev) => [
          ...prev,
          {
            id,
            role: "status",
            text,
            toolStatusMeta: {
              callId: event.callId,
              toolName: event.toolName,
              phase: "call",
              filePath: event.path
            }
          }
        ]);
        activeToolStatusEntryByKeyRef.current.set(key, id);
        return;
      }
      if (event.type === "reasoning_done") {
        const activeId = activeReasoningStreamEntryIdRef.current;
        const activeReasoningId = activeReasoningIdRef.current;
        const startedAt = activeReasoningStartedAtRef.current;
        if (activeId && startedAt != null && activeReasoningId === event.reasoningId) {
          const elapsed = formatReasoningElapsedSeconds(startedAt, event.at);
          setEntries((prev) =>
            prev.map((entry) =>
              entry.id === activeId
                ? { ...entry, text: `Thought for ${elapsed} s`, reasoningMode: "summary" }
                : entry
            )
          );
        }
        if (activeReasoningId === event.reasoningId) {
          activeReasoningStreamEntryIdRef.current = null;
          activeReasoningIdRef.current = null;
          activeReasoningStreamDeltaRef.current = "";
          activeReasoningStartedAtRef.current = null;
        }
        return;
      }
      if (event.type === "status") {
        if (event.message.startsWith("[agent_eval]")) {
          return;
        }
        clearActiveCoalescedStreamEntries();
        const seq = eventSeqRef.current;
        eventSeqRef.current += 1;
        const parsed = parseToolStatusMessage(event.message);
        const meta = parsed.meta;
        if (shouldHideTimelineStatus({ text: parsed.text, toolStatusMeta: meta })) {
          return;
        }
        if (meta?.toolName === "get_dartsnut_skill" && meta.phase === "call") {
          return;
        }
        if (meta?.toolName === "get_dartsnut_skill" && meta.phase === "result") {
          mergeSkillStatusIntoTimeline({
            id: `evt-${seq}-${event.at}`,
            role: "status",
            text: parsed.text,
            toolStatusMeta: meta
          });
          return;
        }
        const key = meta ? toolStatusKey(meta) : null;
        if (meta?.phase === "result" && key) {
          const priorId = activeToolStatusEntryByKeyRef.current.get(key);
          if (priorId) {
            setEntries((prev) =>
              prev.map((entry) =>
                entry.id === priorId
                  ? {
                    ...entry,
                    text: parsed.text,
                    ...(meta ? { toolStatusMeta: meta } : {})
                  }
                  : entry
              )
            );
            activeToolStatusEntryByKeyRef.current.delete(key);
            return;
          }
        }
        if (meta?.phase === "call" && key) {
          const priorId = activeToolStatusEntryByKeyRef.current.get(key);
          if (priorId) {
            setEntries((prev) =>
              prev.map((entry) =>
                entry.id === priorId
                  ? {
                    ...entry,
                    text: parsed.text,
                    ...(meta ? { toolStatusMeta: meta } : {})
                  }
                  : entry
              )
            );
            return;
          }
        }
        const id = `evt-${seq}-${event.at}`;
        setEntries((prev) => [
          ...prev,
          {
            id,
            role: "status",
            text: parsed.text,
            ...(meta ? { toolStatusMeta: meta } : {})
          }
        ]);
        if (meta?.phase === "call" && key) {
          activeToolStatusEntryByKeyRef.current.set(key, id);
        }
        return;
      }
      if (event.type === "final") {
        activeToolStatusEntryByKeyRef.current.clear();
        if (
          activeStreamEntryIdRef.current &&
          activeStreamDeltaRef.current.trim() === event.content.trim()
        ) {
          activeStreamEntryIdRef.current = null;
          activeStreamDeltaRef.current = "";
          return;
        }
        const seq = eventSeqRef.current;
        eventSeqRef.current += 1;
        const id = `evt-${seq}-${event.at}`;
        setEntries((prev) => {
          const last = prev.length > 0 ? prev[prev.length - 1] : null;
          if (last && last.role === "agent" && last.text.trim() === event.content.trim()) {
            return prev;
          }
          return [...prev, { id, role: "agent", text: event.content }];
        });
        return;
      }
      appendRawAgentEvent(event);
    });
    const unsubscribePythonRuntime = api.onPythonRuntimeStatus((status) => {
      setPythonRuntimeStatus(status);
      if (status) {
        devLog.info("[python-runtime]", status);
      }
    });
    const unsubscribePythonRuntimeProgress = api.onPythonRuntimeProgress((progress) => {
      setPythonRuntimeProgress(progress);
      if (progress.message) {
        devLog.info("[python-runtime-progress]", progress);
      }
    });
    const unsubscribeCommunitySubmitProgress =
      api.onCommunitySubmitProgress?.((progress) => {
        setSubmissionLock((current) =>
          current.active
            ? {
                active: true,
                stage: progress.stage,
                message: progress.message
              }
            : current
        );
      }) ?? (() => {});
    const unsubscribeAppUpdateStatus =
      api.onAppUpdateStatus?.((status) => {
        setAppUpdate((current) => ({
          ...status,
          dismissedVersion:
            current?.dismissedVersion === status.availableVersion ? current.dismissedVersion : null,
          installing: false,
          error: null
        }));
      }) ?? (() => {});
    const unsubscribeMainConsoleMirror = isDevLoggingEnabled()
      ? api.onMainProcessConsoleMirror((payload) => {
          printMainProcessMirrorToDevtools(payload);
        })
      : () => {};
    return () => {
      unsubscribe();
      unsubscribeBootstrap();
      unsubscribePythonRuntime();
      unsubscribePythonRuntimeProgress();
      unsubscribeCommunitySubmitProgress();
      unsubscribeAppUpdateStatus();
      unsubscribeMainConsoleMirror();
    };
  }, [api]);

  useEffect(() => {
    if (!api?.assets) {
      setAssetManifest(null);
      setPendingChangeSlotIds([]);
      return;
    }
    const workspacePath = bootstrap?.workspaceRoot ?? null;
    if (!workspacePath) {
      setAssetManifest(null);
      setPendingChangeSlotIds([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const snapshot = await api.assets.getManifest(workspacePath);
      if (cancelled || snapshot.workspacePath !== workspacePath) {
        return;
      }
      setAssetManifest(snapshot.manifest);
      setPendingChangeSlotIds(snapshot.pendingChangeSlotIds);
    })();
    const unsubscribe = api.assets.onManifest((snapshot: ManifestSnapshot) => {
      if (snapshot.workspacePath !== workspacePath) {
        return;
      }
      setAssetManifest(snapshot.manifest);
      setPendingChangeSlotIds(snapshot.pendingChangeSlotIds);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, bootstrap?.workspaceRoot]);

  useEffect(() => {
    if (!api || !bootstrap?.workspaceRoot) {
      setDeployEligibility({ ok: false, reason: "no_workspace" });
      return;
    }
    let cancelled = false;
    void api.deployGetEligibility().then((result) => {
      if (!cancelled) {
        setDeployEligibility(result);
      }
    });
    const unsubscribe = api.onDeployEligibility((result) => {
      if (!cancelled) {
        setDeployEligibility(result);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, bootstrap?.workspaceRoot]);

  const deployEligible = deployEligibility.ok;
  const deployPanelShowsWidgetParams = deployEligible && deployEligibility.projectType === "widget";
  const communityWorkspaceRefreshKey = [
    bootstrap?.workspaceRoot ?? "",
    deployEligibility.ok ? deployEligibility.appId : "",
    deployEligibility.ok ? deployEligibility.projectType : deployEligibility.reason
  ].join("|");
  const communityAuthSkipped = communityAuthSkippedVersion >= 0 && isCommunityAuthSkippedForSession();
  const gamesTabDisabled = !communitySession.loggedIn && communityAuthSkipped;
  const visibleAppUpdate =
    appUpdate?.kind === "ready" && appUpdate.dismissedVersion !== appUpdate.availableVersion
      ? appUpdate
      : null;

  // Reset to Emulator tab when the active tab is no longer available.
  useEffect(() => {
    if (!assetManifest && rightPaneTab === "assets") {
      setRightPaneTab("emulator");
    }
  }, [assetManifest, deployEligible, rightPaneTab]);

  useEffect(() => {
    if (!deployEligible || (gamesTabDisabled && deployPaneTab === "games")) {
      setDeployPaneTab("deploy");
    }
  }, [deployEligible, deployPaneTab, gamesTabDisabled]);

  useEffect(() => {
    const ws = bootstrap?.workspaceRoot;
    if (!api || !ws) {
      lastAgentSessionHydrateKeyRef.current = "";
      return;
    }
    if (lastAgentSessionHydrateKeyRef.current === ws) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const summary = await api.getWorkspaceSessionSummary();
      if (cancelled) {
        return;
      }
      lastAgentSessionHydrateKeyRef.current = ws;
      setTokenUsage(summary.tokenUsage ?? null);
      if (!summary.hasPersistedSession || summary.transcriptTail.length === 0) {
        setEntries([{ id: "greeting-initial", role: "agent", text: GREETING_TEXT }]);
        return;
      }
      const hydrated = summary.transcriptTail
        .map((line, idx) => transcriptLineToTimelineEntry(line, idx))
        .filter((entry): entry is TimelineEntry => entry != null);
      const toolCallEntryIndexByKey = new Map<string, number>();
      const deduped: TimelineEntry[] = [];
      for (const entry of hydrated) {
        if (entry.role === "status" && entry.toolStatusMeta?.toolName === "get_dartsnut_skill") {
          const priorIdx = deduped.findIndex(
            (candidate) =>
              candidate.role === "status" &&
              candidate.toolStatusMeta?.toolName === "get_dartsnut_skill"
          );
          if (priorIdx >= 0) {
            deduped[priorIdx] = mergeTimelineSkillStatusEntry(deduped[priorIdx], entry);
            continue;
          }
          deduped.push(
            mergeTimelineSkillStatusEntry(
              {
                id: entry.id,
                role: "status",
                text: "Loaded Dartsnut skills.",
                toolStatusMeta: { toolName: "get_dartsnut_skill", phase: "result" }
              },
              entry
            )
          );
          continue;
        }
        if (entry.role === "status" && entry.toolStatusMeta) {
          const key = toolStatusKey(entry.toolStatusMeta);
          if (entry.toolStatusMeta.phase === "result" && key) {
            const priorIdx = toolCallEntryIndexByKey.get(key);
            if (typeof priorIdx === "number") {
              deduped[priorIdx] = { ...deduped[priorIdx], ...entry };
              toolCallEntryIndexByKey.delete(key);
              continue;
            }
          }
          if (entry.toolStatusMeta.phase === "call" && key) {
            toolCallEntryIndexByKey.set(key, deduped.length);
          }
        }
        const prev = deduped.length > 0 ? deduped[deduped.length - 1] : null;
        if (
          prev &&
          prev.role === "agent" &&
          entry.role === "agent" &&
          prev.text.trim() === entry.text.trim()
        ) {
          continue;
        }
        deduped.push(entry);
      }
      setEntries(deduped);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, bootstrap?.workspaceRoot]);

  const chatDisabled = useMemo(() => {
    if (!bootstrap) {
      return true;
    }
    return sending;
  }, [bootstrap, sending]);
  const showRuntimeSetup = pythonRuntimeProgress.running || Boolean(pythonRuntimeProgress.error);
  const runtimeProgressPercent = Math.min(100, Math.max(0, Math.round(pythonRuntimeProgress.percent)));

  useEffect(() => {
    if (!api) {
      return;
    }
    return api.onSessionReset(() => {
      resetChatSessionUi();
    });
  }, [api]);

  function resetChatSessionUi() {
    discardAgentEventsRef.current = true;
    clearActiveCoalescedStreamEntries();
    activeToolStatusEntryByKeyRef.current.clear();
    eventSeqRef.current = 0;
    lastAgentSessionHydrateKeyRef.current = "";
    setSessionTemplateMode(null);
    setSessionWidgetSize(null);
    setSessionProjectType(null);
    setTokenUsage(null);
    setWidgetSizePicker({ visible: false, sizes: [] });
    setProjectTypePicker({ visible: false, types: [] });
    setPrompt("");
    setRuntimeError(null);
    setEntries([{ id: `greeting-${Date.now()}`, role: "agent", text: GREETING_TEXT }]);
  }

  async function isChatSectionNonEmpty(): Promise<boolean> {
    const hasUserMessage = entries.some((entry) => entry.role === "user");
    const hasNonGreetingAgent = entries.some(
      (entry) =>
        entry.role === "agent" &&
        entry.id !== "greeting-initial" &&
        !entry.id.startsWith("greeting-")
    );
    if (hasUserMessage || hasNonGreetingAgent) {
      return true;
    }
    if (!api) {
      return false;
    }
    try {
      const summary = await api.getWorkspaceSessionSummary();
      return summary.transcriptTail.length > 0;
    } catch {
      return false;
    }
  }

  function postStatus(text: string) {
    setEntries((prev) => [...prev, { id: `status-${Date.now()}`, role: "status", text }]);
  }

  async function submitPrompt(request: PromptRequest) {
    setWidgetSizePicker({ visible: false, sizes: [] });
    setProjectTypePicker({ visible: false, types: [] });
    discardAgentEventsRef.current = false;
    setSending(true);
    if (!api) {
      setSending(false);
      return;
    }
    try {
      const result: SendPromptResponse = await api.sendPrompt(request);
      const refreshed = await api.getBootstrapState();
      setBootstrap(refreshed);
      if (result.ok && result.sessionRouting) {
        setSessionTemplateMode(result.sessionRouting.templateMode);
        setSessionProjectType(result.sessionRouting.projectType);
        setSessionWidgetSize(result.sessionRouting.widgetSize ?? null);
      }
    } finally {
      setSending(false);
    }
  }

  async function handlePickWorkspace() {
    if (!api || sending) {
      return;
    }
    const updated = await api.pickWorkspace();
    setBootstrap(updated.state);
  }

  async function handleSaveTempWorkspace() {
    if (!api || sending) {
      return;
    }
    try {
      const result: SaveTempWorkspaceResponse = await api.saveTempWorkspace();
      if (!result.ok) {
        if (result.reason !== "cancelled") {
          postStatus(result.message ?? `Could not save workspace (${result.reason}).`);
        }
        return;
      }
      setBootstrap(result.state);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Save failed.";
      setRuntimeError(message);
    }
  }

  async function handleStartNewProject() {
    if (!api || sending) {
      return;
    }
    if (!bootstrap?.isTemporaryWorkspace) {
      const confirmed = window.confirm(
        "Start a new project?\n\n" +
          "Your game files on disk stay saved.\n\n" +
          "This will leave the current workspace unset, stop the emulator, clear emulator logs, and clear this chat.",
      );
      if (!confirmed) {
        return;
      }
    }
    try {
      const refreshed = await api.startNewProject();
      setBootstrap(refreshed);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not start a new project.";
      setRuntimeError(message);
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isSettingsShortcut(event)) {
        event.preventDefault();
        setScreen("settings");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleSaveProviderSettings() {
    if (!api) {
      setProviderSettingsError("Desktop bridge is unavailable.");
      return;
    }
    setProviderSettingsError(null);
    setProviderSettingsNotice(null);
    const custom = providerCustom(providerSettings);
    if (providerSettings.activeProvider === "custom") {
      if (!custom.apiKey.trim()) {
        setProviderSettingsError("API key is required.");
        return;
      }
      if (!custom.model.trim()) {
        setProviderSettingsError("Model is required.");
        return;
      }
      if (custom.baseUrl.trim()) {
        try {
          new URL(custom.baseUrl.trim());
        } catch {
          setProviderSettingsError("Endpoint must be a valid URL.");
          return;
        }
      }
    }
    setSavingProviderSettings(true);
    try {
      const saved = await api.saveProviderSettings({
        activeProvider: providerSettings.activeProvider,
        custom: {
          baseUrl: custom.baseUrl,
          apiKey: custom.apiKey,
          model: custom.model
        }
      });
      setProviderSettings(saved);
      setProviderSettingsNotice("Settings saved. The LLM client was refreshed.");
      const refreshed = await api.getBootstrapState();
      setBootstrap(refreshed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save provider settings.";
      setProviderSettingsError(message);
    } finally {
      setSavingProviderSettings(false);
    }
  }

  async function handleProjectTypeChip(projectType: ProjectType) {
    if (!api) {
      return;
    }
    const res = await api.intakeSubmitQuestionAnswer({ kind: "project_type", value: projectType });
    if (!res.ok) {
      if (res.reason === "no_pending") {
        postStatus("Nothing is waiting for a Game/Widget choice right now — send your idea in the chat first.");
      } else if (res.reason === "kind_mismatch" || res.reason === "invalid_value") {
        postStatus("That choice does not match the current question.");
      }
    }
  }

  async function handleWidgetSizeChip(size: WidgetSize) {
    if (!api) {
      return;
    }
    const res = await api.intakeSubmitQuestionAnswer({ kind: "widget_size", value: size });
    if (!res.ok) {
      if (res.reason === "no_pending") {
        postStatus("Nothing is waiting for a widget size choice right now.");
      } else if (res.reason === "kind_mismatch" || res.reason === "invalid_value") {
        postStatus("That choice does not match the current question.");
      }
    }
  }

  async function handleMachineMcpChoice(value: string) {
    if (!api) {
      return;
    }
    const machine = machineMcpPicker.machines.find((entry) => entry.deviceId === value);
    if (!machine) {
      postStatus("That machine is no longer available.");
      return;
    }
    const res = await api.machineMcpSubmitQuestionAnswer({
      kind: "machine",
      deviceId: machine.deviceId,
      ipAddress: machine.ipAddress
    });
    if (!res.ok) {
      postStatus("The machine selection could not be used. Enter the IP manually.");
    }
  }

  async function handleMachineMcpManualIp(value: string) {
    if (!api) {
      return;
    }
    if (!isValidMachineHost(value)) {
      setMachineMcpInputError("Enter an IP or host, without path/query text.");
      return;
    }
    const res = await api.machineMcpSubmitQuestionAnswer({ kind: "manual_ip", value });
    if (!res.ok) {
      setMachineMcpInputError("That address could not be used.");
    }
  }

  async function handleSend() {
    if (!prompt.trim() || chatDisabled) {
      return;
    }
    if (bootstrap?.providerStatus !== "ready") {
      postStatus("Provider settings are incomplete. Open Settings and save API key + model, then send again.");
      setScreen("settings");
      return;
    }
    const current = prompt.trim();
    setPrompt("");
    setEntries((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", text: current }]);

    await submitPrompt({
      prompt: current,
      workspacePath: bootstrap?.workspaceRoot ?? undefined,
      templateMode: bootstrap?.needsCreationIntake ? undefined : sessionTemplateMode ?? undefined,
      widgetSize: bootstrap?.needsCreationIntake ? undefined : sessionWidgetSize ?? undefined,
      projectType: bootstrap?.needsCreationIntake ? undefined : sessionProjectType ?? undefined
    });
  }

  async function handleStopAgent() {
    if (!api || !sending) {
      return;
    }
    clearActiveCoalescedStreamEntries();
    activeToolStatusEntryByKeyRef.current.clear();
    setWidgetSizePicker({ visible: false, sizes: [] });
    setProjectTypePicker({ visible: false, types: [] });
    setSending(false);
    try {
      await api.cancelAgent();
    } catch {
      // Bridge unavailable — nothing to abort.
    }
  }

  return (
    <main
      className={cn(
        "app-shell grid h-full w-full items-stretch overflow-visible pt-0",
        deployEligible
          ? "grid-cols-[minmax(520px,700px)_minmax(420px,1fr)_minmax(360px,420px)]"
          : "grid-cols-[minmax(620px,760px)_1fr]",
        "grid-rows-[auto_minmax(0,1fr)]",
        "pr-[var(--window-control-inset-right)] pb-[var(--window-control-inset-bottom)] pl-[var(--window-control-inset-left)]",
        "max-[1100px]:grid-cols-1 max-[1100px]:grid-rows-[auto_minmax(0,1fr)]"
      )}
      aria-busy={submissionLock.active}
    >
      <header
        className="app-header col-span-full row-start-1 flex min-h-[max(var(--window-control-inset-top),40px)] items-center gap-2 border-b border-edge bg-[var(--gradient-app-bar)] shadow-[var(--shadow-app-bar-divider)] [app-region:no-drag] [-webkit-app-region:no-drag]"
        style={{
          paddingLeft: "calc(6px + var(--chrome-margin-inline-start))",
          paddingRight: "calc(6px + var(--chrome-margin-inline-end))",
          paddingTop: "5px",
          paddingBottom: "5px"
        }}
        role="banner"
      >
        {screen === "main" ? (
          <>
            <div className="flex min-w-0 shrink items-center gap-1.5">
              <h1
                className="m-0 min-w-0 p-0 font-[family-name:var(--font-display)] text-[13px] font-semibold leading-snug tracking-tight text-fg-strong"
                title={
                  bootstrap?.workspaceRoot && !bootstrap.isTemporaryWorkspace && !isLikelyTempWorkspace(bootstrap.workspaceRoot)
                    ? bootstrap.workspaceRoot
                    : "Embedded assistant for pygame + pydartsnut"
                }
              >
                <span className="block truncate">
                  {bootstrap?.workspaceRoot && !bootstrap.isTemporaryWorkspace && !isLikelyTempWorkspace(bootstrap.workspaceRoot)
                    ? workspaceFolderBasename(bootstrap.workspaceRoot)
                    : "Dartsnut Agent"}
                </span>
              </h1>
              <button
                type="button"
                className={chromeIconBtnClass}
                onClick={() => void handleStartNewProject()}
                disabled={sending}
                aria-label="Start new project"
                title="Start new project"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
                  />
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14 2v6h6M12 11v6M9 14h6"
                  />
                </svg>
              </button>
              {bootstrap?.isTemporaryWorkspace ? (
                <button
                  type="button"
                  className={chromeIconBtnClass}
                  onClick={() => void handleSaveTempWorkspace()}
                  disabled={sending}
                  aria-label="Save project to a folder"
                  title="Save project to a folder"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"
                    />
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M17 21v-8H7v8M7 3v5h8"
                    />
                  </svg>
                </button>
              ) : null}
              <button
                type="button"
                className={chromeIconBtnClass}
                onClick={() => void handlePickWorkspace()}
                disabled={sending}
                aria-label="Open an existing project"
                title="Open an existing project"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 10V8a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8z"
                  />
                  <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M12 14v4M10 16h4" />
                </svg>
              </button>
            </div>
            <div
              className="min-h-0 min-w-0 flex-1 self-stretch [-webkit-app-region:drag] [app-region:drag]"
              aria-hidden
            />
            <div className="inline-flex shrink-0 items-center justify-end gap-3 overflow-visible">
              <UpdateDownloadPill status={appUpdate} />
              <CommunityAuthStatus
                communitySession={communitySession}
                onAuthRequired={() => requestCommunityAuth("deploy-devices")}
                onSignOut={async () => {
                  if (!api?.communityLogout) {
                    return;
                  }
                  try {
                    await api.communityLogout();
                    await refreshCommunitySession();
                  } catch {
                    // ignore
                  }
                }}
              />
              <ThemeSwitcherIcon id="main-theme-icon" value={theme} onChange={handleThemeChange} />
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 shrink-0 items-center gap-1.5">
              <button
                type="button"
                className={chromeIconBtnClass}
                onClick={() => {
                  setScreen("main");
                  setProviderSettingsError(null);
                  setProviderSettingsNotice(null);
                }}
                aria-label="Back to main view"
                title="Back to main view"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 18l-6-6 6-6"
                  />
                </svg>
              </button>
              <h1 className="m-0 min-w-0 flex-[0_1_auto] p-0 font-[family-name:var(--font-display)] text-[13px] font-semibold leading-snug tracking-tight text-fg-strong">
                <span className="block truncate">Settings</span>
              </h1>
            </div>
            <div
              className="min-h-0 min-w-6 flex-1 self-stretch [-webkit-app-region:drag] [app-region:drag]"
              aria-hidden
            />
            <div className="inline-flex shrink-0 items-center gap-2">
              <ThemeSwitcherIcon id="settings-theme-icon" value={theme} onChange={handleThemeChange} />
            </div>
          </>
        )}
      </header>
      {screen === "main" && showRuntimeSetup ? (
        <section
          className={cn(
            "runtime-config-main col-start-1 row-start-2 min-h-0 h-full overflow-auto bg-[var(--gradient-rail)] max-[1100px]:col-end-2",
            deployEligible ? "col-end-4" : "col-end-3"
          )}
          aria-live="polite"
        >
          <div className="runtime-config-main__inner">
            <div className="runtime-setup-panel" role={pythonRuntimeProgress.error ? "alert" : "status"}>
              <div className="runtime-setup-panel__header">
                <p className="runtime-setup-panel__eyebrow">Runtime configuration</p>
                <h2 className="runtime-setup-panel__title">
                  {pythonRuntimeProgress.error ? "Runtime setup failed" : "Preparing runtime"}
                </h2>
              </div>
              <div className="runtime-setup-panel__progress" aria-hidden>
                <div
                  className="runtime-setup-panel__progress-fill"
                  style={{ width: `${runtimeProgressPercent}%` }}
                />
              </div>
              <div className="runtime-setup-panel__meta">
                <span>{pythonRuntimeProgress.message ?? "Initializing..."}</span>
                <span className="tabular-nums">{runtimeProgressPercent}%</span>
              </div>
              {pythonRuntimeProgress.error ? (
                <div className="runtime-setup-panel__error">{pythonRuntimeProgress.error}</div>
              ) : null}
            </div>
          </div>
        </section>
      ) : screen === "main" ? (
        <section
          className={cn(
            "left-rail left-rail--chat col-start-1 row-start-2 relative min-h-0 h-full overflow-hidden border-r border-edge bg-[var(--gradient-rail)]",
            "max-[1100px]:col-start-1 max-[1100px]:row-start-2 max-[1100px]:max-w-[760px]"
          )}
        >
          <section
            className={cn(
              "timeline absolute inset-0 z-0 overflow-y-auto overflow-x-hidden overscroll-contain",
              autoScrollEnabled && "timeline--autoscroll"
            )}
            ref={timelineRef}
            onScroll={(event) => {
              const atBottom = isTimelineNearBottom(event.currentTarget);
              if (atBottom) {
                if (!autoScrollEnabled) {
                  setAutoScrollEnabled(true);
                }
                return;
              }
              if (autoScrollEnabled) {
                setAutoScrollEnabled(false);
              }
            }}
          >
            <div className="timeline-inner">
            {entries.map((entry) => (
              <TimelineEntryView
                key={entry.id}
                entry={entry}
                onToggleReasoning={toggleReasoningEntry}
              />
            ))}
            </div>
          </section>

          {runtimeError || pythonRuntimeStatus ? (
            <div className="chat-rail-overlay chat-rail-overlay--top pointer-events-none absolute inset-x-0 top-0 z-10">
              <div className="pointer-events-auto flex min-w-0 flex-col gap-2">
                {runtimeError ? (
                  <div
                    className="m-0 rounded-lg border border-[var(--color-runtime-error-border)] bg-[var(--color-runtime-error-bg)] p-2 text-xs"
                    role="status"
                  >
                    {runtimeError}
                  </div>
                ) : null}
                {pythonRuntimeStatus ? (
                  <div
                    className="m-0 rounded-lg border border-[var(--color-runtime-status-border)] bg-[var(--color-runtime-status-bg)] p-2 text-xs text-[var(--color-runtime-status-text)]"
                    role="status"
                  >
                    {pythonRuntimeStatus}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="chat-rail-overlay chat-rail-overlay--bottom pointer-events-none absolute inset-x-0 bottom-0 z-10">
            <div className="chat-rail-chrome pointer-events-auto">
          {tokenUsage ? (
            <div className="flex justify-end">
              <div
                className="token-usage-chip"
                role="status"
                aria-label={formatTokenUsageTitle(tokenUsage)}
                title={formatTokenUsageTitle(tokenUsage)}
              >
                <span className="token-usage-chip__label">Tokens</span>
                <span className="token-usage-chip__value">
                  {formatTokenCount(tokenUsage.totalTokens)}
                </span>
              </div>
            </div>
          ) : null}
          {/* Blocking `dartsnut_ask_question` UI — shown while the host waits for an answer. */}
          {projectTypePicker.visible && projectTypePicker.types.length > 0 ? (
            <AskQuestionCard
              question="Are you building a game or a widget?"
              options={projectTypePicker.types.map((pt) => ({
                value: pt,
                label: projectTypeChipLabel(pt),
              }))}
              onSubmit={(value) => void handleProjectTypeChip(value as ProjectType)}
            />
          ) : widgetSizePicker.visible && widgetSizePicker.sizes.length > 0 ? (
            <AskQuestionCard
              question="Which widget display size do you want?"
              options={widgetSizePicker.sizes.map((sz) => ({
                value: sz,
                label: sz,
              }))}
              onSubmit={(value) => void handleWidgetSizeChip(value as WidgetSize)}
            />
          ) : machineMcpPicker.visible ? (
            <AskQuestionCard
              question={
                machineMcpPicker.manualOnly
                  ? "Enter the machine IP for MCP."
                  : "Which machine should the agent use for MCP?"
              }
              options={
                machineMcpPicker.manualOnly
                  ? undefined
                  : machineMcpPicker.machines.map((machine) => ({
                    value: machine.deviceId,
                    label: machineOptionLabel(machine),
                  }))
              }
              input={
                machineMcpPicker.manualOnly
                  ? {
                    value: machineMcpManualIp,
                    placeholder: "192.168.1.42",
                    error: machineMcpInputError,
                    onChange: (value) => {
                      setMachineMcpManualIp(value);
                      setMachineMcpInputError(null);
                    },
                    validate: isValidMachineHost,
                  }
                  : undefined
              }
              onSubmit={(value) =>
                machineMcpPicker.manualOnly
                  ? void handleMachineMcpManualIp(value)
                  : void handleMachineMcpChoice(value)
              }
            />
          ) : null}

          <section className="flex flex-col gap-3 border-0 bg-transparent p-0">
            <div
              className={cn(
                "ui-composer",
                composerExpandedSticky && "flex-col items-stretch gap-2"
              )}
              data-expanded={composerExpandedSticky ? "true" : undefined}
            >
              <textarea
                ref={promptInputRef}
                className={cn(
                  "m-0 max-h-[200px] min-h-[26px] min-w-0 resize-none overflow-y-hidden border-0 bg-transparent px-1 py-0.5 text-[13px] leading-snug text-[var(--color-composer-input)] shadow-none outline-none [font:inherit] placeholder:text-[var(--color-composer-placeholder)] focus:border-0 focus:shadow-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-45",
                  composerExpandedSticky ? "w-full flex-none" : "flex-1"
                )}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (isComposerSendShortcut(event)) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Message..."
                rows={1}
                aria-label="Message"
                disabled={chatDisabled}
                aria-busy={sending}
              />
              <div
                className={cn(
                  "ui-composer-controls flex shrink-0 gap-2",
                  composerExpandedSticky ? "items-center justify-end" : "items-center"
                )}
              >
                {!autoScrollEnabled ? (
                  <button
                    type="button"
                    className="m-0 inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--color-composer-scroll-border)] bg-[var(--color-composer-scroll-bg)] p-0 text-[var(--color-composer-scroll-fg)] hover:bg-[var(--color-composer-scroll-hover)]"
                    aria-label="Scroll to bottom and enable auto-scroll"
                    title="Scroll to bottom and enable auto-scroll"
                    onClick={() => {
                      scrollTimelineToBottom();
                      setAutoScrollEnabled(true);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                      <path
                        d="M12 5v14M12 19l-5-5M12 19l5-5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.1"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="m-0 inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-[var(--color-composer-send-bg)] p-0 text-[var(--color-composer-send-fg)] hover:enabled:bg-[var(--color-composer-send-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={sending ? false : chatDisabled}
                  aria-busy={false}
                  aria-label={sending ? "Stop" : "Send"}
                  onClick={() => (sending ? void handleStopAgent() : void handleSend())}
                >
                  {sending ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                      <rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
                      <path
                        d="M12 19V6M12 6l-4.5 4.5M12 6l4.5 4.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </section>
            </div>
          </div>
        </section>
      ) : (
        <section
          className={cn(
            "left-rail col-start-1 row-start-2 grid min-h-0 h-full overflow-visible border-r border-edge bg-[var(--gradient-rail)] pt-[14px] pb-[18px] px-[18px]",
            "grid-rows-[auto_minmax(0,1fr)] gap-4",
            "max-[1100px]:col-start-1 max-[1100px]:row-start-2 max-[1100px]:max-w-[760px]",
            "max-[760px]:gap-2.5 max-[760px]:p-3"
          )}
        >
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="flex min-w-0 flex-col gap-2">
              {providerSettingsError ? (
                <div
                  className="m-0 rounded-lg border border-[var(--color-runtime-error-border)] bg-[var(--color-runtime-error-bg)] p-2 text-xs"
                  role="alert"
                >
                  {providerSettingsError}
                </div>
              ) : null}
              {providerSettingsNotice ? (
                <div className="m-0 rounded-lg border border-[var(--color-notice-success-border)] bg-[var(--color-notice-success-bg)] p-2 text-xs">
                  {providerSettingsNotice}
                </div>
              ) : null}
            </div>
          </div>
          <section className="grid min-h-0 grid-cols-[220px_1fr] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-settings-layout-border)] bg-[var(--color-settings-layout-bg)] shadow-[var(--shadow-sm)]">
            <nav className="flex flex-col gap-2 border-r border-[var(--color-settings-layout-border)] p-3" aria-label="Settings menu">
              <button
                type="button"
                className="w-full rounded-[var(--radius-md)] border-0 bg-[var(--color-settings-menu-active)] px-3 py-2 text-left text-[13px] font-medium text-fg [app-region:no-drag] [-webkit-app-region:no-drag]"
              >
                Provider configuration
              </button>
            </nav>
            <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4 text-[13px]">
              <label className="flex flex-col gap-1.5">
                <span className="text-[var(--color-text-subtle)]">Provider</span>
                <select
                  className="ui-input"
                  value={providerSettings.activeProvider}
                  onChange={(event) =>
                    setProviderSettings((prev) =>
                      withProviderId(prev, event.target.value === "custom" ? "custom" : "dartsnut-llm")
                    )
                  }
                >
                  <option value="dartsnut-llm">Dartsnut LLM</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {providerSettings.activeProvider === "dartsnut-llm" ? (
                <div className="rounded-[var(--radius-md)] border border-[var(--color-notice-success-border)] bg-[var(--color-notice-success-bg)] px-3 py-2 text-xs leading-relaxed text-fg">
                  <p className="m-0 font-medium">This service is free for a limited time only.</p>
                  <p className="m-0 mt-1 text-fg-muted">
                    Please use Dartsnut LLM only for creating and updating Dartsnut games,
                    widgets, and related project assets. Avoid sending unrelated, sensitive,
                    or personal content.
                  </p>
                </div>
              ) : null}
              {providerSettings.activeProvider === "custom" ? (
                <>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[var(--color-text-subtle)]">API endpoint</span>
                    <input
                      type="url"
                      className="ui-input"
                      value={providerCustom(providerSettings).baseUrl}
                      onChange={(event) =>
                        setProviderSettings((prev) =>
                          withProviderCustom(prev, (custom) => ({ ...custom, baseUrl: event.target.value }))
                        )
                      }
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[var(--color-text-subtle)]">API key</span>
                    <input
                      type="password"
                      className="ui-input"
                      value={providerCustom(providerSettings).apiKey}
                      onChange={(event) =>
                        setProviderSettings((prev) =>
                          withProviderCustom(prev, (custom) => ({ ...custom, apiKey: event.target.value }))
                        )
                      }
                      placeholder="sk-..."
                    />
                  </label>
                  <div className="text-xs text-fg-muted">
                    Stored key preview:{" "}
                    {maskApiKey(providerCustom(providerSettings).apiKey) || "(empty)"}
                  </div>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[var(--color-text-subtle)]">Model</span>
                    <input
                      type="text"
                      className="ui-input"
                      value={providerCustom(providerSettings).model}
                      onChange={(event) =>
                        setProviderSettings((prev) =>
                          withProviderCustom(prev, (custom) => ({ ...custom, model: event.target.value }))
                        )
                      }
                      placeholder="gpt-4.1-mini"
                    />
                  </label>
                </>
              ) : null}
              <div className="flex justify-start">
                <button
                  type="button"
                  className="ui-btn-primary mt-0 disabled:cursor-not-allowed disabled:opacity-55"
                  onClick={() => void handleSaveProviderSettings()}
                  disabled={savingProviderSettings}
                >
                  {savingProviderSettings ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </section>
        </section>
      )}
      <aside
        className={cn(
          "right-pane col-start-2 row-start-2 flex min-h-0 h-full min-w-[460px] flex-1 flex-col overflow-hidden border-l border-edge bg-[var(--color-right-pane-bg)]",
          showRuntimeSetup ? "hidden" : "max-[1100px]:hidden"
        )}
      >
        {assetManifest ? (
            <div className="flex gap-0.5 border-b border-edge px-3 pb-0 pt-2" role="tablist" aria-label="Right pane view">
              <button
                type="button"
                className={cn("ui-tab", rightPaneTab === "emulator" && "ui-tab--active")}
                role="tab"
                aria-selected={rightPaneTab === "emulator"}
                onClick={() => setRightPaneTab("emulator")}
              >
                Emulator
              </button>
              {assetManifest ? (
                <button
                  type="button"
                  className={cn("ui-tab", rightPaneTab === "assets" && "ui-tab--active")}
                  role="tab"
                  aria-selected={rightPaneTab === "assets"}
                  onClick={() => setRightPaneTab("assets")}
                >
                  Assets
                  {pendingChangeSlotIds.length > 0 ? (
                    <span
                      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-badge-bg)] px-1.5 text-[11px] font-semibold text-[var(--color-badge-text)]"
                      aria-label={`${pendingChangeSlotIds.length} pending`}
                    >
                      {pendingChangeSlotIds.length}
                    </span>
                  ) : null}
                </button>
              ) : null}
            </div>
          ) : null}
        <div className="flex min-h-0 flex-1 flex-col">
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                Boolean(assetManifest) && rightPaneTab !== "emulator" && "hidden"
              )}
            >
              <EmulatorPanel
                widgetParamsText={widgetParamsText}
                setWidgetParamsText={setWidgetParamsText}
                widgetParamsError={widgetParamsError}
                setWidgetParamsError={setWidgetParamsError}
              />
            </div>
          {assetManifest && bootstrap?.workspaceRoot ? (
              <div className={cn("flex min-h-0 flex-1 flex-col", rightPaneTab !== "assets" && "hidden")}>
                <AssetManagerPanel
                  workspacePath={bootstrap.workspaceRoot}
                  manifest={assetManifest}
                  pendingChangeSlotIds={pendingChangeSlotIds}
                  onAllowAgentIngress={() => {
                    discardAgentEventsRef.current = false;
                  }}
                />
              </div>
            ) : null}
        </div>
      </aside>
      {deployEligible ? (
        <aside
          className={cn(
            "right-pane col-start-3 row-start-2 flex min-h-0 h-full min-w-[360px] flex-col overflow-hidden border-l border-edge bg-[var(--color-right-pane-bg)]",
            showRuntimeSetup ? "hidden" : "max-[1100px]:hidden"
          )}
        >
          <div className="flex gap-0.5 border-b border-edge px-3 pb-0 pt-2" role="tablist" aria-label="Deploy view">
            <button
              type="button"
              className={cn("ui-tab", deployPaneTab === "deploy" && "ui-tab--active")}
              role="tab"
              aria-selected={deployPaneTab === "deploy"}
              onClick={() => setDeployPaneTab("deploy")}
            >
              Deploy
            </button>
            <button
              type="button"
              className={cn("ui-tab", deployPaneTab === "games" && "ui-tab--active")}
              role="tab"
              aria-selected={deployPaneTab === "games"}
              aria-disabled={gamesTabDisabled}
              disabled={gamesTabDisabled}
              onClick={() => {
                if (!gamesTabDisabled) {
                  setCommunityAuthIntent("my-games");
                  setDeployPaneTab("games");
                }
              }}
            >
              Community
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className={cn("flex min-h-0 flex-1 flex-col", deployPaneTab !== "deploy" && "hidden")}>
              <DeployPanel
                active={deployPaneTab === "deploy"}
                showWidgetParams={deployPanelShowsWidgetParams}
                widgetParamsText={widgetParamsText}
                setWidgetParamsText={setWidgetParamsText}
                widgetParamsError={widgetParamsError}
                setWidgetParamsError={setWidgetParamsError}
                communitySession={communitySession}
                communitySessionVersion={communitySessionVersion + communityAuthSkippedVersion}
                onCommunitySessionChange={refreshCommunitySession}
                onAuthRequired={requestDeployCommunityAuth}
              />
            </div>
            <div className={cn("flex min-h-0 flex-1 flex-col", deployPaneTab !== "games" && "hidden")}>
              <MyGamesPanel
                active={deployPaneTab === "games"}
                communitySession={communitySession}
                communitySessionVersion={communitySessionVersion + communityAuthSkippedVersion}
                communityWorkspaceRefreshKey={communityWorkspaceRefreshKey}
                onCommunitySessionChange={refreshCommunitySession}
                onAuthRequired={requestMyGamesCommunityAuth}
                onSubmitProgress={handleCommunitySubmitProgress}
              />
            </div>
          </div>
        </aside>
      ) : null}
      <DeployAuthGate
        open={deployAuthGateOpen}
        googleSignInAvailable={communitySession.googleSignInAvailable}
        title={communityAuthIntent === "my-games" ? "Sign in to publish apps" : "Sign in to pick a device"}
        description={
          communityAuthIntent === "my-games"
            ? "Log in with your Dartsnut account to publish games and widgets."
            : "Log in with your Dartsnut account to select a bound machine and use its IP automatically. You can continue without signing in and enter an IP manually."
        }
        onSkip={() => {
          setCommunityAuthSkippedForSession();
          setCommunityAuthSkippedVersion((v) => v + 1);
          setDeployAuthGateOpen(false);
          if (communityAuthIntent === "my-games") {
            setDeployPaneTab("deploy");
          }
        }}
        onSuccess={async (account) => {
          setDeployAuthGateOpen(false);
          await refreshCommunitySession();
          devLog.log("[community] Signed in as", account);
        }}
      />
      <UpdateReadyOverlay
        status={visibleAppUpdate}
        installing={appUpdate?.installing ?? false}
        error={appUpdate?.error ?? null}
        onInstallNow={handleInstallAppUpdateNow}
        onLater={handleUpdateNextLaunch}
      />
      <CommunitySubmitOverlay lock={submissionLock} />
    </main>
  );
}

function printMainProcessMirrorToDevtools(payload: MainProcessConsoleMirrorPayload): void {
  if (!isDevLoggingEnabled()) {
    return;
  }
  const { level, prefix, message } = payload;
  const line = prefix.trim().length > 0 ? `${prefix} ${message}` : message;
  if (level === "error") {
    devLog.error(line);
  } else if (level === "warn") {
    devLog.warn(line);
  } else if (level === "debug") {
    devLog.debug(line);
  } else {
    devLog.log(line);
  }
}
