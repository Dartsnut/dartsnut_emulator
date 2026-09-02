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
  Code2,
  Compass,
  Palette,
  Rocket,
  Sparkles,
  Terminal,
  Wand2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Settings,
  Square,
  SquarePen,
  Trash2,
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
  type ProjectRecord,
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
  type MainProcessConsoleMirrorPayload,
  type MachineMcpQuestionMachine,
  type AgentQuestionOption,
  type WidgetSize,
  type CommunitySessionInfo,
  type CommunityLlmQuotaStatus,
  type CommunitySubmitProgress,
  type ChatMediaAttachment,
  type WidgetConfigScope,
  type WidgetConfigSnapshot,
  type WidgetFieldDefinition,
  type WidgetFieldValues,
  createDefaultWidgetFieldValues,
  inferChatMediaAttachmentKind,
  mergeChatMediaAttachments,
  reconcileWidgetFieldValues,
  AGENT_PROFILES,
  type AgentProfileId,
  type AgentProfileDefinition,
  type AgentProfileGroup
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
import { shouldSetInitialChatTitle } from "./chatTitlePolicy";
import { normalizeWidgetConfigSnapshot } from "./widgetParams";
import { readyAgentProfileId, useChatPersonaController } from "./useChatPersonaController";
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
import { WindowControls } from "./WindowControls";
import {
  chatPaneRatioFromWidth,
  chatPaneWidthFromRatio,
  clampWorkspaceMenuWidth,
  getStoredChatPaneWidth,
  getStoredChatPaneRatio,
  getStoredWorkspaceMenuWidth,
  getStoredWorkspaceMenuCollapsed,
  MAX_WORKSPACE_MENU_WIDTH,
  MIN_CHAT_PANE_WIDTH,
  MIN_EMULATOR_PANE_WIDTH,
  MIN_WORKSPACE_MENU_WIDTH,
  nextWorkspaceMenuWidthFromDrag,
  setStoredChatPaneRatio,
  setStoredWorkspaceMenuWidth,
  setStoredWorkspaceMenuCollapsed
} from "./splitPaneSizing";

const AgentMarkdownRenderer = lazy(() => import("./AgentMarkdownRenderer"));

const AGENT_PROFILE_ICONS: Record<AgentProfileDefinition["icon"], typeof Sparkles> = {
  sparkle: Sparkles,
  palette: Palette,
  code: Code2,
  compass: Compass,
  wand: Wand2,
  rocket: Rocket,
  terminal: Terminal
};

type PersonaAgeGroup = Exclude<AgentProfileGroup, "export">;
const PERSONA_AGE_GROUPS: readonly { id: PersonaAgeGroup; label: string }[] = [
  { id: "child", label: "Kids" },
  { id: "teen", label: "Teens" },
  { id: "adult", label: "Adults" }
];

const PERSONA_CARD_SUMMARIES: Record<Exclude<AgentProfileId, "export">, string> = {
  "child-curious": "Warm guidance for everyday ideas you can build.",
  "child-creator": "Playful experiments with bright launch energy.",
  "teen-builder": "Expressive projects with clear technical thinking.",
  "teen-explorer": "Fast exploration across tools and tradeoffs.",
  "adult-vibe": "Personal taste meets useful technology.",
  "adult-shipper": "Focused execution from concept to launch."
};

function isValidMachineHost(value: string): boolean {
  const trimmed = value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return Boolean(trimmed) && !/[/?#\s]/.test(trimmed);
}

function machineOptionLabel(machine: MachineMcpQuestionMachine): string {
  const name = machine.name || machine.deviceId;
  const details = [machine.ipAddress, machine.ssid].filter(Boolean).join(" · ");
  return details ? `${name}  ${details}` : name;
}

type DeployPaneTab = "deploy" | "games" | "assets";
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

type RemoveProjectDialogProps = {
  project: ProjectRecord;
  removing: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function RemoveProjectDialog({
  project,
  removing,
  error,
  onCancel,
  onConfirm
}: RemoveProjectDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButtonRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!removing) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="remove-project-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-project-title"
      aria-describedby="remove-project-description"
      onMouseDown={(event) => {
        if (!removing && event.target === event.currentTarget) onCancel();
      }}
    >
      <div ref={panelRef} className="remove-project-dialog" onKeyDown={handleKeyDown}>
        <div className="remove-project-dialog__header">
          <h2 id="remove-project-title">Remove {project.name}?</h2>
          <button
            type="button"
            className="remove-project-dialog__close"
            aria-label="Close"
            disabled={removing}
            onClick={onCancel}
          >
            <X size={22} aria-hidden />
          </button>
        </div>
        <p id="remove-project-description" className="remove-project-dialog__description">
          This removes the local project and all of its chats from Dartsnut Agent. Files on your computer won't be deleted.
        </p>
        {error ? <p className="remove-project-dialog__error" role="alert">{error}</p> : null}
        <div className="remove-project-dialog__actions">
          <button
            ref={cancelButtonRef}
            type="button"
            className="remove-project-dialog__cancel"
            disabled={removing}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="remove-project-dialog__confirm"
            disabled={removing}
            onClick={onConfirm}
          >
            {removing ? "Removing…" : "Remove local project"}
          </button>
        </div>
      </div>
    </div>
  );
}

type TimelineEntryViewProps = {
  entry: TimelineEntry;
  onToggleReasoning: (entryId: string) => void;
  agentProfile: AgentProfileDefinition | null;
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
  onToggleReasoning,
  agentProfile
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
        <div className={cn("greeting-card", agentProfile && `greeting-card--${agentProfile.group}`)} role="status">
          <p className="greeting-card__eyebrow">
            {agentProfile?.group === "export" ? "Life/Tech · ready" : `${agentProfile?.group ?? "agent"} studio · ready`}
          </p>
          <p className="greeting-card__title">{agentProfile?.name ?? "Dartsnut Agent"}</p>
          <p className="greeting-card__body">{agentProfile?.greeting ?? entry.text}</p>
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

type FunctionCallPreview = {
  callId: string;
  toolName: string;
  argumentsJson: string;
  path?: string;
};

function summarizeFileToolCallDelta(event: FunctionCallPreview): string {
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
  const [removeProjectTarget, setRemoveProjectTarget] = useState<ProjectRecord | null>(null);
  const [removingProject, setRemovingProject] = useState(false);
  const [removeProjectError, setRemoveProjectError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([
    { id: "greeting-initial", role: "agent", text: GREETING_TEXT }
  ]);
  const [prompt, setPrompt] = useState("");
  const [personaAgeGroup, setPersonaAgeGroup] = useState<PersonaAgeGroup>("adult");
  const [chatMediaAttachments, setChatMediaAttachments] = useState<ChatMediaAttachment[]>([]);
  const [chatAttachmentError, setChatAttachmentError] = useState<string | null>(null);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
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
  const [machineMcpPicker, setMachineMcpPicker] = useState<{
    visible: boolean;
    machines: MachineMcpQuestionMachine[];
    manualOnly: boolean;
  }>({ visible: false, machines: [], manualOnly: true });
  const [machineMcpManualIp, setMachineMcpManualIp] = useState("");
  const [machineMcpInputError, setMachineMcpInputError] = useState<string | null>(null);
  const [agentQuestion, setAgentQuestion] = useState<{
    questionId: string;
    question: string;
    options: AgentQuestionOption[];
    allowFreeText: boolean;
    freeTextPlaceholder: string;
  } | null>(null);
  const [agentQuestionText, setAgentQuestionText] = useState("");
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const eventSeqRef = useRef(0);
  const activeStreamEntryIdRef = useRef<string | null>(null);
  const activeStreamDeltaRef = useRef("");
  const activeReasoningStreamEntryIdRef = useRef<string | null>(null);
  const activeReasoningIdRef = useRef<string | null>(null);
  const activeReasoningStreamDeltaRef = useRef("");
  const activeReasoningStartedAtRef = useRef<number | null>(null);
  const sdkFunctionCallsRef = useRef(new Map<string, FunctionCallPreview>());
  const activeToolStatusEntryByKeyRef = useRef<Map<string, string>>(new Map());
  const seenAgentToolAnalyticsRef = useRef<Set<string>>(new Set());
  const activeAgentRunRef = useRef<{ startedAt: number; finished: boolean } | null>(null);
  /** After session reset / new project, discard agent stream events until the next user send. */
  const discardAgentEventsRef = useRef(false);
  const timelineRef = useRef<HTMLElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const personaController = useChatPersonaController();
  const personaState = personaController.state;
  const [composerExpandedSticky, setComposerExpandedSticky] = useState(false);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(() => getAnalyticsCollectionEnabled());
  const [providerSettingsError, setProviderSettingsError] = useState<string | null>(null);
  const [providerSettingsNotice, setProviderSettingsNotice] = useState<string | null>(null);
  const [savingProviderSettings, setSavingProviderSettings] = useState(false);
  const [assetManifest, setAssetManifest] = useState<AssetManifest | null>(null);
  const [pendingChangeSlotIds, setPendingChangeSlotIds] = useState<string[]>([]);
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
  const chatDisabled = useMemo(() => {
    if (!bootstrap) {
      return true;
    }
    return sending || Boolean(agentQuestion) || machineMcpPicker.visible;
  }, [agentQuestion, bootstrap, machineMcpPicker.visible, sending]);

  // Tauri native drag/drop provides filesystem paths; browser DataTransfer
  // intentionally hides them. Handle drops over composer directly so media
  // attachments keep working after Electron removal.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (disposed || event.payload.type !== "drop" || chatDisabled || event.payload.paths.length === 0) {
          return;
        }
        const scale = window.devicePixelRatio || 1;
        const target = document.elementFromPoint(
          event.payload.position.x / scale,
          event.payload.position.y / scale
        );
        if (!target?.closest(".ui-composer")) {
          return;
        }
        const accepted: ChatMediaAttachment[] = [];
        for (const filePath of event.payload.paths) {
          const name = filePath.split(/[\\/]/).pop() || "media file";
          const kind = inferChatMediaAttachmentKind("", name);
          if (!kind) continue;
          accepted.push({
            id: createChatMediaAttachmentId(),
            path: filePath,
            name,
            mimeType: "application/octet-stream",
            kind,
            size: 0
          });
        }
        if (accepted.length > 0) {
          setChatMediaAttachments((previous) => mergeChatMediaAttachments(previous, accepted));
          setChatAttachmentError(null);
        } else {
          setChatAttachmentError("Drop image, audio, or video files from your computer.");
        }
      }))
      .then((stop) => {
        if (disposed) {
          try { void Promise.resolve(stop()).catch(() => undefined); } catch { /* already removed */ }
          return;
        }
        unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      if (disposed) return;
      disposed = true;
      const stop = unlisten;
      unlisten = undefined;
      try { void Promise.resolve(stop?.()).catch(() => undefined); } catch { /* already removed */ }
    };
  }, [chatDisabled]);
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
  const [legacyChatPaneWidth] = useState(getStoredChatPaneWidth);
  const [chatPaneRatio, setChatPaneRatio] = useState<number | null>(getStoredChatPaneRatio);
  const [mainWorkspacePanelWidth, setMainWorkspacePanelWidth] = useState(0);
  const [chatPaneResizing, setChatPaneResizing] = useState(false);
  const [workspaceMenuWidth, setWorkspaceMenuWidth] = useState(getStoredWorkspaceMenuWidth);
  const [workspaceMenuCollapsed, setWorkspaceMenuCollapsed] = useState(getStoredWorkspaceMenuCollapsed);
  const [workspaceMenuResizing, setWorkspaceMenuResizing] = useState(false);
  const chatPaneResizeDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startWidth: number;
    panelWidth: number;
  } | null>(null);
  const workspaceMenuResizeDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startWidth: number;
  } | null>(null);
  const mainWorkspaceBodyRef = useRef<HTMLDivElement | null>(null);
  const projectsSectionButtonRef = useRef<HTMLButtonElement | null>(null);

  const composerHasContent = prompt.trim().length > 0 || chatMediaAttachments.length > 0;
  const personaPickerOpen = personaState.phase === "picking";
  const agentProfileId = readyAgentProfileId(personaState, bootstrap?.activeChatId);
  const agentProfile = AGENT_PROFILES.find((profile) => profile.id === agentProfileId) ?? null;
  const agentProfileReady = bootstrap !== null && agentProfileId !== null;
  const visiblePersonaProfiles = AGENT_PROFILES.filter(
    (profile) => profile.group === personaAgeGroup
  );
  const exportProfile = AGENT_PROFILES.find((profile) => profile.id === "export")!;

  const api = window.dartsnutApi;

  useEffect(() => {
    if (bootstrap) personaController.syncBootstrap(bootstrap);
  }, [bootstrap, personaController.syncBootstrap]);

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

  const mainGridTemplateColumns = useMemo(() => {
    const menuColumn = `${workspaceMenuCollapsed ? 0 : workspaceMenuWidth}px`;
    return `${menuColumn} minmax(0,1fr)`;
  }, [workspaceMenuCollapsed, workspaceMenuWidth]);

  const paneLayoutWidth = mainWorkspacePanelWidth > 0
    ? mainWorkspacePanelWidth
    : legacyChatPaneWidth + MIN_EMULATOR_PANE_WIDTH;
  const preferredChatPaneRatio = chatPaneRatio
    ?? chatPaneRatioFromWidth(legacyChatPaneWidth, paneLayoutWidth);
  const chatPaneWidth = chatPaneWidthFromRatio(preferredChatPaneRatio, paneLayoutWidth);

  const mainWorkspaceGridTemplateColumns = useMemo(() => {
    if (!showEmulatorPane) {
      return "minmax(0,1fr)";
    }
    return `${chatPaneWidth}px minmax(${MIN_EMULATOR_PANE_WIDTH}px,1fr)`;
  }, [chatPaneWidth, showEmulatorPane]);

  const mainGridStyle = useMemo(
    () => ({
      "--app-main-grid-cols": mainGridTemplateColumns,
      "--main-workspace-grid-cols": mainWorkspaceGridTemplateColumns,
      "--workspace-menu-rendered-width": `${workspaceMenuCollapsed ? 0 : workspaceMenuWidth}px`
    }) as CSSProperties,
    [mainGridTemplateColumns, mainWorkspaceGridTemplateColumns, workspaceMenuCollapsed, workspaceMenuWidth]
  );
  const chatPaneResizeMax = Math.max(MIN_CHAT_PANE_WIDTH, paneLayoutWidth - MIN_EMULATOR_PANE_WIDTH);
  const workspaceMenuResizeMax = MAX_WORKSPACE_MENU_WIDTH;

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
      startWidth: chatPaneWidth,
      panelWidth: paneLayoutWidth
    };
    setChatPaneResizing(true);
    event.preventDefault();
  }, [chatPaneWidth, paneLayoutWidth]);

  const handleChatPaneResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const activeDrag = chatPaneResizeDragRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
      return;
    }
    const targetWidth = activeDrag.startWidth + event.clientX - activeDrag.startClientX;
    const ratio = chatPaneRatioFromWidth(targetWidth, activeDrag.panelWidth);
    setChatPaneRatio(ratio);
  }, []);

  const handleChatPaneResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (chatPaneResizeDragRef.current?.pointerId === event.pointerId) {
      finishChatPaneResize(event.currentTarget);
    }
  }, [finishChatPaneResize]);

  const handleChatPaneResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 80 : 24;
    const panelWidth = paneLayoutWidth;
    const resizeTo = (targetWidth: number) => {
      setChatPaneRatio(chatPaneRatioFromWidth(targetWidth, panelWidth));
    };
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeTo(chatPaneWidth - step);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeTo(chatPaneWidth + step);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      resizeTo(MIN_CHAT_PANE_WIDTH);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      resizeTo(panelWidth - MIN_EMULATOR_PANE_WIDTH);
    }
  }, [chatPaneWidth, paneLayoutWidth]);

  const finishWorkspaceMenuResize = useCallback((target?: Element) => {
    const activeDrag = workspaceMenuResizeDragRef.current;
    if (activeDrag && target instanceof HTMLElement && target.hasPointerCapture(activeDrag.pointerId)) {
      target.releasePointerCapture(activeDrag.pointerId);
    }
    workspaceMenuResizeDragRef.current = null;
    setWorkspaceMenuResizing(false);
  }, []);

  const handleWorkspaceMenuResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceMenuResizeDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: workspaceMenuWidth
    };
    setWorkspaceMenuResizing(true);
    event.preventDefault();
  }, [workspaceMenuWidth]);

  const handleWorkspaceMenuResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const activeDrag = workspaceMenuResizeDragRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    setWorkspaceMenuWidth(nextWorkspaceMenuWidthFromDrag({
      startClientX: activeDrag.startClientX,
      currentClientX: event.clientX,
      startWidth: activeDrag.startWidth
    }));
  }, []);

  const handleWorkspaceMenuResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (workspaceMenuResizeDragRef.current?.pointerId === event.pointerId) {
      finishWorkspaceMenuResize(event.currentTarget);
    }
  }, [finishWorkspaceMenuResize]);

  const handleWorkspaceMenuResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16;
    const resizeTo = (targetMenuWidth: number) => setWorkspaceMenuWidth(clampWorkspaceMenuWidth(targetMenuWidth));
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeTo(workspaceMenuWidth - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeTo(workspaceMenuWidth + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      resizeTo(MIN_WORKSPACE_MENU_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      resizeTo(workspaceMenuResizeMax);
    }
  }, [workspaceMenuResizeMax, workspaceMenuWidth]);

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
    const activePanel = deployDrawerOpen
      ? deployPaneTab === "games" ? "community" : deployPaneTab
      : "emulator";
    setAnalyticsViewContext(screen, screen === "settings" ? null : activePanel);
  }, [deployDrawerOpen, deployPaneTab, screen]);

  useEffect(() => {
    if (screen !== "main") {
      return;
    }
    trackPanelView("emulator", "right_pane");
  }, [screen]);

  useEffect(() => {
    if (screen !== "main" || !deployEligible || !deployDrawerOpen) {
      return;
    }
    trackPanelView(deployPaneTab === "games" ? "community" : deployPaneTab, "deploy_pane");
  }, [deployDrawerOpen, deployEligible, deployPaneTab, screen]);


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
      { id: `evt-${seq}-${"at" in event ? event.at : Date.now()}`, role, text: formatAgentEventForTimeline(event) }
    ]);
  }

  function appendOrPatchReasoningStream(event: { reasoningId: string; delta: string; at: number }): void {
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

  function appendOrPatchStream(event: { delta: string; at: number }): void {
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

  useLayoutEffect(() => {
    if (!mainWorkspaceBodyRef.current || typeof ResizeObserver === "undefined") {
      return;
    }
    const body = mainWorkspaceBodyRef.current;
    const syncPanelWidth = () => {
      const panelWidth = body.clientWidth;
      if (panelWidth > 0) {
        setMainWorkspacePanelWidth(panelWidth);
      }
    };
    const observer = new ResizeObserver(syncPanelWidth);
    observer.observe(body);
    syncPanelWidth();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (chatPaneRatio === null && mainWorkspacePanelWidth > 0) {
      setChatPaneRatio(chatPaneRatioFromWidth(legacyChatPaneWidth, mainWorkspacePanelWidth));
    }
  }, [chatPaneRatio, legacyChatPaneWidth, mainWorkspacePanelWidth]);

  useEffect(() => {
    const onResize = () => {
      syncComposerPromptHeight();
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    if (chatPaneRatio !== null) {
      setStoredChatPaneRatio(chatPaneRatio);
    }
  }, [chatPaneRatio]);

  useEffect(() => {
    setStoredWorkspaceMenuWidth(workspaceMenuWidth);
  }, [workspaceMenuWidth]);

  useEffect(() => {
    setStoredWorkspaceMenuCollapsed(workspaceMenuCollapsed);
  }, [workspaceMenuCollapsed]);

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
      if (event.type === "machine_mcp_prompt") {
        if (event.visible) {
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
      if (event.type === "agent_question") {
        if (!event.visible) {
          setAgentQuestion(null);
          setAgentQuestionText("");
        } else {
          setAgentQuestion({
            questionId: event.questionId,
            question: event.question,
            options: event.options ?? [],
            allowFreeText: event.allowFreeText === true,
            freeTextPlaceholder: event.freeTextPlaceholder ?? "Type your own answer"
          });
          setAgentQuestionText("");
        }
        return;
      }
      if (event.type === "token_usage") {
        setTokenUsage(event.sessionUsage);
        return;
      }
      if (event.type === "raw_model_stream_event") {
        const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : null;
        const responseEvent = data?.type === "model" && data.event && typeof data.event === "object"
          ? data.event as Record<string, unknown>
          : null;
        if (!responseEvent) return;
        const responseType = typeof responseEvent?.type === "string" ? responseEvent.type : "";
        if (responseType === "response.output_text.delta" && typeof responseEvent?.delta === "string") {
          appendOrPatchStream({ delta: responseEvent.delta, at: Date.now() });
          return;
        }
        if (
          (responseType === "response.reasoning_text.delta" || responseType === "response.reasoning_summary_text.delta") &&
          typeof responseEvent?.delta === "string"
        ) {
          const itemId = typeof responseEvent.item_id === "string" ? responseEvent.item_id : "reasoning";
          appendOrPatchReasoningStream({ reasoningId: itemId, delta: responseEvent.delta, at: Date.now() });
          return;
        }
        if (responseType === "response.reasoning_text.done" || responseType === "response.reasoning_summary_text.done") {
          const activeId = activeReasoningStreamEntryIdRef.current;
          const startedAt = activeReasoningStartedAtRef.current;
          if (activeId && startedAt != null) {
            const elapsed = formatReasoningElapsedSeconds(startedAt, Date.now());
            setEntries((prev) => prev.map((entry) =>
              entry.id === activeId ? { ...entry, text: `Thought for ${elapsed} s`, reasoningMode: "summary" } : entry
            ));
          }
          activeReasoningStreamEntryIdRef.current = null;
          activeReasoningIdRef.current = null;
          activeReasoningStreamDeltaRef.current = "";
          activeReasoningStartedAtRef.current = null;
          return;
        }
        if (responseType === "response.output_item.added") {
          const item = responseEvent.item && typeof responseEvent.item === "object"
            ? responseEvent.item as Record<string, unknown>
            : null;
          if (item?.type === "function_call") {
            const itemId = typeof item.id === "string" ? item.id : String(item.call_id ?? "");
            sdkFunctionCallsRef.current.set(itemId, {
              callId: String(item.call_id ?? itemId),
              toolName: String(item.name ?? "tool"),
              argumentsJson: typeof item.arguments === "string" ? item.arguments : ""
            });
          }
          return;
        }
        if (responseType === "response.function_call_arguments.delta" || responseType === "response.function_call_arguments.done") {
          const itemId = String(responseEvent.item_id ?? "");
          const current = sdkFunctionCallsRef.current.get(itemId);
          if (!current) return;
          current.argumentsJson = responseType.endsWith(".done") && typeof responseEvent.arguments === "string"
            ? responseEvent.arguments
            : current.argumentsJson + (typeof responseEvent.delta === "string" ? responseEvent.delta : "");
          const path = extractPartialStringField(current.argumentsJson, "path");
          if (path) current.path = path;
          if (current.toolName !== "write_file" && current.toolName !== "replace_in_file") return;
          clearActiveCoalescedStreamEntries();
          const key = toolStatusKey({ callId: current.callId, toolName: current.toolName, filePath: current.path });
          if (!key) return;
          const priorId = activeToolStatusEntryByKeyRef.current.get(key);
          const text = summarizeFileToolCallDelta(current);
          if (priorId) {
            setEntries((prev) => prev.map((entry) =>
              entry.id === priorId
                ? {
                  ...entry,
                  role: "status",
                  text,
                  toolStatusMeta: {
                    callId: current.callId,
                    toolName: current.toolName,
                    phase: "call",
                    filePath: current.path
                  }
                }
                : entry
            ));
            return;
          }
          const seq = eventSeqRef.current;
          eventSeqRef.current += 1;
          const id = `evt-${seq}-${Date.now()}`;
          setEntries((prev) => [...prev, {
            id,
            role: "status",
            text,
            toolStatusMeta: {
              callId: current.callId,
              toolName: current.toolName,
              phase: "call",
              filePath: current.path
            }
          }]);
          activeToolStatusEntryByKeyRef.current.set(key, id);
          return;
        }
        return;
      }
      if (event.type === "agent_updated_stream_event") {
        return;
      }
      if (event.type === "run_item_stream_event") {
        const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : null;
        const raw = item?.rawItem && typeof item.rawItem === "object" ? item.rawItem as Record<string, unknown> : null;
        const toolName = typeof raw?.name === "string" ? raw.name : "tool";
        if (event.name === "tool_called") {
          trackAgentEvent("agent_tool_used", { tool_name: toolName, phase: "call" });
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
        const activeStreamId = activeStreamEntryIdRef.current;
        if (activeStreamId) {
          const finalText = event.content.trim();
          setEntries((prev) => prev.map((entry) =>
            entry.id === activeStreamId ? { ...entry, text: finalText } : entry
          ));
          activeStreamEntryIdRef.current = null;
          activeStreamDeltaRef.current = "";
          return;
        }
        const seq = eventSeqRef.current;
        eventSeqRef.current += 1;
        const id = `evt-${seq}-${event.at}`;
        setEntries((prev) => {
          const last = prev.length > 0 ? prev[prev.length - 1] : null;
          const finalText = event.content.trim();
          if (last && last.role === "agent") {
            const lastText = last.text.trim();
            // Streamed assistant text may be partial, while finalOutput contains
            // the complete response. Replace that entry instead of appending a
            // second, overlapping timeline item.
            if (
              lastText === finalText ||
              (lastText.length >= 24 && finalText.startsWith(lastText)) ||
              (finalText.length >= 24 && lastText.startsWith(finalText))
            ) {
              return prev.map((entry) => entry.id === last.id ? { ...entry, text: finalText } : entry);
            }
          }
          return [...prev, { id, role: "agent", text: event.content }];
        });
        return;
      }
      appendRawAgentEvent(event);
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
    const normalizedSnapshot = normalizeWidgetConfigSnapshot(snapshot);
    setWidgetConfigs((previous) => ({ ...previous, [normalizedSnapshot.scope]: normalizedSnapshot }));
    if (normalizedSnapshot.status !== "ready") {
      return;
    }
    setWidgetValuesByConfig((previous) => {
      const current = previous[normalizedSnapshot.configKey];
      return {
        ...previous,
        [normalizedSnapshot.configKey]: {
          fields: normalizedSnapshot.fields,
          values: current
            ? reconcileWidgetFieldValues(current.fields, current.values, normalizedSnapshot.fields)
            : createDefaultWidgetFieldValues(normalizedSnapshot.fields)
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

  useEffect(() => {
    setDeployDrawerOpen(false);
  }, [bootstrap?.activeProjectId]);

  useEffect(() => {
    if (
      !deployEligible ||
      (gamesTabDisabled && deployPaneTab === "games") ||
      (!assetManifest && deployPaneTab === "assets")
    ) {
      setDeployPaneTab("deploy");
    }
  }, [assetManifest, deployEligible, deployPaneTab, gamesTabDisabled]);

  useEffect(() => {
    const ws = bootstrap?.workspaceRoot;
    if (!api || !ws || personaState.phase !== "hydrating") return;
    const { chatId, generation } = personaState;
    let cancelled = false;
    void (async () => {
      try {
        const summary = await api.getWorkspaceSessionSummary(chatId);
        if (cancelled) return;
        if (summary.chatId !== chatId) {
          personaController.failHydration(chatId, generation);
          return;
        }
        setTokenUsage(summary.tokenUsage ?? null);
        if (!summary.hasPersistedSession || summary.transcriptTail.length === 0) {
          setEntries([{ id: "greeting-initial", role: "agent", text: GREETING_TEXT }]);
        } else {
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
        }
        personaController.completeHydration(chatId, generation, summary.agentProfileId);
      } catch {
        if (!cancelled) {
          setEntries([{ id: "greeting-initial", role: "agent", text: GREETING_TEXT }]);
          personaController.failHydration(chatId, generation);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    api,
    bootstrap?.workspaceRoot,
    personaController.completeHydration,
    personaController.failHydration,
    personaState
  ]);

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
    setSessionTemplateMode(null);
    setSessionWidgetSize(null);
    setSessionProjectType(null);
    setTokenUsage(null);
    setAgentQuestion(null);
    setAgentQuestionText("");
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
    discardAgentEventsRef.current = false;
    setSending(true);
    if (!api) {
      setSending(false);
      return;
    }
    seenAgentToolAnalyticsRef.current.clear();
    activeAgentRunRef.current = { startedAt: Date.now(), finished: false };
    const shouldGenerateTitle = shouldSetInitialChatTitle(
      firstUserMessageForTitle,
      request.chatId,
      activeChat
    );
    trackAgentEvent("agent_run_started", {
      provider: providerSettings.activeProvider,
      template_mode: request.templateMode ?? "follow_up",
      project_type: request.projectType ?? sessionProjectType ?? "unknown",
      workspace_kind: request.workspacePath ? "persisted" : "none",
      attachment_count: request.chatMediaAttachments?.length ?? 0
    });
    try {
      const result: SendPromptResponse = await api.sendPrompt(request);
      const refreshed = await api.getBootstrapState();
      setBootstrap(refreshed);
      if (!result.ok) {
        if (shouldGenerateTitle && refreshed.activeChatId && firstUserMessageForTitle) {
          try {
            const { tree } = await api.generateChatTitle({
              chatId: refreshed.activeChatId,
              firstUserMessage: firstUserMessageForTitle,
              fallbackOnly: true
            });
            setProjectTree(tree);
          } catch {
            // Prompt failure remains primary; title fallback is best effort.
          }
        }
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
      if (shouldGenerateTitle && refreshed.activeChatId && firstUserMessageForTitle) {
        void api.generateChatTitle({
          chatId: refreshed.activeChatId,
          firstUserMessage: firstUserMessageForTitle,
          fallbackOnly: false
        }).then(({ tree }) => setProjectTree(tree)).catch(() => undefined);
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

  async function handleNewChat() {
    if (!api || sending || projectSwitchProgress.active) return;
    await handleNoProject();
  }

  async function handleSelectAgentProfile(profileId: AgentProfileId) {
    if (!api || sending || personaState.phase !== "picking") return;
    const projectId = personaState.projectId;
    personaController.selectProfile(profileId);
    if (!projectId) {
      openCreateProjectDialog();
      return;
    }
    try {
      const result = await api.createChat({ projectId, agentProfileId: profileId });
      setBootstrap(result.state);
      setProjectTree(result.tree);
      resetChatSessionUi();
      if (!result.state.activeChatId) throw new Error("Created chat was not activated.");
      personaController.completeCreation(result.state.activeChatId, profileId);
    } catch {
      personaController.failCreation();
      postStatus("Could not start this chat. Try again.");
    }
  }

  function openCreateProjectDialog() {
    if (sending) return;
    setProjectMenuOpen(false);
    setCreateProjectName("");
    setCreateProjectFolder(null);
    setCreateProjectError(null);
    setCreateProjectOpen(true);
  }

  function handleCreateProject() {
    openCreateProjectDialog();
  }

  function closeCreateProjectDialog(keepPersona = false) {
    setCreateProjectOpen(false);
    if (!keepPersona && personaState.phase === "creating-project") {
      personaController.cancelProjectCreation();
    }
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
      const carriedAgentProfileId = personaState.phase === "creating-project"
        ? personaState.profileId
        : null;
      const result = await api.createProject({
        folderPath: createProjectFolder,
        name: createProjectName,
        agentProfileId: carriedAgentProfileId ?? undefined
      });
      closeCreateProjectDialog(true);
      setBootstrap(result.state);
      setProjectTree(result.tree);
      resetChatSessionUi();
      personaController.syncBootstrap(result.state);
      if (carriedAgentProfileId && result.state.activeChatId) {
        personaController.completeCreation(result.state.activeChatId, carriedAgentProfileId);
      }
    } catch (error: unknown) {
      setCreateProjectError(error instanceof Error ? error.message : "Could not create project.");
    }
  }

  async function handleSelectProject(projectId: string) {
    if (!api || sending || projectSwitchProgress.active) return;
    const result = await api.selectProject({ projectId });
    if (result.accepted) {
      setBootstrap(result.state);
      setProjectTree(result.tree);
      resetChatSessionUi();
      personaController.startNewChat(projectId);
    }
    setProjectMenuOpen(false);
  }

  function handleOpenRemoveProject(project: ProjectRecord) {
    if (sending || projectSwitchProgress.active) return;
    setRemoveProjectError(null);
    setRemoveProjectTarget(project);
  }

  function handleCloseRemoveProject() {
    if (removingProject) return;
    setRemoveProjectError(null);
    setRemoveProjectTarget(null);
  }

  async function handleConfirmRemoveProject() {
    if (!api || !removeProjectTarget || removingProject) return;
    const projectId = removeProjectTarget.id;
    const wasActive = bootstrap?.activeProjectId === projectId;
    setRemovingProject(true);
    setRemoveProjectError(null);
    try {
      const result = await api.removeProject(projectId);
      setBootstrap(result.state);
      setProjectTree(result.tree);
      setRemoveProjectTarget(null);
      if (wasActive) {
        resetChatSessionUi();
        personaController.startNewChat(null);
      }
      window.requestAnimationFrame(() => projectsSectionButtonRef.current?.focus());
    } catch (error: unknown) {
      setRemoveProjectError(error instanceof Error ? error.message : "Could not remove the local project.");
    } finally {
      setRemovingProject(false);
    }
  }

  async function handleNoProject() {
    if (!api || sending || projectSwitchProgress.active) return;
    const result = await api.selectProject({ projectId: null });
    if (result.accepted) {
      setBootstrap(result.state);
      setProjectTree(result.tree);
      resetChatSessionUi();
      personaController.startNewChat(null);
    }
    setProjectMenuOpen(false);
  }

  async function handleNewChatForProject(projectId: string) {
    await handleSelectProject(projectId);
  }

  async function handleSelectChat(chatId: string) {
    if (!api || sending) return;
    const result = await api.selectChat(chatId);
    if (!result.accepted) return;
    setBootstrap(result.state);
    setProjectTree(result.tree);
    resetChatSessionUi();
    personaController.syncBootstrap(result.state);
  }

  async function handleArchiveChat(chatId: string) {
    if (!api || sending || projectSwitchProgress.active) return;
    const wasActive = bootstrap?.activeChatId === chatId;
    const result = await api.archiveChat(chatId);
    setBootstrap(result.state); setProjectTree(result.tree);
    if (wasActive) {
      resetChatSessionUi();
      personaController.archiveActiveChat(result.state.activeProjectId);
    }
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

  async function handleAgentQuestionAnswer(value: string) {
    if (!api || !agentQuestion) return;
    const response = await api.agentQuestionSubmitAnswer({ questionId: agentQuestion.questionId, value });
    trackAgentEvent("agent_question_answered", {
      question_type: "agent",
      answer_method: agentQuestion.options.some((option) => option.value === value) ? "option" : "free_text",
      outcome: response.ok ? "success" : "rejected"
    });
    if (!response.ok) {
      postStatus(response.reason === "stale_question" ? "That question is no longer active." : "That answer could not be used.");
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
    if (
      personaState.phase !== "ready" ||
      personaState.chatId !== bootstrap?.activeChatId ||
      !composerHasContent ||
      chatDisabled
    ) {
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
      templateMode: sessionTemplateMode ?? undefined,
      widgetSize: sessionWidgetSize ?? undefined,
      projectType: sessionProjectType ?? undefined,
      agentProfileId: personaState.profileId
    }, visibleUserText);
  }

  async function handleStopAgent() {
    if (!api || !sending) {
      return;
    }
    clearActiveCoalescedStreamEntries();
    activeToolStatusEntryByKeyRef.current.clear();
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
        (chatPaneResizing || workspaceMenuResizing) && "app-shell--column-resizing"
      )}
      style={mainGridStyle}
      aria-busy={submissionLock.active}
    >
      <div className="app-titlebar" data-tauri-drag-region>
        <WindowControls />
      </div>
      <header
        className="workspace-header flex min-h-10 items-center gap-2 [app-region:drag] [-webkit-app-region:drag]"
        data-tauri-drag-region
        style={{
          paddingLeft: "calc(6px + var(--chrome-margin-inline-start))",
          paddingTop: "5px",
          paddingBottom: "5px"
        }}
        role="banner"
      >
        <button
          type="button"
          className="header-menu-toggle max-[1100px]:hidden"
          aria-label={workspaceMenuCollapsed ? "Show side menu" : "Hide side menu"}
          aria-expanded={!workspaceMenuCollapsed}
          title={workspaceMenuCollapsed ? "Show side menu" : "Hide side menu"}
          onClick={() => setWorkspaceMenuCollapsed((collapsed) => !collapsed)}
        >
          {workspaceMenuCollapsed ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}
        </button>
        {workspaceMenuCollapsed ? <span className="header-menu-toggle-divider" aria-hidden /> : null}
      </header>
      <aside className={cn("workspace-menu col-start-1 row-start-2", workspaceMenuCollapsed && "workspace-menu--hidden", screen === "settings" && "workspace-menu--settings")} aria-label={screen === "settings" ? "Settings menu" : "Workspace menu"}>
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
            ref={projectsSectionButtonRef}
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
                <button
                  type="button"
                  className="workspace-menu__project-remove"
                  onClick={(event) => { event.stopPropagation(); handleOpenRemoveProject(project); }}
                  disabled={sending || projectSwitchProgress.active}
                  aria-label={`Remove local project ${project.name}`}
                  title="Remove local project"
                  data-analytics-id="project_remove_local"
                  data-analytics-area="project"
                >
                  <Trash2 size={14} aria-hidden />
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
        <div
          className={cn("workspace-menu-splitter", workspaceMenuResizing && "workspace-menu-splitter--active")}
          role="separator"
          tabIndex={0}
          aria-label="Resize side menu"
          aria-orientation="vertical"
          aria-valuemin={MIN_WORKSPACE_MENU_WIDTH}
          aria-valuemax={workspaceMenuResizeMax}
          aria-valuenow={workspaceMenuWidth}
          title="Drag to resize side menu"
          onPointerDown={handleWorkspaceMenuResizePointerDown}
          onPointerMove={handleWorkspaceMenuResizePointerMove}
          onPointerUp={handleWorkspaceMenuResizePointerUp}
          onPointerCancel={handleWorkspaceMenuResizePointerUp}
          onKeyDown={handleWorkspaceMenuResizeKeyDown}
        />
      </aside>
      <section className="main-workspace-panel col-start-2 col-end-3 row-start-2 min-h-0 min-w-0">
        <div className="main-workspace-panel__chrome">
          <div className="main-workspace-panel__drag-region" data-tauri-drag-region aria-hidden />
          <div className="main-workspace-panel__controls">
            <UpdateDownloadPill status={appUpdate} />
            {screen === "main" && showDeployDrawer ? (
              <button
                type="button"
                className="header-deploy-toggle"
                aria-label={deployDrawerOpen ? "Collapse Deploy and Community panel" : "Open Deploy and Community panel"}
                aria-expanded={deployDrawerOpen}
                title={deployDrawerOpen ? "Collapse right panel" : "Open right panel"}
                onClick={() => setDeployDrawerOpen((open) => !open)}
              >
                {deployDrawerOpen ? <PanelRightClose size={18} aria-hidden /> : <PanelRightOpen size={18} aria-hidden />}
              </button>
            ) : null}
          </div>
        </div>
        <div className="main-workspace-panel__body" ref={mainWorkspaceBodyRef}>
      {screen === "main" && showRuntimeSetup ? (
        <section
          className="runtime-config-main col-span-full min-h-0 h-full overflow-auto bg-[var(--gradient-rail)]"
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
                <div className="runtime-setup-panel__error">
                  <div>{pythonRuntimeProgress.error}</div>
                  <button
                    type="button"
                    className="mt-3 rounded-md border border-current px-3 py-1.5 font-medium"
                    onClick={() => void api?.retryPythonRuntimeSetup()}
                  >
                    Retry runtime setup
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : screen === "main" ? (
        <section
          className={cn(
            "left-rail left-rail--chat col-start-1 relative min-w-0 min-h-0 h-full overflow-hidden border-r border-edge bg-[var(--gradient-rail)]",
            "max-[1100px]:max-w-[760px]"
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
            {personaPickerOpen ? (
              <section className="agent-profile-picker" aria-labelledby="agent-profile-picker-title">
                <div className="agent-profile-picker__intro">
                  <h1 id="agent-profile-picker-title">
                    Who should help you build {
                      projectTree.projects.find((project) => project.id === personaState.projectId)?.name ?? "your project"
                    }?
                  </h1>
                  <p>Choose a pace and personality.</p>
                </div>
                <div className="agent-profile-stage">
                  <div className="agent-profile-age-tabs" role="tablist" aria-label="Builder age group">
                    {PERSONA_AGE_GROUPS.map((group) => (
                      <button
                        key={group.id}
                        type="button"
                        role="tab"
                        aria-selected={personaAgeGroup === group.id}
                        className={cn("agent-profile-age-tab", personaAgeGroup === group.id && "agent-profile-age-tab--active")}
                        onClick={() => setPersonaAgeGroup(group.id)}
                      >
                        {group.label}
                      </button>
                    ))}
                  </div>
                  <div className="agent-profile-grid">
                  {visiblePersonaProfiles.map((profile) => {
                    const Icon = AGENT_PROFILE_ICONS[profile.icon];
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        className={`agent-profile-card agent-profile-card--${profile.group}`}
                        onClick={() => void handleSelectAgentProfile(profile.id)}
                        disabled={sending}
                        aria-label={`${profile.name}: ${profile.description}`}
                      >
                        <span className="agent-profile-card__icon"><Icon size={22} aria-hidden /></span>
                        <span className="agent-profile-card__content">
                          <span className="agent-profile-card__identity">
                            <span className="agent-profile-card__name">{profile.name}</span>
                          </span>
                          <span className="agent-profile-card__description">
                            {PERSONA_CARD_SUMMARIES[profile.id as Exclude<AgentProfileId, "export">]}
                          </span>
                        </span>
                        <ChevronDown className="agent-profile-card__select" size={18} aria-hidden />
                      </button>
                    );
                  })}
                  </div>
                  <button
                    type="button"
                    className="agent-profile-standard"
                    onClick={() => void handleSelectAgentProfile(exportProfile.id)}
                    disabled={sending}
                  >
                    <Terminal size={15} aria-hidden />
                    <span>Use standard Dartsnut Agent</span>
                  </button>
                </div>
              </section>
            ) : agentProfileReady ? entries.map((entry) => (
              <TimelineEntryView
                key={entry.id}
                entry={entry}
                onToggleReasoning={toggleReasoningEntry}
                agentProfile={agentProfile}
              />
            )) : null}
            </div>
          </section>

          {activeChat ? <div className="chat-panel-chat-header" title={activeChat.title}>
            <FolderOpen size={15} aria-hidden />
            <span>{activeChat.title}</span>
          </div> : null}

          {runtimeError ? (
            <div className="chat-rail-overlay chat-rail-overlay--top pointer-events-none absolute inset-x-0 top-0 z-10">
              <div className="pointer-events-auto flex min-w-0 flex-col gap-2">
                <div
                  className="m-0 rounded-lg border border-[var(--color-runtime-error-border)] bg-[var(--color-runtime-error-bg)] p-2 text-xs"
                  role="status"
                >
                  {runtimeError}
                </div>
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
          {agentQuestion ? (
            <AskQuestionCard
              question={agentQuestion.question}
              options={agentQuestion.options}
              input={agentQuestion.allowFreeText ? {
                value: agentQuestionText,
                placeholder: agentQuestion.freeTextPlaceholder,
                onChange: setAgentQuestionText
              } : undefined}
              onSubmit={(value) => void handleAgentQuestionAnswer(value)}
            />
          ) : null}
          {machineMcpPicker.visible ? (
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

          {agentProfileReady ? <section className="flex flex-col gap-3 border-0 bg-transparent p-0">
            {agentProfile ? <div className="agent-profile-context" aria-label={`Current helper: ${agentProfile.name}`}>
              <span className={`agent-profile-context__dot agent-profile-context__dot--${agentProfile.group}`} />
              <span>{agentProfile.name}</span>
            </div> : null}
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
          </section> : null}
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
        <section className="settings-page col-span-full min-h-0 overflow-auto">
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
          "right-pane col-start-2 flex min-h-0 h-full min-w-[360px] flex-1 flex-col overflow-hidden border-l border-edge bg-[var(--color-emulator-bg)]",
          showRuntimeSetup ? "hidden" : "max-[1100px]:hidden"
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col">
              <EmulatorPanel
                workspacePath={bootstrap?.workspaceRoot ?? ""}
                widgetConfig={widgetConfigs.emulator}
                widgetValuesByConfig={widgetValuesByConfig}
                onWidgetValuesChange={updateWidgetValues}
              />
            </div>
        </div>
      </aside> : null}
        </div>
      {showDeployDrawer ? (
        <div
          className={cn(
            "deploy-drawer-viewport",
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
            {assetManifest ? (
              <button
                type="button"
                className={cn("ui-tab", deployPaneTab === "assets" && "ui-tab--active")}
                role="tab"
                aria-selected={deployPaneTab === "assets"}
                onClick={() => setDeployPaneTab("assets")}
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
          <div className="flex min-h-0 flex-1 flex-col">
            <div className={cn("flex min-h-0 flex-1 flex-col", deployPaneTab !== "deploy" && "hidden")}>
              <DeployPanel
                active={deployDrawerOpen && deployPaneTab === "deploy"}
                workspaceIdentity={bootstrap?.workspaceRoot ?? null}
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
            {assetManifest && bootstrap?.workspaceRoot ? (
              <div className={cn("flex min-h-0 flex-1 flex-col", deployPaneTab !== "assets" && "hidden")}>
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
        </div>
      ) : null}
      </section>
      {providerSettingsError || providerSettingsNotice ? (
        <div className="global-toast-stack" aria-live="polite">
          {providerSettingsError ? <div className="global-toast global-toast--error" role="alert">{providerSettingsError}</div> : null}
          {providerSettingsNotice ? <div className="global-toast global-toast--success" role="status">{providerSettingsNotice}</div> : null}
        </div>
      ) : null}
      {projectSwitchProgress.active ? <div className="project-switch-overlay" role="status" aria-live="polite"><div><h2>Switching project</h2><p>{projectSwitchProgress.message ?? "Preparing…"}</p></div></div> : null}
      {removeProjectTarget ? (
        <RemoveProjectDialog
          project={removeProjectTarget}
          removing={removingProject}
          error={removeProjectError}
          onCancel={handleCloseRemoveProject}
          onConfirm={() => void handleConfirmRemoveProject()}
        />
      ) : null}
      {createProjectOpen ? (
        <div
          className="create-project-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-project-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCreateProjectDialog();
          }}
        >
          <div className="create-project-popover">
            <div className="create-project-popover__header">
              <h2 id="create-project-title">Create project</h2>
              <button type="button" className="create-project-popover__close" aria-label="Close" onClick={() => closeCreateProjectDialog()}><X size={22} aria-hidden /></button>
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
              <button type="button" className="create-project-popover__cancel" onClick={() => closeCreateProjectDialog()}>Cancel</button>
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
