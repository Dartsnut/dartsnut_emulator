import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type AgentEvent,
  type AssetManifest,
  type BootstrapState,
  type DeployEligibility,
  type ManifestSnapshot,
  type LlmProviderId,
  type ProviderSettings,
  type ProjectType,
  type UserDefineProviderSettings,
  type PromptRequest,
  type SendPromptResponse,
  type SaveTempWorkspaceResponse,
  type MainProcessConsoleMirrorPayload,
  type WidgetSize
} from "@dartsnut/shared-ipc";
import { AssetManagerPanel } from "./AssetManagerPanel";
import { cn } from "./cn";
import { devLog, isDevLoggingEnabled } from "./devOnlyLog";
import { DeployPanel } from "./DeployPanel";
import { EmulatorPanel } from "./EmulatorPanel";
import {
  agentEventTimelineRole,
  formatAgentEventForTimeline,
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

type RightPaneTab = "emulator" | "assets" | "deploy";

type AppScreen = "main" | "settings";

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

const LLM_PROVIDER_OPTIONS: { id: LlmProviderId; label: string }[] = [
  { id: "gpt", label: "GPT 5.5" },
  { id: "gemini", label: "Gemini 3 Flash" },
  { id: "xiaomi", label: "Mimo V2.5 Pro" },
  { id: "user-define", label: "User define" }
];

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
  const [screen, setScreen] = useState<AppScreen>("main");
  /** Preserves widget/game creator routing for follow-up prompts after the first send. */
  const [sessionTemplateMode, setSessionTemplateMode] = useState<
    "game-creator" | "widget-creator" | null
  >(null);
  const [sessionWidgetSize, setSessionWidgetSize] = useState<WidgetSize | null>(null);
  const [sessionProjectType, setSessionProjectType] = useState<ProjectType | null>(null);
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
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const eventSeqRef = useRef(0);
  const activeStreamEntryIdRef = useRef<string | null>(null);
  const activeStreamDeltaRef = useRef("");
  const activeReasoningStreamEntryIdRef = useRef<string | null>(null);
  const activeReasoningStreamDeltaRef = useRef("");
  const activeReasoningStartedAtRef = useRef<number | null>(null);
  /** After session reset / new project, discard agent stream events until the next user send. */
  const discardAgentEventsRef = useRef(false);
  const lastAgentSessionHydrateKeyRef = useRef<string>("");
  const timelineRef = useRef<HTMLElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerExpandedSticky, setComposerExpandedSticky] = useState(false);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>({
    activeProvider: "gpt",
    userDefine: EMPTY_USER_DEFINE
  });
  const [selectedPythonPath, setSelectedPythonPath] = useState<string | null>(null);
  const [providerSettingsError, setProviderSettingsError] = useState<string | null>(null);
  const [providerSettingsNotice, setProviderSettingsNotice] = useState<string | null>(null);
  const [savingProviderSettings, setSavingProviderSettings] = useState(false);
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [assetManifest, setAssetManifest] = useState<AssetManifest | null>(null);
  const [pendingChangeSlotIds, setPendingChangeSlotIds] = useState<string[]>([]);
  const [rightPaneTab, setRightPaneTab] = useState<RightPaneTab>("emulator");
  const [deployEligibility, setDeployEligibility] = useState<DeployEligibility>({
    ok: false,
    reason: "no_workspace"
  });
  const [widgetParamsText, setWidgetParamsText] = useState("{}");
  const [widgetParamsError, setWidgetParamsError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeId>(() => resolveThemeFromEnvironment());

  const api = window.dartsnutApi;

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
    activeReasoningStreamDeltaRef.current = "";
    activeReasoningStartedAtRef.current = null;
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
    if (!activeId) {
      const seq = eventSeqRef.current;
      eventSeqRef.current += 1;
      const id = `evt-${seq}-${event.at}`;
      activeReasoningStreamEntryIdRef.current = id;
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
    api.getSelectedPythonPath().then(setSelectedPythonPath).catch(() => {
      setSelectedPythonPath(null);
    });
    api.getPythonRuntimeStatus().then(setPythonRuntimeStatus).catch(() => {
      setPythonRuntimeStatus(null);
    });
    const unsubscribe = api.onAgentEvent((event) => {
      if (discardAgentEventsRef.current) {
        return;
      }
      if (event.type === "intake_project_type_prompt") {
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
      if (event.type === "reasoning_stream") {
        appendOrPatchReasoningStream(event);
        return;
      }
      if (event.type === "stream") {
        appendOrPatchStream(event);
        return;
      }
      if (event.type === "reasoning_done") {
        const activeId = activeReasoningStreamEntryIdRef.current;
        const startedAt = activeReasoningStartedAtRef.current;
        if (activeId && startedAt != null) {
          const elapsed = formatReasoningElapsedSeconds(startedAt, event.at);
          setEntries((prev) =>
            prev.map((entry) =>
              entry.id === activeId
                ? { ...entry, text: `Thought for ${elapsed} s`, reasoningMode: "summary" }
                : entry
            )
          );
        }
        activeReasoningStreamEntryIdRef.current = null;
        activeReasoningStreamDeltaRef.current = "";
        activeReasoningStartedAtRef.current = null;
        return;
      }
      if (event.type === "final") {
        if (
          activeStreamEntryIdRef.current &&
          activeStreamDeltaRef.current.trim() === event.content.trim()
        ) {
          activeStreamEntryIdRef.current = null;
          activeStreamDeltaRef.current = "";
          return;
        }
        appendRawAgentEvent(event);
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
    const unsubscribeMainConsoleMirror = isDevLoggingEnabled()
      ? api.onMainProcessConsoleMirror((payload) => {
          printMainProcessMirrorToDevtools(payload);
        })
      : () => {};
    return () => {
      unsubscribe();
      unsubscribeBootstrap();
      unsubscribePythonRuntime();
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

  // Reset to Emulator tab when the active tab is no longer available.
  useEffect(() => {
    if (!assetManifest && rightPaneTab === "assets") {
      setRightPaneTab("emulator");
    }
    if (!deployEligible && rightPaneTab === "deploy") {
      setRightPaneTab("emulator");
    }
  }, [assetManifest, deployEligible, rightPaneTab]);

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
      if (!summary.hasPersistedSession || summary.transcriptTail.length === 0) {
        setEntries([{ id: "greeting-initial", role: "agent", text: GREETING_TEXT }]);
        return;
      }
      const hydrated = summary.transcriptTail
        .map((line, idx) => transcriptLineToTimelineEntry(line, idx))
        .filter((entry): entry is TimelineEntry => entry != null);
      setEntries(hydrated);
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
    eventSeqRef.current = 0;
    lastAgentSessionHydrateKeyRef.current = "";
    setSessionTemplateMode(null);
    setSessionWidgetSize(null);
    setSessionProjectType(null);
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

  async function handleProviderChange(nextId: LlmProviderId) {
    if (!api || nextId === providerSettings.activeProvider || switchingProvider) {
      return;
    }
    setProviderSettingsError(null);
    setProviderSettingsNotice(null);
    const isTempWorkspace = Boolean(bootstrap?.isTemporaryWorkspace);
    const nonEmpty = await isChatSectionNonEmpty();
    if (isTempWorkspace || nonEmpty) {
      const confirmed = window.confirm(
        isTempWorkspace
          ? "Switch LLM provider?\n\n" +
              "This wipes your unsaved temporary project, clears chat, and opens a fresh temporary workspace."
          : "Switch LLM provider?\n\n" +
              "This clears the current chat history for this workspace. Your project files on disk are not deleted."
      );
      if (!confirmed) {
        return;
      }
    }
    setSwitchingProvider(true);
    try {
      if (sending) {
        await api.cancelAgent();
        setSending(false);
      }
      const prep = await api.prepareWorkspaceForProviderSwitch();
      if (!prep.ok) {
        if (prep.reason === "persistence_disabled") {
          resetChatSessionUi();
        } else {
          setProviderSettingsError("No workspace is open. Open or create a project, then switch provider again.");
          return;
        }
      } else {
        setBootstrap(prep.state);
        if (!isTempWorkspace) {
          resetChatSessionUi();
        }
      }
      const saved = await api.saveProviderSettings({
        activeProvider: nextId,
        userDefine: providerSettings.userDefine
      });
      setProviderSettings(saved);
      setProviderSettingsNotice(
        nextId === "user-define"
          ? "Switched to User define. Save API credentials below when ready."
          : `Switched to ${LLM_PROVIDER_OPTIONS.find((o) => o.id === nextId)?.label ?? nextId}. Credentials come from .env.`
      );
      const refreshed = await api.getBootstrapState();
      setBootstrap(refreshed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to switch provider.";
      setProviderSettingsError(message);
    } finally {
      setSwitchingProvider(false);
    }
  }

  async function handleSaveProviderSettings() {
    if (!api) {
      setProviderSettingsError("Desktop bridge is unavailable.");
      return;
    }
    if (providerSettings.activeProvider !== "user-define") {
      setProviderSettingsError("Built-in providers use .env credentials. Select User define to save custom API settings.");
      return;
    }
    setProviderSettingsError(null);
    setProviderSettingsNotice(null);
    const ud = providerSettings.userDefine;
    if (!ud.apiKey.trim()) {
      setProviderSettingsError("API key is required.");
      return;
    }
    if (!ud.model.trim()) {
      setProviderSettingsError("Model is required.");
      return;
    }
    if (ud.baseUrl.trim()) {
      try {
        new URL(ud.baseUrl.trim());
      } catch {
        setProviderSettingsError("Endpoint must be a valid URL.");
        return;
      }
    }
    setSavingProviderSettings(true);
    try {
      const saved = await api.saveProviderSettings({
        activeProvider: "user-define",
        userDefine: {
          baseUrl: ud.baseUrl,
          apiKey: ud.apiKey,
          model: ud.model
        }
      });
      setProviderSettings(saved);
      setProviderSettingsNotice("Settings saved. New LLM calls will use these values.");
      const refreshed = await api.getBootstrapState();
      setBootstrap(refreshed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save provider settings.";
      setProviderSettingsError(message);
    } finally {
      setSavingProviderSettings(false);
    }
  }

  async function handlePickPythonPath() {
    if (!api) {
      return;
    }
    setProviderSettingsError(null);
    setProviderSettingsNotice(null);
    try {
      const result = await api.pickPythonPath();
      if (!result.accepted) {
        if (result.error && result.error !== "cancelled") {
          setProviderSettingsError(result.error);
        }
        return;
      }
      setSelectedPythonPath(result.selectedPath);
      setProviderSettingsNotice("Python executable updated.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to set Python executable.";
      setProviderSettingsError(message);
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
      templateMode: sessionTemplateMode ?? undefined,
      widgetSize: sessionWidgetSize ?? undefined,
      projectType: sessionProjectType ?? undefined
    });
  }

  async function handleStopAgent() {
    if (!api || !sending) {
      return;
    }
    clearActiveCoalescedStreamEntries();
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
        "grid-cols-[minmax(620px,760px)_1fr] grid-rows-[auto_minmax(0,1fr)]",
        "pr-[var(--window-control-inset-right)] pb-[var(--window-control-inset-bottom)] pl-[var(--window-control-inset-left)]",
        "max-[1100px]:grid-cols-1 max-[1100px]:grid-rows-[auto_minmax(0,1fr)]"
      )}
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
            <div className="flex min-w-0 shrink-0 items-center gap-1.5">
              <h1
                className="m-0 min-w-0 p-0 font-[family-name:var(--font-display)] text-[13px] font-semibold leading-snug tracking-tight text-fg-strong"
                title={
                  bootstrap?.workspaceRoot ??
                  "Embedded assistant for pygame + pydartsnut"
                }
              >
                <span className="block truncate">
                  {bootstrap?.workspaceRoot && !bootstrap.isTemporaryWorkspace
                    ? workspaceFolderBasename(bootstrap.workspaceRoot)
                    : "Dartsnut Chat"}
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
                aria-label="Choose workspace folder"
                title="Choose workspace folder"
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
              className="min-h-0 min-w-6 flex-1 self-stretch [-webkit-app-region:drag] [app-region:drag]"
              aria-hidden
            />
            <div className="inline-flex shrink-0 items-center gap-2">
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
      {screen === "main" ? (
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
              <div
                key={entry.id}
                className={cn(
                  "entry",
                  entry.role,
                  entry.id.startsWith("greeting") && entry.role === "agent" && "greeting-entry"
                )}
              >
                {entry.role === "agent" && entry.id.startsWith("greeting") ? (
                  <div className="greeting-card" role="status">
                    <p className="greeting-card__eyebrow">Neon Pit · ready</p>
                    <p className="greeting-card__title">Dartsnut Chat</p>
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
                    onClick={() =>
                      setEntries((prev) =>
                        prev.map((candidate) =>
                          candidate.id === entry.id
                            ? {
                              ...candidate,
                              reasoningMode: candidate.reasoningMode === "expanded" ? "summary" : "expanded"
                            }
                            : candidate
                        )
                      )
                    }
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
                ) : (
                  <pre className="entry-json">{entry.text}</pre>
                )}
              </div>
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
          {/* Chip rows: host shows these while a blocking `dartsnut_ask_question` call is waiting. */}
          {projectTypePicker.visible &&
          projectTypePicker.types.length > 0 ? (
            <div
              className="flex flex-col gap-1.5"
              role="group"
              aria-label="Project type"
            >
              <span className="text-[11px] font-medium text-[var(--color-text-subtle)]">
                Game or widget?
              </span>
              <div className="flex flex-wrap gap-2">
                {projectTypePicker.types.map((pt) => (
                  <button
                    key={pt}
                    type="button"
                    className="ui-chip"
                    onClick={() => void handleProjectTypeChip(pt)}
                  >
                    {projectTypeChipLabel(pt)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {widgetSizePicker.visible &&
          widgetSizePicker.sizes.length > 0 ? (
            <div
              className="flex flex-col gap-1.5"
              role="group"
              aria-label="Widget display size"
            >
              <span className="text-[11px] font-medium text-[var(--color-text-subtle)]">
                Pick display size
              </span>
              <div className="flex flex-wrap gap-2">
                {widgetSizePicker.sizes.map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    className="ui-chip tabular-nums"
                    onClick={() => void handleWidgetSizeChip(sz)}
                  >
                    {sz}
                  </button>
                ))}
              </div>
            </div>
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
                OpenAI key configure
              </button>
            </nav>
            <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4 text-[13px]">
              <label className="flex flex-col gap-1.5">
                <span className="text-[var(--color-text-subtle)]">Provider</span>
                <select
                  className="ui-input [font:inherit]"
                  value={providerSettings.activeProvider}
                  disabled={switchingProvider || savingProviderSettings}
                  onChange={(event) => void handleProviderChange(event.target.value as LlmProviderId)}
                >
                  {LLM_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {providerSettings.activeProvider !== "user-define" ? (
                <p className="m-0 text-xs text-fg-muted">
                  Credentials for this provider are read from <code className="text-[12px]">.env</code> (
                  {providerSettings.activeProvider === "gpt" ? "GPT_* or OPENAI_*" : `${providerSettings.activeProvider.toUpperCase()}_*`}
                  ).
                </p>
              ) : null}
              <label className="flex flex-col gap-1.5">
                <span className="text-[var(--color-text-subtle)]">API endpoint</span>
                <input
                  type="url"
                  readOnly={providerSettings.activeProvider !== "user-define"}
                  className="ui-input disabled:opacity-80"
                  value={
                    providerSettings.activeProvider === "user-define"
                      ? providerSettings.userDefine.baseUrl
                      : (providerSettings.resolvedPreview?.baseUrl ?? "")
                  }
                  onChange={(event) =>
                    setProviderSettings((prev) => ({
                      ...prev,
                      userDefine: { ...prev.userDefine, baseUrl: event.target.value }
                    }))
                  }
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[var(--color-text-subtle)]">API key</span>
                <input
                  type={providerSettings.activeProvider === "user-define" ? "password" : "text"}
                  readOnly={providerSettings.activeProvider !== "user-define"}
                  className="ui-input disabled:opacity-80"
                  value={
                    providerSettings.activeProvider === "user-define"
                      ? providerSettings.userDefine.apiKey
                      : (providerSettings.resolvedPreview?.apiKeyMasked ?? "")
                  }
                  onChange={(event) =>
                    setProviderSettings((prev) => ({
                      ...prev,
                      userDefine: { ...prev.userDefine, apiKey: event.target.value }
                    }))
                  }
                  placeholder="sk-..."
                />
              </label>
              {providerSettings.activeProvider === "user-define" ? (
                <div className="text-xs text-fg-muted">
                  Stored key preview: {maskApiKey(providerSettings.userDefine.apiKey) || "(empty)"}
                </div>
              ) : null}
              <label className="flex flex-col gap-1.5">
                <span className="text-[var(--color-text-subtle)]">Model</span>
                <input
                  type="text"
                  readOnly={providerSettings.activeProvider !== "user-define"}
                  className="ui-input disabled:opacity-80"
                  value={
                    providerSettings.activeProvider === "user-define"
                      ? providerSettings.userDefine.model
                      : (providerSettings.resolvedPreview?.model ?? "")
                  }
                  onChange={(event) =>
                    setProviderSettings((prev) => ({
                      ...prev,
                      userDefine: { ...prev.userDefine, model: event.target.value }
                    }))
                  }
                  placeholder="gpt-4.1-mini"
                />
              </label>
              {providerSettings.activeProvider === "user-define" ? (
                <div className="flex justify-start">
                  <button
                    type="button"
                    className="ui-btn-primary mt-0 disabled:cursor-not-allowed disabled:opacity-55"
                    onClick={() => void handleSaveProviderSettings()}
                    disabled={savingProviderSettings || switchingProvider}
                  >
                    {savingProviderSettings ? "Saving..." : "Save"}
                  </button>
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <span>Python executable</span>
                <div className="text-xs text-fg-muted">{selectedPythonPath ?? "(auto detect)"}</div>
                <div className="flex justify-start">
                  <button
                    type="button"
                    className="ui-btn-secondary mt-0 disabled:cursor-not-allowed disabled:opacity-55"
                    onClick={() => void handlePickPythonPath()}
                  >
                    Choose Python
                  </button>
                </div>
              </div>
            </div>
          </section>
        </section>
      )}
      <aside
        className={cn(
          "right-pane col-start-2 row-start-2 flex min-h-0 h-full min-w-[460px] flex-1 flex-col overflow-hidden border-l border-edge bg-[var(--color-right-pane-bg)]",
          "max-[1100px]:hidden"
        )}
      >
        {assetManifest || deployEligible ? (
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
            {deployEligible ? (
              <button
                type="button"
                className={cn("ui-tab", rightPaneTab === "deploy" && "ui-tab--active")}
                role="tab"
                aria-selected={rightPaneTab === "deploy"}
                onClick={() => setRightPaneTab("deploy")}
              >
                Deploy
              </button>
            ) : null}
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
              (Boolean(assetManifest) || deployEligible) && rightPaneTab !== "emulator" && "hidden"
            )}
          >
            <EmulatorPanel
              widgetParamsText={widgetParamsText}
              setWidgetParamsText={setWidgetParamsText}
              widgetParamsError={widgetParamsError}
              setWidgetParamsError={setWidgetParamsError}
            />
          </div>
          {deployEligible ? (
            <div
              className={cn("flex min-h-0 flex-1 flex-col", rightPaneTab !== "deploy" && "hidden")}
            >
              <DeployPanel
                showWidgetParams={deployPanelShowsWidgetParams}
                widgetParamsText={widgetParamsText}
                setWidgetParamsText={setWidgetParamsText}
                widgetParamsError={widgetParamsError}
                setWidgetParamsError={setWidgetParamsError}
              />
            </div>
          ) : null}
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
