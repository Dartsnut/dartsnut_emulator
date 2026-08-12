import {
  lazy,
  memo,
  Suspense,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Folder,
  FolderOpen,
  FolderPlus,
  LogOut,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Settings,
  Square,
  SquarePen,
  UserRound,
  X
} from "lucide-react";
import {
  type AgentEvent,
  type AgentSessionTokenUsage,
  type AgentTokenUsage,
  type AppUpdateStatus,
  type AssetManifest,
  type BootstrapState,
  type ProjectTree,
  type ProjectSwitchProgress,
  type DeployEligibility,
  type ManifestSnapshot,
  type ProviderId,
  type ProviderSettings,
  type PythonRuntimeProgress,
  type ProjectType,
  type CustomProviderSettings,
  type PromptRequest,
  type SendPromptResponse,
  type SaveTempWorkspaceResponse,
  type MainProcessConsoleMirrorPayload,
  type MachineMcpQuestionMachine,
  type WidgetSize,
  type CommunitySessionInfo,
  type CommunityLlmQuotaStatus,
  type CommunitySubmitProgress,
  type UserLocale,
  type ChatMediaAttachment,
  type WidgetConfigScope,
  type WidgetConfigSnapshot,
  type WidgetFieldDefinition,
  type WidgetFieldValues,
  createDefaultWidgetFieldValues,
  getIntakeCopy,
  inferChatMediaAttachmentKind,
  mergeChatMediaAttachments,
  reconcileWidgetFieldValues
} from "@dartsnut/shared-ipc";
import {
  getAnalyticsCollectionEnabled,
  setAnalyticsCollectionEnabledPreference,
  setAnalyticsViewContext,
  trackAgentEvent,
  trackPanelView,
  trackScreenView,
  updateAnalyticsUser
} from "./analytics";
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
  describeTimelineError,
  formatAgentEventForTimeline,
  mergeTimelineSkillStatusEntry,
  parseToolStatusMessage,
  shouldHideTimelineStatus,
  transcriptLineToTimelineEntry,
  type TimelineEntry
} from "./rawTimeline";
import { applyTheme, resolveThemeFromEnvironment, type ThemeId } from "./theme";
import { useWindowChromeInsets } from "./useWindowChromeInsets";
import {
  clampChatPaneWidth,
  getStoredChatPaneWidth,
  maxChatPaneWidthForViewport,
  MIN_CHAT_PANE_WIDTH,
  MIN_EMULATOR_PANE_WIDTH,
  nextChatPaneWidthFromDrag,
  setStoredChatPaneWidth
} from "./splitPaneSizing";

/** Same order as `WIDGET_DISPLAY_SIZES` in `@dartsnut/shared-ipc` — defined here because Vite/Rollup does not resolve that value through the package’s compiled CJS `export *` shim. */
const WIDGET_DISPLAY_SIZES: readonly WidgetSize[] = ["128x160", "128x128", "128x64", "64x32"];

const CREATION_INTAKE_PROJECT_TYPES: readonly ProjectType[] = ["game", "widget"];
const AgentMarkdownRenderer = lazy(() => import("./AgentMarkdownRenderer"));

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
type CommunityAuthIntent = "deploy-devices" | "my-games" | "llm-use";

const EMPTY_WIDGET_CONFIGS: Record<WidgetConfigScope, WidgetConfigSnapshot> = {
  workspace: {
    scope: "workspace",
    status: "unavailable",
    configKey: null,
    confPath: null,
    message: "No workspace is selected."
  },
  emulator: {
    scope: "emulator",
    status: "unavailable",
    configKey: null,
    confPath: null,
    message: "No widget is selected in the emulator."
  }
};

type WidgetValueState = { fields: WidgetFieldDefinition[]; values: WidgetFieldValues };

type AppScreen = "main" | "settings";
type SettingsSection = "general" | "provider";
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
const WORKSPACE_MENU_WIDTH_PX = 54;
/** Keep in sync with composer textarea `max-h-[200px]` */
const COMPOSER_PROMPT_MAX_HEIGHT_PX = 200;
/**
 * Visual multiline detection can be off by a fractional pixel depending on
 * font metrics, zoom, and platform.
 */
const COMPOSER_PROMPT_MULTILINE_EPSILON_PX = 1;
const GREETING_TEXT =
  "What are we making today? Share your idea and I'll help turn it into a Dartsnut widget or game.";
const CHAT_ATTACHMENT_ERROR_TIMEOUT_MS = 3500;

const EMPTY_CUSTOM_PROVIDER: CustomProviderSettings = {
  baseUrl: "",
  apiKey: "",
  model: ""
};

const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  activeProvider: "dartsnut-llm",
  custom: EMPTY_CUSTOM_PROVIDER
};

function createChatMediaAttachmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `chat-${crypto.randomUUID()}`;
  }
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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

function settingsShortcutLabel(): string {
  return navigator.platform.toLowerCase().includes("mac") ? "⌘," : "Ctrl+,";
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

type DartsnutLlmUsageCardProps = {
  quota: CommunityLlmQuotaStatus | null;
  loading: boolean;
  error: string | null;
  loggedIn: boolean;
  onRefresh: () => void;
};

function DartsnutLlmUsageCard({ quota, loading, error, loggedIn, onRefresh }: DartsnutLlmUsageCardProps) {
  const usagePercent = quota
    ? quota.limitTokens > 0
      ? Math.min(100, (quota.usedTokens / quota.limitTokens) * 100)
      : 100
    : 0;
  return (
    <section className="llm-usage-card" aria-label="Today’s Dartsnut LLM usage">
      <div className="llm-usage-card__header">
        <div>
          <p className="llm-usage-card__eyebrow">Today · UTC</p>
          <h3 className="llm-usage-card__title">Token usage</h3>
        </div>
        {quota?.quotaExceeded ? <span className="llm-usage-card__badge">Limit reached</span> : null}
      </div>
      {!loggedIn ? (
        <p className="llm-usage-card__state">Sign in to view today’s usage and remaining allowance.</p>
      ) : loading && !quota ? (
        <p className="llm-usage-card__state" role="status">Loading today’s usage…</p>
      ) : error && !quota ? (
        <div className="llm-usage-card__state llm-usage-card__state--error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRefresh}>Retry</button>
        </div>
      ) : quota ? (
        <>
          <div
            className="llm-usage-card__track"
            role="progressbar"
            aria-label="Daily token allowance used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usagePercent)}
          >
            <span style={{ width: `${usagePercent}%` }} />
          </div>
          {error ? (
            <div className="llm-usage-card__refresh-error" role="status">
              <span>{error}</span>
              <button type="button" onClick={onRefresh}>Retry</button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return <section className="settings-group">{children}</section>;
}

function SettingsRow({ title, description, control, children }: {
  title?: string;
  description?: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return <div className={cn("settings-row", children && "settings-row--stacked")}>
    {title ? <div className="settings-row__copy">
      <span className="settings-row__title">{title}</span>
      {description ? <span className="settings-row__description">{description}</span> : null}
    </div> : null}
    {control ? <div className="settings-row__control">{control}</div> : null}
    {children ? <div className="settings-row__content">{children}</div> : null}
  </div>;
}

function SettingsSelect<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  return <div className="settings-select" ref={rootRef}>
    <button type="button" className={cn("settings-select__trigger", open && "settings-select__trigger--open")} onClick={() => setOpen((current) => !current)} aria-label={label} aria-haspopup="menu" aria-expanded={open}>
      <span>{selected?.label}</span><ChevronDown size={15} aria-hidden />
    </button>
    {open ? <div className="settings-select__menu" role="menu">
      {options.map((option) => <button key={option.value} type="button" className={cn("settings-select__option", option.value === value && "settings-select__option--selected")} onClick={() => { onChange(option.value); setOpen(false); }} role="menuitemradio" aria-checked={option.value === value}>
        <span>{option.label}</span>{option.value === value ? <Check size={15} aria-hidden /> : null}
      </button>)}
    </div> : null}
  </div>;
}

function SettingsSwitch({ checked, onChange, label, analyticsId }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  analyticsId?: string;
}) {
  return <button type="button" className={cn("settings-switch", checked && "settings-switch--checked")} onClick={() => onChange(!checked)} role="switch" aria-checked={checked} aria-label={label} data-analytics-id={analyticsId} data-analytics-area="settings"><span /></button>;
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
  autoUpdateEnabled: boolean;
  installing: boolean;
  error: string | null;
  onDownload: () => void;
  onAutoUpdateChange: (enabled: boolean) => void;
  onInstallNow: () => void;
  onLater: () => void;
};

export function UpdateReadyOverlay({
  status,
  autoUpdateEnabled,
  installing,
  error,
  onDownload,
  onAutoUpdateChange,
  onInstallNow,
  onLater
}: UpdateReadyOverlayProps) {
  if (!status || (status.kind !== "available" && status.kind !== "ready")) {
    return null;
  }
  const isAvailable = status.kind === "available";
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
          <h2 id="app-update-title" className="app-update-panel__title">{isAvailable ? "Update available" : "Update ready"}</h2>
          <p className="app-update-panel__version">
            Dartsnut Agent {status.currentVersion}
            {status.availableVersion ? ` -> ${status.availableVersion}` : ""}
          </p>
          <p className="app-update-panel__message">
            {isAvailable
              ? "A new version is available. Download it now, or skip it and check again next time."
              : "The new version has finished downloading. Install it now to relaunch, or keep working and update the next time you open Dartsnut Agent."}
          </p>
          {isAvailable ? (
            <label className="app-update-panel__option">
              <input
                type="checkbox"
                checked={autoUpdateEnabled}
                data-analytics-id="app_update_auto_download"
                data-analytics-area="update"
                onChange={(event) => onAutoUpdateChange(event.target.checked)}
              />
              <span>Automatically download updates</span>
            </label>
          ) : null}
          {error ? (
            <p className="app-update-panel__error" role="alert">{error}</p>
          ) : null}
        </div>
        <div className="app-update-panel__actions">
          <button
            type="button"
            className="ui-btn-primary app-update-panel__primary"
            disabled={installing}
            data-analytics-id={isAvailable ? "app_update_download" : "app_update_install"}
            data-analytics-area="update"
            onClick={isAvailable ? onDownload : onInstallNow}
          >
            {isAvailable ? "Download update" : installing ? "Preparing..." : "Update now"}
          </button>
          <button type="button" className="app-update-panel__secondary" disabled={installing} data-analytics-id="app_update_later" data-analytics-area="update" onClick={onLater}>
            {isAvailable ? "Skip" : "Next launch"}
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

function TimelineErrorCard({ text }: { text: string }) {
  const error = describeTimelineError(text);
  return (
    <div className="timeline-error-card" role="alert">
      <div className="timeline-error-card__signal" aria-hidden>
        <CircleAlert size={14} strokeWidth={1.8} />
      </div>
      <div className="timeline-error-card__content">
        <span className="timeline-error-card__eyebrow">Run interrupted</span>
        <strong className="timeline-error-card__title">{error.title}</strong>
        <p className="timeline-error-card__message">{error.message}</p>
        {error.technicalDetail ? (
          <details className="timeline-error-card__details">
            <summary>Technical details</summary>
            <code>{error.technicalDetail}</code>
          </details>
        ) : null}
      </div>
    </div>
  );
}

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
        <TimelineErrorCard text={entry.text} />
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
  updater: (custom: CustomProviderSettings) => CustomProviderSettings
): ProviderSettings {
  return {
    ...settings,
    custom: updater(settings.custom)
  };
}

function withProviderId(settings: ProviderSettings, activeProvider: ProviderId): ProviderSettings {
  return {
    ...settings,
    activeProvider
  };
}

function providerCustom(settings: ProviderSettings): CustomProviderSettings {
  return settings.custom;
}

function workspaceFolderBasename(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : workspaceRoot;
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
  onOpenSettings: () => void;
  placement?: "header" | "rail";
};

function CommunityAuthStatus({
  communitySession,
  onAuthRequired,
  onSignOut,
  onOpenSettings,
  placement = "header"
}: CommunityAuthStatusProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inRail = placement === "rail";

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
      <div className={cn("relative", inRail && "w-full")} ref={menuRef}>
        <button
          type="button"
          className={cn(
            inRail
              ? "workspace-menu__button"
              : "inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded border border-transparent bg-transparent px-2.5 py-0 text-xs font-medium text-[var(--color-app-btn-text)] transition-colors hover:bg-[var(--color-app-btn-bg-hover)] hover:text-[var(--color-app-btn-text-hover)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45"
          )}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Account menu"
          aria-expanded={menuOpen}
          title={communitySession.account || "Signed in"}
        >
          <UserRound size={inRail ? 16 : 12} className="shrink-0" aria-hidden />
          {inRail ? <span className="workspace-menu__button-label">{communitySession.account || "Account"}</span> : null}
          {!inRail ? <span className="whitespace-nowrap">{communitySession.account || "Signed in"}</span> : null}
        </button>
        {menuOpen ? (
          <div
            className={cn(
              "absolute z-50 min-w-[190px] rounded-md border border-[var(--color-emulator-toolbar-border)] bg-[var(--color-emulator-toolbar-bg)] py-1 shadow-sm",
              inRail ? "bottom-full left-0" : "right-0 top-full mt-1"
            )}
            role="menu"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-[13px] font-medium text-[var(--color-emulator-toolbar-label)] transition-colors hover:bg-[var(--color-emulator-toolbar-bg-hover)] focus:outline-none"
              onClick={() => { onOpenSettings(); setMenuOpen(false); }}
              role="menuitem"
            >
              <Settings size={14} className="shrink-0" aria-hidden />
              <span>Settings</span>
              <kbd className="ml-auto whitespace-nowrap text-[11px] font-normal text-[var(--color-text-subtle)]">{settingsShortcutLabel()}</kbd>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-[13px] font-medium text-[var(--color-emulator-toolbar-label)] transition-colors hover:bg-[var(--color-emulator-toolbar-bg-hover)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              role="menuitem"
            >
              <LogOut size={14} className="shrink-0" aria-hidden />
              {signingOut ? "Logging out..." : "Log out"}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={inRail ? "workspace-menu__button" : chromeIconBtnClass}
      onClick={onAuthRequired}
      aria-label="Sign in"
      title="Sign in"
    >
      <UserRound size={inRail ? 16 : 14} aria-hidden />
      {inRail ? <span className="workspace-menu__button-label">Sign in</span> : null}
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
  const [projectTree, setProjectTree] = useState<ProjectTree>({ projects: [], chats: [] });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [projectSwitchProgress, setProjectSwitchProgress] = useState<ProjectSwitchProgress>({ active: false, stage: "ready" });
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectName, setCreateProjectName] = useState("");
  const [createProjectFolder, setCreateProjectFolder] = useState<string | null>(null);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [createProjectPicking, setCreateProjectPicking] = useState(false);
  const [entries, setEntries] = useState<TimelineEntry[]>([
    { id: "greeting-initial", role: "agent", text: GREETING_TEXT }
  ]);
  const [prompt, setPrompt] = useState("");
  const [chatMediaAttachments, setChatMediaAttachments] = useState<ChatMediaAttachment[]>([]);
  const [chatAttachmentError, setChatAttachmentError] = useState<string | null>(null);
  const [composerDragActive, setComposerDragActive] = useState(false);
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
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
    locale: UserLocale | null;
  }>({ visible: false, types: [], locale: null });
  /** Shown after intake records `widget` but not yet `set_widget_size` (host pushes `intake_widget_size_prompt`). */
  const [widgetSizePicker, setWidgetSizePicker] = useState<{
    visible: boolean;
    sizes: WidgetSize[];
    locale: UserLocale | null;
  }>({ visible: false, sizes: [], locale: null });
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
  const projectTypeIntakeCopy = useMemo(
    () => getIntakeCopy(projectTypePicker.locale),
    [projectTypePicker.locale]
  );
  const widgetSizeIntakeCopy = useMemo(
    () => getIntakeCopy(widgetSizePicker.locale),
    [widgetSizePicker.locale]
  );
  const activeStreamDeltaRef = useRef("");
  const activeReasoningStreamEntryIdRef = useRef<string | null>(null);
  const activeReasoningIdRef = useRef<string | null>(null);
  const activeReasoningStreamDeltaRef = useRef("");
  const activeReasoningStartedAtRef = useRef<number | null>(null);
  const activeToolStatusEntryByKeyRef = useRef<Map<string, string>>(new Map());
  const seenAgentToolAnalyticsRef = useRef<Set<string>>(new Set());
  const activeAgentRunRef = useRef<{ startedAt: number; finished: boolean } | null>(null);
  /** After session reset / new project, discard agent stream events until the next user send. */
  const discardAgentEventsRef = useRef(false);
  const lastAgentSessionHydrateKeyRef = useRef<string>("");
  const timelineRef = useRef<HTMLElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerExpandedSticky, setComposerExpandedSticky] = useState(false);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(() => getAnalyticsCollectionEnabled());
  const [providerSettingsError, setProviderSettingsError] = useState<string | null>(null);
  const [providerSettingsNotice, setProviderSettingsNotice] = useState<string | null>(null);
  const [savingProviderSettings, setSavingProviderSettings] = useState(false);
  const [assetManifest, setAssetManifest] = useState<AssetManifest | null>(null);
  const [pendingChangeSlotIds, setPendingChangeSlotIds] = useState<string[]>([]);
  const [rightPaneTab, setRightPaneTab] = useState<RightPaneTab>("emulator");
  const [deployPaneTab, setDeployPaneTab] = useState<DeployPaneTab>("deploy");
  const [deployDrawerOpen, setDeployDrawerOpen] = useState(false);
  const [deployEligibility, setDeployEligibility] = useState<DeployEligibility>({
    ok: false,
    reason: "no_workspace"
  });
  const deployEligible = deployEligibility.ok;
  const activeProject = projectTree.projects.find((project) => project.id === bootstrap?.activeProjectId) ?? null;
  const activeChat = projectTree.chats.find((chat) => chat.id === bootstrap?.activeChatId) ?? null;
  const validProject = Boolean(
    activeProject &&
    bootstrap?.workspaceRoot &&
    deployEligibility.ok &&
    (deployEligibility.projectType === "game" || deployEligibility.projectType === "widget")
  );
  const showEmulator = validProject;
  const showRuntimeSetup = pythonRuntimeProgress.running || Boolean(pythonRuntimeProgress.error);
  const showEmulatorPane = screen === "main" && showEmulator && !showRuntimeSetup;
  const showDeployDrawer = screen === "main" && validProject && !showRuntimeSetup;
  const [widgetConfigs, setWidgetConfigs] = useState<Record<WidgetConfigScope, WidgetConfigSnapshot>>(EMPTY_WIDGET_CONFIGS);
  const [widgetValuesByConfig, setWidgetValuesByConfig] = useState<Record<string, WidgetValueState>>({});
  const [theme, setTheme] = useState<ThemeId>(() => resolveThemeFromEnvironment());
  const [communitySession, setCommunitySession] = useState<CommunitySessionInfo>({
    loggedIn: false,
    account: null,
    analyticsUserId: null,
    authMethod: null,
    hasSupabase: false,
    googleClientId: "",
    googleDesktopClientId: "",
    googleSignInAvailable: false
  });
  const [deployAuthGateOpen, setDeployAuthGateOpen] = useState(false);
  const [communityAuthIntent, setCommunityAuthIntent] = useState<CommunityAuthIntent>("deploy-devices");
  const [communityAuthSkippedVersion, setCommunityAuthSkippedVersion] = useState(0);
  const [communitySessionVersion, setCommunitySessionVersion] = useState(0);
  const [llmQuota, setLlmQuota] = useState<CommunityLlmQuotaStatus | null>(null);
  const [llmQuotaLoading, setLlmQuotaLoading] = useState(false);
  const [llmQuotaError, setLlmQuotaError] = useState<string | null>(null);
  const [submissionLock, setSubmissionLock] = useState<SubmissionLockState>({
    active: false,
    stage: "idle",
    message: "Preparing submission..."
  });
  const [appUpdate, setAppUpdate] = useState<UpdatePromptState | null>(null);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [chatPaneWidth, setChatPaneWidth] = useState(getStoredChatPaneWidth);
  const [chatPaneResizing, setChatPaneResizing] = useState(false);
  const chatPaneResizeDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startWidth: number;
  } | null>(null);

  const composerHasContent = prompt.trim().length > 0 || chatMediaAttachments.length > 0;

  const api = window.dartsnutApi;

  useEffect(() => {
    if (!api) return;
    void api.listProjects().then(setProjectTree).catch(() => undefined);
    return api.onProjectSwitchProgress(setProjectSwitchProgress);
  }, [api]);

  useEffect(() => {
    if (!api || !bootstrap?.activeChatId) return;
    void api.listProjects().then(setProjectTree).catch(() => undefined);
  }, [api, bootstrap?.activeChatId]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".ui-composer__project-row")) setProjectMenuOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [projectMenuOpen]);

  const splitPaneViewportWidth = useCallback(() => {
    const rawWidth = typeof window === "undefined" ? 1320 : window.innerWidth;
    return rawWidth - WORKSPACE_MENU_WIDTH_PX - (showEmulatorPane ? MIN_EMULATOR_PANE_WIDTH : 0);
  }, [showEmulatorPane]);

  const mainGridTemplateColumns = useMemo(() => {
    const leftColumn = `${chatPaneWidth}px`;
    const emulatorColumn = `minmax(${MIN_EMULATOR_PANE_WIDTH}px,1fr)`;
    if (!showEmulatorPane) {
      return "minmax(190px,280px) minmax(0,1fr)";
    }
    return `minmax(190px,280px) ${leftColumn} ${emulatorColumn}`;
  }, [chatPaneWidth, showEmulatorPane]);

  const mainGridStyle = useMemo(
    () => ({
      "--app-main-grid-cols": mainGridTemplateColumns
    }) as CSSProperties,
    [mainGridTemplateColumns]
  );
  const chatPaneResizeMax = maxChatPaneWidthForViewport(splitPaneViewportWidth());

  const finishChatPaneResize = useCallback((target?: Element) => {
    const activeDrag = chatPaneResizeDragRef.current;
    if (activeDrag && target instanceof HTMLElement && target.hasPointerCapture(activeDrag.pointerId)) {
      target.releasePointerCapture(activeDrag.pointerId);
    }
    chatPaneResizeDragRef.current = null;
    setChatPaneResizing(false);
  }, []);

  const handleChatPaneResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    chatPaneResizeDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: chatPaneWidth
    };
    setChatPaneResizing(true);
    event.preventDefault();
  }, [chatPaneWidth]);

  const handleChatPaneResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const activeDrag = chatPaneResizeDragRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
      return;
    }
    setChatPaneWidth(nextChatPaneWidthFromDrag({
      startClientX: activeDrag.startClientX,
      currentClientX: event.clientX,
      startWidth: activeDrag.startWidth,
      viewportWidth: splitPaneViewportWidth()
    }));
  }, [splitPaneViewportWidth]);

  const handleChatPaneResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (chatPaneResizeDragRef.current?.pointerId === event.pointerId) {
      finishChatPaneResize(event.currentTarget);
    }
  }, [finishChatPaneResize]);

  const handleChatPaneResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 80 : 24;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setChatPaneWidth((current) => clampChatPaneWidth(current - step, splitPaneViewportWidth()));
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setChatPaneWidth((current) => clampChatPaneWidth(current + step, splitPaneViewportWidth()));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setChatPaneWidth(clampChatPaneWidth(MIN_CHAT_PANE_WIDTH, splitPaneViewportWidth()));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setChatPaneWidth(maxChatPaneWidthForViewport(splitPaneViewportWidth()));
    }
  }, [splitPaneViewportWidth]);

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

  const handleDownloadAppUpdate = useCallback(() => {
    if (!api?.downloadAppUpdate) {
      return;
    }
    setAppUpdate((current) => current ? { ...current, error: null } : current);
    void api.downloadAppUpdate().then((result) => {
      if (!result.ok && result.reason !== "already_downloading") {
        setAppUpdate((current) =>
          current
            ? {
                ...current,
                error: result.message ?? "Could not download the update. Try again next launch."
              }
            : current
        );
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Could not download the update.";
      setAppUpdate((current) => current ? { ...current, error: message } : current);
    });
  }, [api]);

  const handleAutoUpdateChange = useCallback((enabled: boolean) => {
    const persistAutoUpdate = api?.setAppUpdateAutoDownload;
    setAutoUpdateEnabled(enabled);
    if (!persistAutoUpdate) {
      return;
    }
    void persistAutoUpdate(enabled).then(setAutoUpdateEnabled).catch(() => {
      setAutoUpdateEnabled(!enabled);
    });
  }, [api]);

  const handleCheckAppUpdate = useCallback(() => {
    if (!api?.checkAppUpdate) {
      return;
    }
    void api.checkAppUpdate().then((result) => {
      if (!result.ok && result.reason !== "already_checking" && result.reason !== "already_ready") {
        setAppUpdate((current) => current ? { ...current, error: result.message ?? "Could not check for updates." } : current);
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Could not check for updates.";
      setAppUpdate((current) => current ? { ...current, error: message } : current);
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
          prev.analyticsUserId !== session.analyticsUserId ||
          prev.authMethod !== session.authMethod ||
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

  const refreshLlmQuota = useCallback(async () => {
    if (!api?.communityGetLlmQuota || !communitySession.loggedIn) {
      setLlmQuota(null);
      setLlmQuotaError(null);
      setLlmQuotaLoading(false);
      return;
    }
    setLlmQuotaLoading(true);
    setLlmQuotaError(null);
    try {
      const result = await api.communityGetLlmQuota();
      if (!result.ok) {
        if (result.authRequired) {
          await refreshCommunitySession();
        }
        setLlmQuotaError(result.message);
        return;
      }
      setLlmQuota(result.quota);
    } catch (error: unknown) {
      setLlmQuotaError(error instanceof Error ? error.message : "Failed to load today’s usage.");
    } finally {
      setLlmQuotaLoading(false);
    }
  }, [api, communitySession.loggedIn, refreshCommunitySession]);

  useEffect(() => {
    void refreshCommunitySession();
  }, [refreshCommunitySession]);

  useEffect(() => {
    if (screen === "settings" && providerSettings.activeProvider === "dartsnut-llm") {
      void refreshLlmQuota();
    }
  }, [communitySessionVersion, providerSettings.activeProvider, refreshLlmQuota, screen]);

  useEffect(() => {
    if (!providerSettingsNotice) return;
    const timeout = window.setTimeout(() => setProviderSettingsNotice(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [providerSettingsNotice]);

  useEffect(() => {
    if (!providerSettingsError) return;
    const timeout = window.setTimeout(() => setProviderSettingsError(null), 7_000);
    return () => window.clearTimeout(timeout);
  }, [providerSettingsError]);

  useEffect(() => {
    if (communitySession.loggedIn) {
      setDeployAuthGateOpen(false);
    }
  }, [communitySession.loggedIn]);
  useEffect(() => {
    updateAnalyticsUser({
      analyticsUserId: communitySession.analyticsUserId,
      loggedIn: communitySession.loggedIn,
      authMethod: communitySession.authMethod
    });
  }, [communitySession.analyticsUserId, communitySession.authMethod, communitySession.loggedIn]);

  useEffect(() => {
    trackScreenView(screen);
    setAnalyticsViewContext(screen, screen === "settings" ? null : rightPaneTab);
  }, [screen, rightPaneTab]);

  useEffect(() => {
    if (screen !== "main") {
      return;
    }
    trackPanelView(rightPaneTab, "right_pane");
  }, [rightPaneTab, screen]);

  useEffect(() => {
    if (screen !== "main" || !deployEligible) {
      return;
    }
    trackPanelView(deployPaneTab === "games" ? "community" : "deploy", "deploy_pane");
  }, [deployEligible, deployPaneTab, screen]);


  const requestCommunityAuth = useCallback((intent: CommunityAuthIntent, force = false) => {
    setCommunityAuthIntent(intent);
    if (
      force ||
      (!communitySession.loggedIn &&
        (intent === "llm-use" || !isCommunityAuthSkippedForSession()))
    ) {
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

  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const colorScheme = window.matchMedia("(prefers-color-scheme: light)");
    const handleColorSchemeChange = () => applyTheme("system");
    colorScheme.addEventListener("change", handleColorSchemeChange);
    return () => colorScheme.removeEventListener("change", handleColorSchemeChange);
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
      setChatPaneWidth((current) => clampChatPaneWidth(current, splitPaneViewportWidth()));
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [splitPaneViewportWidth]);

  useEffect(() => {
    setStoredChatPaneWidth(chatPaneWidth);
  }, [chatPaneWidth]);

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
    api.getAppUpdateAutoDownload?.().then(setAutoUpdateEnabled).catch(() => {
      setAutoUpdateEnabled(false);
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
          locale: event.visible ? event.locale ?? null : null,
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
          locale: event.visible ? event.locale ?? null : null,
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
          setProjectTypePicker({ visible: false, types: [], locale: null });
          setWidgetSizePicker({ visible: false, sizes: [], locale: null });
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
        if (meta?.phase === "result" && meta.toolName) {
          const analyticsKey = meta.callId ?? `${meta.toolName}:${meta.skillId ?? ""}`;
          if (!seenAgentToolAnalyticsRef.current.has(analyticsKey)) {
            seenAgentToolAnalyticsRef.current.add(analyticsKey);
            trackAgentEvent("agent_tool_used", {
              tool_name: meta.toolName,
              phase: "result"
            });
          }
        }
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

  const acceptWidgetConfig = useCallback((snapshot: WidgetConfigSnapshot) => {
    setWidgetConfigs((previous) => ({ ...previous, [snapshot.scope]: snapshot }));
    if (snapshot.status !== "ready") {
      return;
    }
    setWidgetValuesByConfig((previous) => {
      const current = previous[snapshot.configKey];
      return {
        ...previous,
        [snapshot.configKey]: {
          fields: snapshot.fields,
          values: current
            ? reconcileWidgetFieldValues(current.fields, current.values, snapshot.fields)
            : createDefaultWidgetFieldValues(snapshot.fields)
        }
      };
    });
  }, []);

  useEffect(() => {
    if (!api?.getWidgetConfig || !api.onWidgetConfig) {
      return;
    }
    let cancelled = false;
    for (const scope of ["workspace", "emulator"] as const) {
      void api.getWidgetConfig(scope).then((snapshot) => {
        if (!cancelled) acceptWidgetConfig(snapshot);
      });
    }
    const unsubscribe = api.onWidgetConfig((snapshot) => {
      if (!cancelled) acceptWidgetConfig(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [acceptWidgetConfig, api, bootstrap?.workspaceRoot]);

  const updateWidgetValues = useCallback((configKey: string, values: WidgetFieldValues) => {
    setWidgetValuesByConfig((previous) => {
      const current = previous[configKey];
      return current ? { ...previous, [configKey]: { ...current, values } } : previous;
    });
  }, []);

  const deployPanelShowsWidgetParams = deployEligible && deployEligibility.projectType === "widget";
  const communityWorkspaceRefreshKey = [
    bootstrap?.workspaceRoot ?? "",
    deployEligibility.ok ? deployEligibility.appId : "",
    deployEligibility.ok ? deployEligibility.projectType : deployEligibility.reason
  ].join("|");
  const communityAuthSkipped = communityAuthSkippedVersion >= 0 && isCommunityAuthSkippedForSession();
  const gamesTabDisabled = !communitySession.loggedIn && communityAuthSkipped;
  const visibleAppUpdate =
    (appUpdate?.kind === "available" || appUpdate?.kind === "ready") &&
    appUpdate.dismissedVersion !== appUpdate.availableVersion
      ? appUpdate
      : null;

  // Reset to Emulator tab when the active tab is no longer available.
  useEffect(() => {
    if (!assetManifest && rightPaneTab === "assets") {
      setRightPaneTab("emulator");
    }
  }, [assetManifest, deployEligible, rightPaneTab]);

  useEffect(() => {
    setDeployDrawerOpen(false);
  }, [bootstrap?.activeProjectId]);

  useEffect(() => {
    if (!deployEligible || (gamesTabDisabled && deployPaneTab === "games")) {
      setDeployPaneTab("deploy");
    }
  }, [deployEligible, deployPaneTab, gamesTabDisabled]);

  useEffect(() => {
    const ws = bootstrap?.workspaceRoot;
    if (!api || !ws || !bootstrap?.activeChatId) {
      lastAgentSessionHydrateKeyRef.current = "";
      return;
    }
    if (sending) return;
    const hydrateKey = `${bootstrap.activeProjectId ?? ""}:${bootstrap.activeChatId}`;
    if (lastAgentSessionHydrateKeyRef.current === hydrateKey) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const summary = await api.getWorkspaceSessionSummary();
      if (cancelled) {
        return;
      }
      lastAgentSessionHydrateKeyRef.current = hydrateKey;
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
  }, [api, bootstrap?.workspaceRoot, bootstrap?.activeProjectId, bootstrap?.activeChatId, sending]);

  const chatDisabled = useMemo(() => {
    if (!bootstrap) {
      return true;
    }
    return sending;
  }, [bootstrap, sending]);
  const greetingOnlyTimeline = entries.length > 0 && entries.every(
    (entry) => entry.role === "agent" && (entry.id === "greeting-initial" || entry.id.startsWith("greeting-"))
  );
  const runtimeProgressPercent = Math.min(100, Math.max(0, Math.round(pythonRuntimeProgress.percent)));

  useEffect(() => {
    if (!api) {
      return;
    }
    return api.onSessionReset(() => {
      resetChatSessionUi();
    });
  }, [api]);

  useEffect(() => {
    if (!chatAttachmentError) {
      return;
    }
    const timer = window.setTimeout(() => setChatAttachmentError(null), CHAT_ATTACHMENT_ERROR_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [chatAttachmentError]);

  function resetChatSessionUi() {
    discardAgentEventsRef.current = true;
    clearActiveCoalescedStreamEntries();
    activeToolStatusEntryByKeyRef.current.clear();
    seenAgentToolAnalyticsRef.current.clear();
    activeAgentRunRef.current = null;
    eventSeqRef.current = 0;
    lastAgentSessionHydrateKeyRef.current = "";
    setSessionTemplateMode(null);
    setSessionWidgetSize(null);
    setSessionProjectType(null);
    setTokenUsage(null);
    setWidgetSizePicker({ visible: false, sizes: [], locale: null });
    setProjectTypePicker({ visible: false, types: [], locale: null });
    setPrompt("");
    setChatMediaAttachments([]);
    setChatAttachmentError(null);
    setComposerDragActive(false);
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

  function finishAgentRun(outcome: "success" | "rejected" | "failed" | "cancelled", failureReason?: string): void {
    const run = activeAgentRunRef.current;
    if (!run || run.finished) {
      return;
    }
    run.finished = true;
    trackAgentEvent("agent_run_finished", {
      outcome,
      duration_ms: Math.max(0, Date.now() - run.startedAt),
      ...(failureReason ? { failure_reason: failureReason } : {})
    });
    activeAgentRunRef.current = null;
  }

  async function submitPrompt(request: PromptRequest, firstUserMessageForTitle?: string) {
    setWidgetSizePicker({ visible: false, sizes: [], locale: null });
    setProjectTypePicker({ visible: false, types: [], locale: null });
    discardAgentEventsRef.current = false;
    setSending(true);
    if (!api) {
      setSending(false);
      return;
    }
    seenAgentToolAnalyticsRef.current.clear();
    activeAgentRunRef.current = { startedAt: Date.now(), finished: false };
    const shouldGenerateTitle = !request.chatId && Boolean(firstUserMessageForTitle?.trim());
    trackAgentEvent("agent_run_started", {
      provider: providerSettings.activeProvider,
      template_mode: request.templateMode ?? (request.creationIntake ? "creation_intake" : "follow_up"),
      project_type: request.projectType ?? sessionProjectType ?? "unknown",
      workspace_kind: request.workspacePath
        ? (bootstrap?.isTemporaryWorkspace ? "temporary" : "persisted")
        : "none",
      attachment_count: request.chatMediaAttachments?.length ?? 0,
      creation_intake: request.creationIntake === true
    });
    try {
      const result: SendPromptResponse = await api.sendPrompt(request);
      const refreshed = await api.getBootstrapState();
      setBootstrap(refreshed);
      if (shouldGenerateTitle && refreshed.activeChatId && firstUserMessageForTitle) {
        void api.generateChatTitle({
          chatId: refreshed.activeChatId,
          firstUserMessage: firstUserMessageForTitle
        }).then(({ tree }) => setProjectTree(tree)).catch(() => undefined);
      }
      if (!result.ok) {
        finishAgentRun("rejected", result.failureReason);
        if (result.failureReason === "auth_required") {
          await refreshCommunitySession();
          requestCommunityAuth("llm-use", true);
        }
        if (result.message) {
          postStatus(result.message);
        }
        return;
      }
      if (result.sessionRouting) {
        setSessionTemplateMode(result.sessionRouting.templateMode);
        setSessionProjectType(result.sessionRouting.projectType);
        setSessionWidgetSize(result.sessionRouting.widgetSize ?? null);
      }
      finishAgentRun("success");
    } catch (error) {
      finishAgentRun("failed");
      throw error;
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

  async function handleNewChat() {
    if (!api || sending || projectSwitchProgress.active) return;
    await handleNoProject();
  }

  function handleCreateProject() {
    if (sending) return;
    setProjectMenuOpen(false);
    setCreateProjectName("");
    setCreateProjectFolder(null);
    setCreateProjectError(null);
    setCreateProjectOpen(true);
  }

  async function handlePickProjectFolder() {
    if (!api || sending || createProjectPicking) return;
    setCreateProjectPicking(true);
    setCreateProjectError(null);
    try {
      const picked = await api.pickWorkspace();
      if (picked.accepted && picked.selectedPath) {
        setCreateProjectFolder(picked.selectedPath);
        setCreateProjectName((current) => current.trim() || workspaceFolderBasename(picked.selectedPath!));
      }
    } catch (error: unknown) {
      setCreateProjectError(error instanceof Error ? error.message : "Could not choose source folder.");
    } finally {
      setCreateProjectPicking(false);
    }
  }

  async function handleSubmitCreateProject() {
    if (!api || sending || !createProjectFolder) return;
    setCreateProjectError(null);
    try {
      const result = await api.createProject({ folderPath: createProjectFolder, name: createProjectName });
      setCreateProjectOpen(false);
      setBootstrap(result.state); setProjectTree(result.tree); resetChatSessionUi();
    } catch (error: unknown) {
      setCreateProjectError(error instanceof Error ? error.message : "Could not create project.");
    }
  }

  async function handleSelectProject(projectId: string) {
    if (!api || sending || projectSwitchProgress.active) return;
    const result = await api.selectProject({ projectId });
    if (result.accepted) { setBootstrap(result.state); setProjectTree(result.tree); resetChatSessionUi(); }
    setProjectMenuOpen(false);
  }

  async function handleNoProject() {
    if (!api || sending || projectSwitchProgress.active) return;
    const result = await api.selectProject({ projectId: null });
    if (result.accepted) { setBootstrap(result.state); setProjectTree(result.tree); resetChatSessionUi(); }
    setProjectMenuOpen(false);
  }

  async function handleNewChatForProject(projectId: string) {
    await handleSelectProject(projectId);
  }

  async function handleSelectChat(chatId: string) {
    if (!api || sending) return;
    const result = await api.selectChat(chatId); setBootstrap(result.state); setProjectTree(result.tree);
  }

  async function handleArchiveChat(chatId: string) {
    if (!api || sending || projectSwitchProgress.active) return;
    const wasActive = bootstrap?.activeChatId === chatId;
    const result = await api.archiveChat(chatId);
    setBootstrap(result.state); setProjectTree(result.tree);
    if (wasActive) resetChatSessionUi();
  }

  function handleOpenSettings() {
    setScreen((current) => current === "settings" ? "main" : "settings");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isSettingsShortcut(event)) {
        event.preventDefault();
        handleOpenSettings();
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
      if (!custom.baseUrl.trim()) {
        setProviderSettingsError("Endpoint is required.");
        return;
      }
      if (!custom.apiKey.trim()) {
        setProviderSettingsError("API key is required.");
        return;
      }
      if (!custom.model.trim()) {
        setProviderSettingsError("Model is required.");
        return;
      }
      try {
        new URL(custom.baseUrl.trim());
      } catch {
        setProviderSettingsError("Endpoint must be a valid URL.");
        return;
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
    trackAgentEvent("agent_question_answered", {
      question_type: "project_type",
      answer_method: "chip",
      outcome: res.ok ? "success" : "rejected"
    });
    if (!res.ok) {
      if (res.reason === "no_pending") {
        postStatus(projectTypeIntakeCopy.status.noPendingProjectType);
      } else if (res.reason === "kind_mismatch" || res.reason === "invalid_value") {
        postStatus(projectTypeIntakeCopy.status.choiceMismatch);
      }
    }
  }

  async function handleWidgetSizeChip(size: WidgetSize) {
    if (!api) {
      return;
    }
    const res = await api.intakeSubmitQuestionAnswer({ kind: "widget_size", value: size });
    trackAgentEvent("agent_question_answered", {
      question_type: "widget_size",
      answer_method: "chip",
      outcome: res.ok ? "success" : "rejected"
    });
    if (!res.ok) {
      if (res.reason === "no_pending") {
        postStatus(widgetSizeIntakeCopy.status.noPendingWidgetSize);
      } else if (res.reason === "kind_mismatch" || res.reason === "invalid_value") {
        postStatus(widgetSizeIntakeCopy.status.choiceMismatch);
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
    trackAgentEvent("agent_question_answered", {
      question_type: "machine",
      answer_method: "known_machine",
      outcome: res.ok ? "success" : "rejected"
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
    trackAgentEvent("agent_question_answered", {
      question_type: "machine",
      answer_method: "manual_host",
      outcome: res.ok ? "success" : "rejected"
    });
    if (!res.ok) {
      setMachineMcpInputError("That address could not be used.");
    }
  }

  function resolveChatMediaAttachments(fileList: FileList): { accepted: ChatMediaAttachment[]; rejected: number } {
    const files = Array.from(fileList);
    const accepted: ChatMediaAttachment[] = [];
    let rejected = 0;
    for (const file of files) {
      const filePath = api?.assets?.getPathForFile(file) ?? "";
      const displayName = file.name || filePath.split(/[\\/]/).pop() || "media file";
      const kind = inferChatMediaAttachmentKind(file.type, displayName);
      if (!filePath || !kind) {
        rejected += 1;
        continue;
      }
      accepted.push({
        id: createChatMediaAttachmentId(),
        path: filePath,
        name: displayName,
        mimeType: file.type,
        kind,
        size: file.size
      });
    }
    return { accepted, rejected };
  }

  function handleComposerDragOver(event: DragEvent<HTMLDivElement>) {
    if (chatDisabled || !event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setComposerDragActive(true);
  }

  function handleComposerDragLeave(event: DragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setComposerDragActive(false);
  }

  function handleComposerDrop(event: DragEvent<HTMLDivElement>) {
    if (chatDisabled) {
      return;
    }
    event.preventDefault();
    setComposerDragActive(false);
    const { accepted, rejected } = resolveChatMediaAttachments(event.dataTransfer.files);
    if (accepted.length > 0) {
      setChatMediaAttachments((prev) => mergeChatMediaAttachments(prev, accepted));
      setChatAttachmentError(null);
    }
    if (rejected > 0) {
      setChatAttachmentError("Drop image, audio, or video files from your computer.");
    }
  }

  async function handleSend() {
    if (!composerHasContent || chatDisabled) {
      return;
    }
    if (bootstrap?.providerStatus !== "ready") {
      postStatus("Provider settings are incomplete. Open Settings and save API key + model, then send again.");
      setScreen("settings");
      return;
    }
    const visiblePrompt = prompt.trim();
    const attachments = chatMediaAttachments;
    const visibleUserText = attachments.length > 0
      ? [
        visiblePrompt || "Add the attached media files into the current game/widget.",
        "",
        `Attached: ${attachments.map((attachment) => attachment.name).join(", ")}`
      ].join("\n")
      : visiblePrompt;
    setPrompt("");
    setChatMediaAttachments([]);
    setEntries((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", text: visibleUserText }]);

    await submitPrompt({
      prompt: visiblePrompt,
      chatMediaAttachments: attachments,
      workspacePath: bootstrap?.workspaceRoot ?? undefined,
      projectId: bootstrap?.activeProjectId ?? undefined,
      chatId: bootstrap?.activeChatId ?? undefined,
      templateMode: bootstrap?.needsCreationIntake ? undefined : sessionTemplateMode ?? undefined,
      widgetSize: bootstrap?.needsCreationIntake ? undefined : sessionWidgetSize ?? undefined,
      projectType: bootstrap?.needsCreationIntake ? undefined : sessionProjectType ?? undefined
    }, visibleUserText);
  }

  async function handleStopAgent() {
    if (!api || !sending) {
      return;
    }
    clearActiveCoalescedStreamEntries();
    activeToolStatusEntryByKeyRef.current.clear();
    setWidgetSizePicker({ visible: false, sizes: [], locale: null });
    setProjectTypePicker({ visible: false, types: [], locale: null });
    finishAgentRun("cancelled");
    try {
      await api.cancelAgent();
    } catch {
      // Bridge unavailable — nothing to abort.
    } finally {
      setSending(false);
    }
  }

  return (
    <main
      className={cn(
        "app-shell grid h-full w-full items-stretch pt-0",
        "grid-cols-[var(--app-main-grid-cols)]",
        "grid-rows-[auto_minmax(0,1fr)]",
        "pr-[var(--window-control-inset-right)] pb-[var(--window-control-inset-bottom)] pl-[var(--window-control-inset-left)]",
        "max-[1100px]:grid-cols-[54px_minmax(0,1fr)] max-[1100px]:grid-rows-[auto_minmax(0,1fr)]",
        chatPaneResizing && "app-shell--chat-resizing"
      )}
      style={mainGridStyle}
      aria-busy={submissionLock.active}
    >
      <header
        className="app-header col-span-full row-start-1 flex min-h-[max(var(--window-control-inset-top),40px)] items-center gap-2 [app-region:no-drag] [-webkit-app-region:no-drag]"
        style={{
          paddingLeft: "calc(6px + var(--chrome-margin-inline-start))",
          paddingRight: "calc(6px + var(--chrome-margin-inline-end))",
          paddingTop: "5px",
          paddingBottom: "5px"
        }}
        role="banner"
      >
        <div className="min-h-0 min-w-0 flex-1 self-stretch [-webkit-app-region:drag] [app-region:drag]" aria-hidden />
        {screen === "main" ? (
            <div className="inline-flex shrink-0 items-center justify-end gap-3 overflow-visible">
              <UpdateDownloadPill status={appUpdate} />
              {showDeployDrawer ? (
                <button
                  type="button"
                  className="header-deploy-toggle max-[1100px]:hidden"
                  aria-label={deployDrawerOpen ? "Collapse Deploy and Community panel" : "Open Deploy and Community panel"}
                  aria-expanded={deployDrawerOpen}
                  title={deployDrawerOpen ? "Collapse right panel" : "Open right panel"}
                  onClick={() => setDeployDrawerOpen((open) => !open)}
                >
                  {deployDrawerOpen ? <PanelRightClose size={18} aria-hidden /> : <PanelRightOpen size={18} aria-hidden />}
                </button>
              ) : null}
            </div>
        ) : null}
      </header>
      <aside className={cn("workspace-menu col-start-1 row-start-2", screen === "settings" && "workspace-menu--settings")} aria-label={screen === "settings" ? "Settings menu" : "Workspace menu"}>
        {screen === "settings" ? <>
          <div className="workspace-menu__actions">
            <button type="button" className="workspace-menu__button" onClick={() => { setScreen("main"); setProviderSettingsError(null); setProviderSettingsNotice(null); }} aria-label="Back to app" title="Back to app">
              <ArrowLeft size={16} aria-hidden />
              <span className="workspace-menu__button-label">Back to app</span>
            </button>
          </div>
          <nav className="workspace-menu__settings-nav" aria-label="Settings sections">
            <p className="workspace-menu__section-label">Settings</p>
            <button type="button" className={cn("workspace-menu__button", settingsSection === "general" && "workspace-menu__button--active")} onClick={() => setSettingsSection("general")} aria-current={settingsSection === "general" ? "page" : undefined} data-analytics-id="settings_general" data-analytics-area="settings">
              <Settings size={16} aria-hidden /><span className="workspace-menu__button-label">General</span>
            </button>
            <button type="button" className={cn("workspace-menu__button", settingsSection === "provider" && "workspace-menu__button--active")} onClick={() => setSettingsSection("provider")} aria-current={settingsSection === "provider" ? "page" : undefined}>
              <CircleAlert size={16} aria-hidden /><span className="workspace-menu__button-label">Provider configuration</span>
            </button>
          </nav>
        </> : <>
        <div className="workspace-menu__actions">
          <button
            type="button"
            className="workspace-menu__button"
            onClick={() => void handleNewChat()}
            data-analytics-id="project_new"
            data-analytics-area="project"
            disabled={sending || projectSwitchProgress.active}
            aria-label="New chat"
            title="New chat"
          >
            <SquarePen size={16} aria-hidden />
            <span className="workspace-menu__button-label">New chat</span>
          </button>
        </div>
        <div className="workspace-menu__projects">
          <button
            type="button"
            className="workspace-menu__section"
            aria-expanded={expandedProjects.__all ?? true}
            onClick={() => setExpandedProjects((p) => ({ ...p, __all: !(p.__all ?? true) }))}
          >
            <span>Projects</span>
          </button>
          {(expandedProjects.__all ?? true) ? projectTree.projects.map((project) => {
            const open = expandedProjects[project.id] ?? true;
            const projectChats = projectTree.chats.filter((chat) => chat.projectId === project.id);
            return <div key={project.id} className="workspace-menu__project-group">
              <div className="workspace-menu__project-row">
                <button type="button" className="workspace-menu__project" onClick={() => { setExpandedProjects((p) => ({ ...p, [project.id]: !open })); void handleSelectProject(project.id); }}>
                  <FolderOpen className="workspace-menu__project-icon" size={16} aria-hidden />
                  <span className="truncate">{project.name}</span>
                </button>
                <button
                  type="button"
                  className="workspace-menu__project-new-chat"
                  onClick={(event) => { event.stopPropagation(); void handleNewChatForProject(project.id); }}
                  disabled={sending || projectSwitchProgress.active}
                  aria-label={`New chat for ${project.name}`}
                  title={`New chat for ${project.name}`}
                  data-analytics-id="project_new_for_project"
                  data-analytics-area="project"
                >
                  <SquarePen size={14} aria-hidden />
                </button>
              </div>
              {open && projectChats.length === 0 ? (
                <div className="workspace-menu__chat-empty">No chats</div>
              ) : null}
              {open ? projectChats.map((chat) => {
                const active = bootstrap?.activeChatId === chat.id;
                return <div key={chat.id} className={cn("workspace-menu__chat-row", active && "workspace-menu__chat-row--active")}>
                  <button type="button" className={cn("workspace-menu__chat", active && "workspace-menu__chat--active")} onClick={() => void handleSelectChat(chat.id)}>
                    <span className="truncate">{chat.title}</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-menu__chat-archive"
                    onClick={(event) => { event.stopPropagation(); void handleArchiveChat(chat.id); }}
                    disabled={sending || projectSwitchProgress.active}
                    aria-label={`Archive ${chat.title}`}
                    title={`Archive ${chat.title}`}
                  >
                    <Archive size={13} aria-hidden />
                  </button>
                </div>;
              }) : null}
            </div>;
          }) : null}
        </div>
        </>}
        <div className="workspace-menu__utilities">
          <CommunityAuthStatus
            placement="rail"
            communitySession={communitySession}
            onOpenSettings={handleOpenSettings}
            onAuthRequired={() => requestCommunityAuth("deploy-devices", true)}
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
        </div>
      </aside>
      {screen === "main" && showRuntimeSetup ? (
        <section
          className={cn(
            "runtime-config-main col-start-2 row-start-2 min-h-0 h-full overflow-auto bg-[var(--gradient-rail)] max-[1100px]:col-end-3",
            showEmulatorPane ? "col-end-4" : "col-end-3"
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
            "left-rail left-rail--chat col-start-2 row-start-2 relative min-w-0 min-h-0 h-full overflow-hidden border-r border-edge bg-[var(--gradient-rail)]",
            "max-[1100px]:col-start-2 max-[1100px]:row-start-2 max-[1100px]:max-w-[760px]"
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

          {activeChat ? <div className="chat-panel-chat-header" title={activeChat.title}>
            <FolderOpen size={15} aria-hidden />
            <span>{activeChat.title}</span>
          </div> : null}

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
              question={projectTypeIntakeCopy.projectTypeQuestion}
              labels={projectTypeIntakeCopy.card}
              options={projectTypePicker.types.map((pt) => ({
                value: pt,
                label: projectTypeIntakeCopy.projectTypeLabels[pt],
              }))}
              onSubmit={(value) => void handleProjectTypeChip(value as ProjectType)}
            />
          ) : widgetSizePicker.visible && widgetSizePicker.sizes.length > 0 ? (
            <AskQuestionCard
              question={widgetSizeIntakeCopy.widgetSizeQuestion}
              labels={widgetSizeIntakeCopy.card}
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
                chatMediaAttachments.length > 0 && "ui-composer--has-attachments",
                composerDragActive && "ui-composer--drag-active"
              )}
              data-expanded={composerExpandedSticky ? "true" : undefined}
              onDragOver={handleComposerDragOver}
              onDragLeave={handleComposerDragLeave}
              onDrop={handleComposerDrop}
            >
              {greetingOnlyTimeline ? <div className="ui-composer__project-row">
                <button type="button" className={cn("project-chat-trigger", projectMenuOpen && "project-chat-trigger--active")} onClick={() => setProjectMenuOpen((open) => !open)} disabled={projectSwitchProgress.active || sending} aria-haspopup="menu" aria-expanded={projectMenuOpen}>
                  <Folder className="ui-composer__project-glyph" size={16} aria-hidden />
                  <span className="project-chat-trigger__label">{projectTree.projects.find((project) => project.id === bootstrap?.activeProjectId)?.name ?? "Choose Project"}</span>
                </button>
                {projectMenuOpen ? <div className="project-picker-menu" role="menu">
                  {projectTree.projects.map((project) => <button key={project.id} type="button" role="menuitem" className={cn("project-picker-menu__item", bootstrap?.activeProjectId === project.id && "project-picker-menu__item--active")} onClick={() => void handleSelectProject(project.id)}><FolderOpen className="project-picker-menu__folder" size={20} aria-hidden /><span>{project.name}</span>{bootstrap?.activeProjectId === project.id ? <Check className="project-picker-menu__check" size={18} aria-hidden /> : null}</button>)}
                  {projectTree.projects.length > 0 ? <div className="project-picker-menu__divider" /> : null}
                  <button type="button" role="menuitem" className="project-picker-menu__item" onClick={handleCreateProject}><Plus className="project-picker-menu__plus" size={20} aria-hidden /><span>Add project</span></button>
                </div> : null}
              </div> : null}
              {chatMediaAttachments.length > 0 ? (
                <div className="ui-composer-attachments" aria-label="Attached media files">
                  {chatMediaAttachments.map((attachment) => (
                    <span key={attachment.path} className="ui-composer-attachment">
                      <span className="ui-composer-attachment__kind">{attachment.kind}</span>
                      <span className="ui-composer-attachment__name">{attachment.name}</span>
                      <button
                        type="button"
                        className="ui-composer-attachment__remove"
                        aria-label={`Remove ${attachment.name}`}
                        data-analytics-id="agent_attachment_remove"
                        data-analytics-area="agent"
                        disabled={chatDisabled}
                        onClick={() =>
                          setChatMediaAttachments((prev) => prev.filter((item) => item.path !== attachment.path))
                        }
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="ui-composer__input-row">
              <textarea
                ref={promptInputRef}
                className={cn(
                  "m-0 max-h-[200px] min-h-[26px] min-w-0 resize-none overflow-y-hidden border-0 bg-transparent px-1 py-0.5 text-[13px] leading-snug text-[var(--color-composer-input)] shadow-none outline-none [font:inherit] placeholder:text-[var(--color-composer-placeholder)] focus:border-0 focus:shadow-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-45",
                  "flex-1"
                )}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (isComposerSendShortcut(event)) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Do anything"
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
                    data-analytics-id="agent_scroll_to_bottom"
                    data-analytics-area="agent"
                    onClick={() => {
                      scrollTimelineToBottom();
                      setAutoScrollEnabled(true);
                    }}
                  >
                    <ArrowDown size={14} aria-hidden />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="m-0 inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-[var(--color-composer-send-bg)] p-0 text-[var(--color-composer-send-fg)] hover:enabled:bg-[var(--color-composer-send-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={sending ? false : chatDisabled || !composerHasContent}
                  aria-busy={false}
                  aria-label={sending ? "Stop" : "Send"}
                  data-analytics-id={sending ? "agent_stop" : "agent_send"}
                  data-analytics-area="agent"
                  onClick={() => (sending ? void handleStopAgent() : void handleSend())}
                >
                  {sending ? (
                    <Square size={14} fill="currentColor" aria-hidden />
                  ) : (
                    <ArrowUp size={15} strokeWidth={2.2} aria-hidden />
                  )}
                </button>
              </div>
              </div>
            </div>
            {chatAttachmentError ? (
              <p className="ui-composer-attachment-error" role="status">
                {chatAttachmentError}
              </p>
            ) : null}
          </section>
            </div>
          </div>
          {showEmulatorPane ? (
            <div
              className={cn("chat-emulator-splitter", chatPaneResizing && "chat-emulator-splitter--active")}
              role="separator"
              tabIndex={0}
              aria-label="Resize chat and emulator panels"
              aria-orientation="vertical"
              aria-valuemin={MIN_CHAT_PANE_WIDTH}
              aria-valuemax={chatPaneResizeMax}
              aria-valuenow={chatPaneWidth}
              title="Drag to resize chat and emulator panels"
              onPointerDown={handleChatPaneResizePointerDown}
              onPointerMove={handleChatPaneResizePointerMove}
              onPointerUp={handleChatPaneResizePointerUp}
              onPointerCancel={handleChatPaneResizePointerUp}
              onKeyDown={handleChatPaneResizeKeyDown}
            />
          ) : null}
        </section>
      ) : (
        <section className="settings-page col-start-2 col-end-4 row-start-2 min-h-0 overflow-auto">
          <div className="settings-page__content">
          <div className="settings-page__body">
              {settingsSection === "provider" ? (
                <div>
                  <h1 className="m-0 text-2xl font-semibold text-fg-strong">Provider configuration</h1>
                  <p className="mt-1 text-sm leading-relaxed text-fg-muted">Choose and configure the model provider used by Dartsnut Agent.</p>
                </div>
              ) : null}
              {settingsSection === "general" ? (
                <>
                  <div>
                    <h1 className="m-0 text-2xl font-semibold text-fg-strong">General</h1>
                    <p className="mt-1 text-sm leading-relaxed text-fg-muted">
                      Control app appearance, updates, and privacy.
                    </p>
                  </div>
                  <h2 className="settings-group-heading">General</h2>
                  <SettingsGroup>
                    <SettingsRow title="Theme" description="Choose how Dartsnut Agent looks." control={
                      <SettingsSelect value={theme} label="Theme" options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={handleThemeChange} />
                    } />
                  </SettingsGroup>
                  <h2 className="settings-group-heading">Update</h2>
                  <SettingsGroup>
                    <SettingsRow title="Automatically download updates" description="Check for new versions on launch and download them automatically. Installation still requires your confirmation." control={
                      <SettingsSwitch checked={autoUpdateEnabled} label="Automatically download updates" analyticsId="settings_auto_update_toggle" onChange={handleAutoUpdateChange} />
                    } />
                    <SettingsRow title="App updates" description={appUpdate?.kind === "not_available" ? appUpdate.message ?? "Dartsnut Agent is up to date." : appUpdate?.kind === "error" ? appUpdate.message ?? "Update check failed." : "Check for a newer desktop version."} control={<button
                      type="button"
                      className="ui-btn-secondary min-h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-55"
                      disabled={appUpdate?.kind === "checking" || appUpdate?.kind === "downloading" || appUpdate?.kind === "ready"}
                      onClick={handleCheckAppUpdate}
                      data-analytics-id="settings_check_update"
                      data-analytics-area="settings"
                    >
                      {appUpdate?.kind === "checking" ? "Checking..." : "Check for updates"}
                    </button>} />
                  </SettingsGroup>
                  <h2 className="settings-group-heading">Privacy</h2>
                  <SettingsGroup>
                    <SettingsRow title="Share anonymous usage analytics" description="Helps improve Dartsnut Agent. Chat text, model responses, file paths, credentials, account names, and email addresses are never sent." control={
                      <SettingsSwitch checked={analyticsEnabled} label="Share anonymous usage analytics" analyticsId="analytics_toggle" onChange={(enabled) => {
                        setAnalyticsEnabled(enabled);
                        setAnalyticsCollectionEnabledPreference(enabled);
                      }} />
                    } />
                  </SettingsGroup>
                </>
              ) : null}
              {settingsSection === "provider" ? (<SettingsGroup>
                <SettingsRow title="Provider" description="Model service used for agent requests." control={
                  <SettingsSelect value={providerSettings.activeProvider} label="Provider" options={[{ value: "dartsnut-llm", label: "Dartsnut LLM" }, { value: "custom", label: "Custom" }]} onChange={(value) =>
                    setProviderSettings((prev) =>
                      withProviderId(prev, value)
                    )
                  } />
                } />
              {settingsSection === "provider" && providerSettings.activeProvider === "dartsnut-llm" ? (
                <SettingsRow title="Daily usage" description="Today's Dartsnut LLM token allowance."><DartsnutLlmUsageCard
                    quota={llmQuota}
                    loading={llmQuotaLoading}
                    error={llmQuotaError}
                    loggedIn={communitySession.loggedIn}
                    onRefresh={() => void refreshLlmQuota()}
                  /></SettingsRow>
              ) : null}
              {settingsSection === "provider" && providerSettings.activeProvider === "dartsnut-llm" ? (
                  <SettingsRow><div className="rounded-[var(--radius-md)] border border-[var(--color-notice-success-border)] bg-[var(--color-notice-success-bg)] px-3 py-2 text-xs leading-relaxed text-fg">
                    <p className="m-0 font-medium">This service is free for a limited time only.</p>
                    <p className="m-0 mt-1 text-fg-muted">
                      Please use Dartsnut LLM only for creating and updating Dartsnut games,
                      widgets, and related project assets. Avoid sending unrelated, sensitive,
                      or personal content.
                    </p>
                  </div></SettingsRow>
              ) : null}
              {settingsSection === "provider" && providerSettings.activeProvider === "custom" ? (
                <>
                  <SettingsRow><div className="rounded-[var(--radius-md)] border border-[var(--color-notice-warning-border)] bg-[var(--color-notice-warning-bg)] px-3 py-2 text-xs leading-relaxed text-fg">
                    Custom providers must expose an OpenAI Responses API-compatible endpoint.
                    Chat Completions and Gemini APIs are not supported.
                  </div></SettingsRow>
                  <SettingsRow title="API base URL" description="Responses API-compatible endpoint." control={<input
                      type="url"
                      className="ui-input settings-row__input"
                      value={providerCustom(providerSettings).baseUrl}
                      onChange={(event) =>
                        setProviderSettings((prev) =>
                          withProviderCustom(prev, (custom) => ({ ...custom, baseUrl: event.target.value }))
                        )
                      }
                      placeholder="https://provider.example.com/v1"
                    />} />
                  <SettingsRow title="API key" description={`Stored key: ${maskApiKey(providerCustom(providerSettings).apiKey) || "(empty)"}`} control={<input
                      type="password"
                      className="ui-input settings-row__input"
                      value={providerCustom(providerSettings).apiKey}
                      onChange={(event) =>
                        setProviderSettings((prev) =>
                          withProviderCustom(prev, (custom) => ({ ...custom, apiKey: event.target.value }))
                        )
                      }
                      placeholder="provider-key"
                    />} />
                  <SettingsRow title="Model" description="Model identifier sent to the provider." control={<input
                      type="text"
                      className="ui-input settings-row__input"
                      value={providerCustom(providerSettings).model}
                      onChange={(event) =>
                        setProviderSettings((prev) =>
                          withProviderCustom(prev, (custom) => ({ ...custom, model: event.target.value }))
                        )
                      }
                      placeholder="model-name"
                    />} />
                </>
              ) : null}
              {settingsSection === "provider" ? <SettingsRow title="Save configuration" description="Apply provider changes to future requests." control={
                <button
                  type="button"
                  className="ui-btn-primary mt-0 disabled:cursor-not-allowed disabled:opacity-55"
                  onClick={() => void handleSaveProviderSettings()}
                  data-analytics-id="provider_save"
                  data-analytics-area="settings"
                  disabled={savingProviderSettings}
                >
                  {savingProviderSettings ? "Saving..." : "Save"}
                </button>
              } /> : null}
              </SettingsGroup>) : null}
          </div>
          </div>
        </section>
      )}
      {showEmulatorPane ? <aside
        className={cn(
          "right-pane col-start-3 row-start-2 flex min-h-0 h-full min-w-[360px] flex-1 flex-col overflow-hidden border-l border-edge bg-[var(--color-right-pane-bg)]",
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
                data-analytics-id="panel_emulator"
                data-analytics-area="navigation"
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
                  data-analytics-id="panel_assets"
                  data-analytics-area="navigation"
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
                widgetConfig={widgetConfigs.emulator}
                widgetValuesByConfig={widgetValuesByConfig}
                onWidgetValuesChange={updateWidgetValues}
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
      </aside> : null}
      {showDeployDrawer ? (
        <div
          className={cn(
            "deploy-drawer-viewport max-[1100px]:hidden",
            deployDrawerOpen ? "deploy-drawer-viewport--open" : "deploy-drawer-viewport--closed"
          )}
        >
        <aside
          className={cn(
            "right-pane deploy-drawer flex min-h-0 flex-col overflow-hidden border-l border-edge bg-[var(--color-right-pane-bg)]",
            deployDrawerOpen ? "deploy-drawer--open" : "deploy-drawer--closed"
          )}
          aria-hidden={!deployDrawerOpen}
          inert={deployDrawerOpen ? undefined : true}
        >
          <div className="flex gap-0.5 border-b border-edge px-3 pb-0 pt-2" role="tablist" aria-label="Deploy view">
            <button
              type="button"
              className={cn("ui-tab", deployPaneTab === "deploy" && "ui-tab--active")}
              role="tab"
              aria-selected={deployPaneTab === "deploy"}
              onClick={() => setDeployPaneTab("deploy")}
              data-analytics-id="panel_deploy"
              data-analytics-area="navigation"
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
              data-analytics-id="panel_community"
              data-analytics-area="navigation"
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
                active={deployDrawerOpen && deployPaneTab === "deploy"}
                showWidgetParams={deployPanelShowsWidgetParams}
                widgetConfig={widgetConfigs.workspace}
                widgetValuesByConfig={widgetValuesByConfig}
                onWidgetValuesChange={updateWidgetValues}
                communitySession={communitySession}
                communitySessionVersion={communitySessionVersion + communityAuthSkippedVersion}
                onCommunitySessionChange={refreshCommunitySession}
                onAuthRequired={requestDeployCommunityAuth}
              />
            </div>
            <div className={cn("flex min-h-0 flex-1 flex-col", deployPaneTab !== "games" && "hidden")}>
              <MyGamesPanel
                active={deployDrawerOpen && deployPaneTab === "games"}
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
        </div>
      ) : null}
      {providerSettingsError || providerSettingsNotice ? (
        <div className="global-toast-stack" aria-live="polite">
          {providerSettingsError ? <div className="global-toast global-toast--error" role="alert">{providerSettingsError}</div> : null}
          {providerSettingsNotice ? <div className="global-toast global-toast--success" role="status">{providerSettingsNotice}</div> : null}
        </div>
      ) : null}
      {projectSwitchProgress.active ? <div className="project-switch-overlay" role="status" aria-live="polite"><div><h2>Switching project</h2><p>{projectSwitchProgress.message ?? "Preparing…"}</p></div></div> : null}
      {createProjectOpen ? (
        <div
          className="create-project-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-project-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCreateProjectOpen(false);
          }}
        >
          <div className="create-project-popover">
            <div className="create-project-popover__header">
              <h2 id="create-project-title">Create project</h2>
              <button type="button" className="create-project-popover__close" aria-label="Close" onClick={() => setCreateProjectOpen(false)}><X size={22} aria-hidden /></button>
            </div>
            <label className="create-project-name-field">
              <Folder size={24} strokeWidth={1.7} aria-hidden />
              <input value={createProjectName} onChange={(event) => setCreateProjectName(event.target.value)} placeholder="Project name" autoFocus />
            </label>
            <p className="create-project-popover__section-label">Source folder</p>
            <button type="button" className={cn("create-project-folder-picker", createProjectFolder && "create-project-folder-picker--selected")} onClick={() => void handlePickProjectFolder()} disabled={createProjectPicking}>
              <FolderPlus size={32} strokeWidth={1.5} aria-hidden />
              <span>{createProjectFolder ? workspaceFolderBasename(createProjectFolder) : "Add folder Dartsnut Agent can read and edit"}</span>
              {createProjectFolder ? <small>{createProjectFolder}</small> : null}
            </button>
            <p className="create-project-popover__hint">Each project uses one source folder.</p>
            {createProjectError ? <p className="create-project-popover__error" role="alert">{createProjectError}</p> : null}
            <div className="create-project-popover__actions">
              <button type="button" className="create-project-popover__cancel" onClick={() => setCreateProjectOpen(false)}>Cancel</button>
              <button type="button" className="create-project-popover__submit" disabled={!createProjectFolder || createProjectPicking || sending} onClick={() => void handleSubmitCreateProject()}>Create project</button>
            </div>
          </div>
        </div>
      ) : null}
      <DeployAuthGate
        open={deployAuthGateOpen}
        googleSignInAvailable={communitySession.googleSignInAvailable}
        title={
          communityAuthIntent === "my-games"
            ? "Sign in to publish apps"
            : communityAuthIntent === "llm-use"
              ? "Sign in to use Dartsnut LLM"
              : "Sign in to pick a device"
        }
        description={
          communityAuthIntent === "my-games"
            ? "Log in with your Dartsnut account to publish games and widgets."
            : communityAuthIntent === "llm-use"
              ? "Dartsnut LLM requires a signed-in account with at least one bound machine."
              : "Log in with your Dartsnut account to select a bound machine and use its IP automatically. You can continue without signing in and enter an IP manually."
        }
        allowSkip={communityAuthIntent !== "llm-use"}
        onClose={() => {
          setDeployAuthGateOpen(false);
          if (communityAuthIntent === "my-games") {
            setDeployPaneTab("deploy");
          }
        }}
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
        autoUpdateEnabled={autoUpdateEnabled}
        installing={appUpdate?.installing ?? false}
        error={appUpdate?.error ?? null}
        onDownload={handleDownloadAppUpdate}
        onAutoUpdateChange={handleAutoUpdateChange}
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
