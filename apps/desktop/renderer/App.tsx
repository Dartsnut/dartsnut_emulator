import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentEvent,
  AssetManifest,
  BootstrapState,
  ManifestSnapshot,
  ProviderSettings,
  ProjectType,
  PromptRequest,
  WidgetSize
} from "@dartsnut/shared-ipc";
import { AssetManagerPanel } from "./AssetManagerPanel";
import { EmulatorPanel } from "./EmulatorPanel";
import { highlightDiffLine, languageFromPath } from "./highlightDiffLine";
import { ThemeSwitcherIcon } from "./ThemeSwitcher";
import { applyTheme, resolveThemeFromEnvironment, type ThemeId } from "./theme";
import { useWindowChromeInsets } from "./useWindowChromeInsets";

type RightPaneTab = "emulator" | "assets";

interface TimelineEntry {
  id: string;
  role: "user" | "agent" | "status" | "error";
  text: string;
  streaming?: boolean;
}

interface FormattedAgentMessage {
  narrative: string;
  response: string | null;
  actions: ParsedAction[];
}

interface ParsedAction {
  tool: string;
  path?: string;
  content?: string;
  contentClosed?: boolean;
  previousContent?: string;
  isFileWrite: boolean;
  /** read_file / list_files (and similar) — show path while streaming, no diff body. */
  isToolPlan?: boolean;
  raw: string;
}

/** write_file with no prior snapshot — treat as new file (diff is empty → content). */
function isNewFileWrite(action: ParsedAction): boolean {
  return (
    action.tool === "write_file" &&
    (action.previousContent === undefined || action.previousContent === "")
  );
}

interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
}

type IntakeStep = "projectType" | "widgetSize" | "workspace";
type AppScreen = "main" | "settings";

const STREAM_PREVIEW_LINES = 8;
const DIFF_MAX_LINES = 220;
const DIFF_CONTEXT_LINES = 4;
const AUTO_SCROLL_BOTTOM_THRESHOLD = 24;
/** While an agent message is streaming, cap how often we snap the timeline scroll to the bottom. */
const STREAM_TIMELINE_AUTOSCROLL_MIN_MS = 72;
const SUPPORTED_WIDGET_SIZES: WidgetSize[] = ["128x160", "128x128", "128x64", "64x32"];
/** Keep in sync with `.composer-pill-input { max-height }` in styles.css */
const COMPOSER_PROMPT_MAX_HEIGHT_PX = 200;
/** Content taller than one line — switch composer shell from pill to rounded card */
const COMPOSER_PROMPT_EXPANDED_THRESHOLD_PX = 52;
const GREETING_TEXT =
  "Hi! I can help you create or modify Dartsnut widgets and games. Pick a workspace folder and tell me what you want to build.";

function isSettingsShortcut(event: KeyboardEvent): boolean {
  if (event.key !== ",") {
    return false;
  }
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
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

function inferProjectType(input: string): ProjectType | null {
  const hasGame = /\bgame\b/i.test(input);
  const hasWidget = /\bwidget\b/i.test(input);
  if (hasGame === hasWidget) {
    return null;
  }
  return hasGame ? "game" : "widget";
}

function inferWidgetSize(input: string): WidgetSize | null {
  const match = input.match(/\b(128\s*x\s*160|128\s*x\s*128|128\s*x\s*64|64\s*x\s*32)\b/i);
  if (!match) {
    return null;
  }
  const normalized = match[1].toLowerCase().replace(/\s+/g, "");
  if (normalized === "128x160" || normalized === "128x128" || normalized === "128x64" || normalized === "64x32") {
    return normalized;
  }
  return null;
}

function getLatestPreviewLines(content: string): { lines: string[]; truncated: boolean } {
  const normalized = content.replace(/\r/g, "");
  const allLines = normalized.split("\n");
  const lines = allLines.slice(-STREAM_PREVIEW_LINES);
  return {
    lines,
    truncated: allLines.length > lines.length
  };
}

function getStreamingPreviewDiffLines(action: ParsedAction): { lines: DiffLine[]; truncated: boolean } {
  if (typeof action.content !== "string") {
    return { lines: [], truncated: false };
  }
  if (typeof action.previousContent === "string") {
    const diff = buildDiffLines(action.previousContent, action.content, STREAM_PREVIEW_LINES * 4);
    const lines = diff.lines.slice(-STREAM_PREVIEW_LINES);
    return { lines, truncated: diff.truncated || diff.lines.length > lines.length };
  }
  const preview = getLatestPreviewLines(action.content);
  return {
    lines: preview.lines.map((text) => ({ kind: "add", text })),
    truncated: preview.truncated
  };
}

function decodeEscapedStreamingText(input: string): string {
  return input
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "");
}

function buildRawDiffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const n = oldLines.length;
  const m = newLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: "context", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: "remove", text: oldLines[i] });
      i += 1;
    } else {
      lines.push({ kind: "add", text: newLines[j] });
      j += 1;
    }
  }

  while (i < n) {
    lines.push({ kind: "remove", text: oldLines[i] });
    i += 1;
  }

  while (j < m) {
    lines.push({ kind: "add", text: newLines[j] });
    j += 1;
  }

  return lines;
}

function trimDiffLinesAroundChanges(
  lines: DiffLine[],
  maxLines: number,
  contextLines: number
): { lines: DiffLine[]; truncated: boolean } {
  const changeIdxs: number[] = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].kind !== "context") {
      changeIdxs.push(idx);
    }
  }

  if (changeIdxs.length === 0) {
    const capped = lines.slice(0, Math.min(lines.length, maxLines));
    return { lines: capped, truncated: lines.length > maxLines };
  }

  const windows: Array<{ start: number; end: number }> = changeIdxs.map((idx) => ({
    start: Math.max(0, idx - contextLines),
    end: Math.min(lines.length - 1, idx + contextLines)
  }));

  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const prev = merged[merged.length - 1];
    if (!prev || window.start > prev.end + 1) {
      merged.push({ ...window });
    } else {
      prev.end = Math.max(prev.end, window.end);
    }
  }

  const firstWindow = merged[0]!;
  const hadMoreHunks = merged.length > 1;

  const out: DiffLine[] = [];
  for (let i = firstWindow.start; i <= firstWindow.end; i += 1) {
    out.push(lines[i]);
  }

  if (hadMoreHunks) {
    out.push({ kind: "context", text: "..." });
  }

  let truncated = hadMoreHunks;
  if (out.length > maxLines) {
    return { lines: out.slice(0, maxLines), truncated: true };
  }

  return { lines: out, truncated };
}

function buildDiffLines(oldText: string, newText: string, maxLines: number): {
  lines: DiffLine[];
  truncated: boolean;
} {
  const raw = buildRawDiffLines(oldText, newText);
  return trimDiffLinesAroundChanges(raw, maxLines, DIFF_CONTEXT_LINES);
}

function parseJsonStringValue(input: string, startQuoteIdx: number): { value: string; nextIndex: number; closed: boolean } {
  let escaped = false;
  let idx = startQuoteIdx + 1;
  while (idx < input.length) {
    const ch = input[idx];
    if (escaped) {
      escaped = false;
      idx += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      idx += 1;
      continue;
    }
    if (ch === "\"") {
      const raw = input.slice(startQuoteIdx, idx + 1);
      try {
        return { value: JSON.parse(raw) as string, nextIndex: idx + 1, closed: true };
      } catch {
        return { value: input.slice(startQuoteIdx + 1, idx), nextIndex: idx + 1, closed: true };
      }
    }
    idx += 1;
  }
  const raw = `${input.slice(startQuoteIdx)}"`;
  try {
    return { value: JSON.parse(raw) as string, nextIndex: input.length, closed: false };
  } catch {
    return {
      value: decodeEscapedStreamingText(input.slice(startQuoteIdx + 1)),
      nextIndex: input.length,
      closed: false
    };
  }
}

function parsePartialAgentMessage(text: string): FormattedAgentMessage {
  const actions: ParsedAction[] = [];
  const jsonStart = text.indexOf("{");
  const narrative = jsonStart > 0 ? text.slice(0, jsonStart).trim() : "";
  let response: string | null = null;

  const responseKey = text.indexOf("\"response\"");
  if (responseKey >= 0) {
    const responseQuote = text.indexOf("\"", text.indexOf(":", responseKey));
    if (responseQuote >= 0) {
      response = parseJsonStringValue(text, responseQuote).value;
    }
  }

  let scanFrom = 0;
  while (scanFrom < text.length) {
    const toolKey = text.indexOf("\"tool\"", scanFrom);
    if (toolKey < 0) {
      break;
    }
    const toolQuote = text.indexOf("\"", text.indexOf(":", toolKey));
    if (toolQuote < 0) {
      break;
    }
    const parsedTool = parseJsonStringValue(text, toolQuote);
    const nextToolKey = text.indexOf("\"tool\"", parsedTool.nextIndex);
    const sectionEnd = nextToolKey >= 0 ? nextToolKey : text.length;

    if (parsedTool.value === "write_file") {
      const pathKey = text.indexOf("\"path\"", toolKey);
      let pathValue: string | undefined;
      if (pathKey >= 0 && pathKey < sectionEnd) {
        const pathQuote = text.indexOf("\"", text.indexOf(":", pathKey));
        if (pathQuote >= 0 && pathQuote < sectionEnd) {
          pathValue = parseJsonStringValue(text, pathQuote).value;
        }
      }

      const contentKey = text.indexOf("\"content\"", toolKey);
      let previousContentValue: string | undefined;
      const previousContentKeys = ["\"previousContent\"", "\"originalContent\"", "\"beforeContent\""];
      for (const key of previousContentKeys) {
        const previousKey = text.indexOf(key, toolKey);
        if (previousKey >= 0 && previousKey < sectionEnd) {
          const previousQuote = text.indexOf("\"", text.indexOf(":", previousKey));
          if (previousQuote >= 0 && previousQuote < sectionEnd) {
            previousContentValue = parseJsonStringValue(text, previousQuote).value;
            break;
          }
        }
      }
      if (contentKey >= 0 && contentKey < sectionEnd) {
        const contentQuote = text.indexOf("\"", text.indexOf(":", contentKey));
        if (contentQuote >= 0 && contentQuote < sectionEnd) {
          const parsedContent = parseJsonStringValue(text, contentQuote);
          actions.push({
            tool: "write_file",
            path: pathValue,
            content: parsedContent.value,
            contentClosed: parsedContent.closed,
            previousContent: previousContentValue,
            isFileWrite: true,
            raw: ""
          });
        }
      }
    }

    if (parsedTool.value === "replace_in_file") {
      const pathKey = text.indexOf("\"path\"", toolKey);
      let pathValue: string | undefined;
      if (pathKey >= 0 && pathKey < sectionEnd) {
        const pathQuote = text.indexOf("\"", text.indexOf(":", pathKey));
        if (pathQuote >= 0 && pathQuote < sectionEnd) {
          pathValue = parseJsonStringValue(text, pathQuote).value;
        }
      }

      const findKey = text.indexOf("\"find\"", toolKey);
      const replaceKey = text.indexOf("\"replace\"", toolKey);
      if (findKey >= 0 && findKey < sectionEnd && replaceKey >= 0 && replaceKey < sectionEnd) {
        const findQuote = text.indexOf("\"", text.indexOf(":", findKey));
        const replaceQuote = text.indexOf("\"", text.indexOf(":", replaceKey));
        if (
          findQuote >= 0 &&
          findQuote < sectionEnd &&
          replaceQuote >= 0 &&
          replaceQuote < sectionEnd
        ) {
          const parsedFind = parseJsonStringValue(text, findQuote);
          const parsedReplace = parseJsonStringValue(text, replaceQuote);
          actions.push({
            tool: "replace_in_file",
            path: pathValue,
            content: parsedReplace.value,
            contentClosed: parsedReplace.closed,
            previousContent: parsedFind.value,
            isFileWrite: true,
            raw: ""
          });
        }
      }
    }

    if (parsedTool.value === "read_file" || parsedTool.value === "list_files") {
      const pathKey = text.indexOf("\"path\"", toolKey);
      let pathValue: string | undefined;
      if (pathKey >= 0 && pathKey < sectionEnd) {
        const pathQuote = text.indexOf("\"", text.indexOf(":", pathKey));
        if (pathQuote >= 0 && pathQuote < sectionEnd) {
          pathValue = parseJsonStringValue(text, pathQuote).value;
        }
      }
      actions.push({
        tool: parsedTool.value,
        path: pathValue,
        isFileWrite: false,
        isToolPlan: true,
        raw: ""
      });
    }

    scanFrom = parsedTool.nextIndex;
  }

  return { narrative, response, actions };
}

function formatAgentMessage(text: string): FormattedAgentMessage {
  const trimmed = text.trim();
  if (!trimmed) {
    return { narrative: "", response: null, actions: [] };
  }

  for (let idx = trimmed.indexOf("{"); idx >= 0; idx = trimmed.indexOf("{", idx + 1)) {
    const maybeJson = trimmed.slice(idx).trim();
    try {
      const parsed = JSON.parse(maybeJson) as {
        response?: string;
        actions?: Array<{
          tool?: string;
          path?: string;
          content?: string;
          previousContent?: string;
          originalContent?: string;
          beforeContent?: string;
        }>;
      };
      const narrative = trimmed.slice(0, idx).trim();
      return {
        narrative,
        response: typeof parsed.response === "string" ? parsed.response : null,
        actions: Array.isArray(parsed.actions)
          ? parsed.actions.map((action) => ({
              tool: action.tool ?? "unknown",
              path: action.path,
              content:
                typeof action.content === "string"
                  ? action.content
                  : action.tool === "replace_in_file" && typeof (action as { replace?: unknown }).replace === "string"
                    ? ((action as { replace: string }).replace ?? "")
                    : undefined,
              contentClosed: true,
              previousContent:
                action.previousContent ??
                action.originalContent ??
                action.beforeContent ??
                (action.tool === "replace_in_file" && typeof (action as { find?: unknown }).find === "string"
                  ? ((action as { find: string }).find ?? "")
                  : undefined),
              isFileWrite:
                (action.tool === "write_file" && typeof action.content === "string") ||
                (action.tool === "replace_in_file" &&
                  typeof (action as { find?: unknown }).find === "string" &&
                  typeof (action as { replace?: unknown }).replace === "string"),
              isToolPlan: action.tool === "read_file" || action.tool === "list_files",
              raw: JSON.stringify(action, null, 2)
            }))
          : []
      };
    } catch {
      // Keep scanning for a valid JSON block.
    }
  }

  return parsePartialAgentMessage(text);
}

function workspaceFolderBasename(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : workspaceRoot;
}

function toEntry(event: AgentEvent, seq: number): TimelineEntry {
  if (event.type === "stream") {
    return { id: `${event.type}-${event.at}-${seq}`, role: "agent", text: event.delta, streaming: true };
  }
  if (event.type === "final") {
    return { id: `${event.type}-${event.at}-${seq}`, role: "agent", text: event.content, streaming: false };
  }
  if (event.type === "error") {
    return { id: `${event.type}-${event.at}-${seq}`, role: "error", text: event.message };
  }
  return { id: `${event.type}-${event.at}-${seq}`, role: "status", text: event.message };
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
    { id: "greeting-initial", role: "agent", text: GREETING_TEXT, streaming: false }
  ]);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [pythonRuntimeStatus, setPythonRuntimeStatus] = useState<string | null>(null);
  const [screen, setScreen] = useState<AppScreen>("main");
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [intakeProjectType, setIntakeProjectType] = useState<ProjectType | null>(null);
  const [intakeWidgetSize, setIntakeWidgetSize] = useState<WidgetSize | null>(null);
  const [intakeWorkspacePath, setIntakeWorkspacePath] = useState<string | null>(null);
  const [intakeStep, setIntakeStep] = useState<IntakeStep | null>(null);
  /** Preserves widget/game creator routing for follow-up prompts (intake only runs once). */
  const [sessionTemplateMode, setSessionTemplateMode] = useState<
    "game-creator" | "widget-creator" | null
  >(null);
  const [sessionWidgetSize, setSessionWidgetSize] = useState<WidgetSize | null>(null);
  const [sessionProjectType, setSessionProjectType] = useState<ProjectType | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const pendingReplyIdRef = useRef<string | null>(null);
  const eventSeqRef = useRef(0);
  const activeStreamEntryIdRef = useRef<string | null>(null);
  const streamPendingDeltaRef = useRef("");
  const streamFlushRafRef = useRef<number | null>(null);
  const streamAutoscrollGateRef = useRef(0);
  /** After session reset / new project, discard agent stream events until the next user send. */
  const discardAgentEventsRef = useRef(false);
  const timelineRef = useRef<HTMLElement | null>(null);
  const composerPillRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>({
    baseUrl: "",
    apiKey: "",
    model: ""
  });
  const [selectedPythonPath, setSelectedPythonPath] = useState<string | null>(null);
  const [providerSettingsError, setProviderSettingsError] = useState<string | null>(null);
  const [providerSettingsNotice, setProviderSettingsNotice] = useState<string | null>(null);
  const [savingProviderSettings, setSavingProviderSettings] = useState(false);
  const [assetManifest, setAssetManifest] = useState<AssetManifest | null>(null);
  const [pendingChangeSlotIds, setPendingChangeSlotIds] = useState<string[]>([]);
  const [rightPaneTab, setRightPaneTab] = useState<RightPaneTab>("emulator");
  const [theme, setTheme] = useState<ThemeId>(() => resolveThemeFromEnvironment());

  const api = window.dartsnutApi;

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function handleThemeChange(next: ThemeId) {
    setTheme(next);
  }

  function clearPendingReplyIndicator() {
    const pendingId = pendingReplyIdRef.current;
    if (!pendingId) {
      return;
    }
    setEntries((prev) => prev.filter((entry) => entry.id !== pendingId));
    pendingReplyIdRef.current = null;
  }

  function isTimelineNearBottom(element: HTMLElement): boolean {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= AUTO_SCROLL_BOTTOM_THRESHOLD;
  }

  function scrollTimelineToBottom() {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    timeline.scrollTop = timeline.scrollHeight;
  }

  function cancelStreamCoalesce() {
    if (streamFlushRafRef.current !== null) {
      cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
    streamPendingDeltaRef.current = "";
  }

  function flushPendingStreamDeltas() {
    streamFlushRafRef.current = null;
    const streamId = activeStreamEntryIdRef.current;
    const pending = streamPendingDeltaRef.current;
    streamPendingDeltaRef.current = "";
    if (!streamId || !pending) {
      return;
    }
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === streamId ? { ...entry, text: entry.text + pending, streaming: true } : entry
      )
    );
    if (streamPendingDeltaRef.current.length > 0) {
      scheduleStreamFlush();
    }
  }

  function scheduleStreamFlush() {
    if (streamFlushRafRef.current !== null) {
      return;
    }
    streamFlushRafRef.current = window.requestAnimationFrame(() => {
      flushPendingStreamDeltas();
    });
  }

  function syncComposerPromptHeight() {
    const el = promptInputRef.current;
    const pill = composerPillRef.current;
    if (!el || !pill) {
      return;
    }
    el.style.height = "auto";
    const scrollH = el.scrollHeight;
    const capped = Math.min(scrollH, COMPOSER_PROMPT_MAX_HEIGHT_PX);
    el.style.height = `${capped}px`;
    el.style.overflowY = scrollH > COMPOSER_PROMPT_MAX_HEIGHT_PX ? "auto" : "hidden";
    pill.classList.toggle("composer-pill--expanded", scrollH > COMPOSER_PROMPT_EXPANDED_THRESHOLD_PX);
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
    const streaming = entries.some((entry) => entry.streaming);
    if (streaming) {
      const now = performance.now();
      if (now - streamAutoscrollGateRef.current < STREAM_TIMELINE_AUTOSCROLL_MIN_MS) {
        return;
      }
      streamAutoscrollGateRef.current = now;
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
      if (import.meta.env.DEV) {
        if (event.type === "stream") {
          console.debug("[agent-stream]", { type: "stream", deltaChars: event.delta.length, at: event.at });
        } else {
          console.debug("[agent-stream]", event);
        }
      }
      clearPendingReplyIndicator();
      if (event.type === "stream") {
        const streamId = activeStreamEntryIdRef.current;
        if (!streamId) {
          const seq = eventSeqRef.current;
          eventSeqRef.current += 1;
          const entry = toEntry(event, seq);
          activeStreamEntryIdRef.current = entry.id;
          setEntries((prev) => [...prev, entry]);
          return;
        }
        streamPendingDeltaRef.current += event.delta;
        scheduleStreamFlush();
        return;
      }

      if (event.type === "final" && activeStreamEntryIdRef.current) {
        const streamId = activeStreamEntryIdRef.current;
        activeStreamEntryIdRef.current = null;
        cancelStreamCoalesce();
        setEntries((prev) =>
          prev.map((entry) =>
            entry.id === streamId ? { ...entry, text: event.content, streaming: false } : entry
          )
        );
        return;
      }

      if (event.type === "error") {
        cancelStreamCoalesce();
        activeStreamEntryIdRef.current = null;
      }

      const seq = eventSeqRef.current;
      eventSeqRef.current += 1;
      setEntries((prev) => [...prev, toEntry(event, seq)]);
    });
    const unsubscribePythonRuntime = api.onPythonRuntimeStatus((status) => {
      setPythonRuntimeStatus(status);
    });
    return () => {
      cancelStreamCoalesce();
      unsubscribe();
      unsubscribePythonRuntime();
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

  // Reset to Emulator tab when manifest disappears (workspace switch with no manifest).
  useEffect(() => {
    if (!assetManifest && rightPaneTab !== "emulator") {
      setRightPaneTab("emulator");
    }
  }, [assetManifest, rightPaneTab]);

  const chatDisabled = useMemo(() => {
    if (!bootstrap) {
      return true;
    }
    return sending;
  }, [bootstrap, sending]);

  function clearIntake() {
    setPendingPrompt(null);
    setIntakeProjectType(null);
    setIntakeWidgetSize(null);
    setIntakeWorkspacePath(null);
    setIntakeStep(null);
  }

  useEffect(() => {
    if (!api) {
      return;
    }
    return api.onSessionReset(() => {
      discardAgentEventsRef.current = true;
      cancelStreamCoalesce();
      activeStreamEntryIdRef.current = null;
      pendingReplyIdRef.current = null;
      eventSeqRef.current = 0;
      clearIntake();
      setSessionTemplateMode(null);
      setSessionWidgetSize(null);
      setSessionProjectType(null);
      setPrompt("");
      setPendingPrompt(null);
      setRuntimeError(null);
      setEntries([{ id: `greeting-${Date.now()}`, role: "agent", text: GREETING_TEXT, streaming: false }]);
    });
  }, [api]);

  function postStatus(text: string) {
    setEntries((prev) => [...prev, { id: `status-${Date.now()}`, role: "status", text }]);
  }

  function resolveNextIntakeStep(
    projectType: ProjectType | null,
    widgetSize: WidgetSize | null,
    workspacePath: string | null
  ): IntakeStep | null {
    if (!projectType) {
      return "projectType";
    }
    if (projectType === "widget" && !widgetSize) {
      return "widgetSize";
    }
    if (!workspacePath) {
      return "workspace";
    }
    return null;
  }

  async function submitPrompt(request: PromptRequest) {
    discardAgentEventsRef.current = false;
    const pendingReplyId = `agent-pending-${Date.now()}`;
    pendingReplyIdRef.current = pendingReplyId;
    setEntries((prev) => [...prev, { id: pendingReplyId, role: "status", text: "Agent is thinking..." }]);
    setSending(true);
    if (!api) {
      clearPendingReplyIndicator();
      setSending(false);
      return;
    }
    try {
      await api.sendPrompt(request);
      const refreshed = await api.getBootstrapState();
      setBootstrap(refreshed);
    } finally {
      clearPendingReplyIndicator();
      setSending(false);
    }
  }

  async function continueIntake(overrides?: {
    projectType?: ProjectType | null;
    widgetSize?: WidgetSize | null;
    workspacePath?: string | null;
  }) {
    const promptText = pendingPrompt;
    if (!promptText) {
      return;
    }
    const projectType = overrides?.projectType ?? intakeProjectType;
    const widgetSize = overrides?.widgetSize ?? intakeWidgetSize;
    const workspacePath = overrides?.workspacePath ?? intakeWorkspacePath ?? bootstrap?.workspaceRoot ?? null;
    setIntakeProjectType(projectType);
    setIntakeWidgetSize(widgetSize);
    setIntakeWorkspacePath(workspacePath);
    const nextStep = resolveNextIntakeStep(projectType, widgetSize, workspacePath);
    setIntakeStep(nextStep);
    if (nextStep) {
      return;
    }
    const templateMode = projectType === "game" ? "game-creator" : "widget-creator";
    setSessionTemplateMode(templateMode);
    setSessionProjectType(projectType ?? null);
    setSessionWidgetSize(widgetSize ?? null);
    await submitPrompt({
      prompt: promptText,
      projectType: projectType ?? undefined,
      widgetSize: widgetSize ?? undefined,
      workspacePath: workspacePath ?? undefined,
      templateMode
    });
    clearIntake();
  }

  async function handlePickWorkspace() {
    if (!api || sending) {
      return;
    }
    const updated = await api.pickWorkspace();
    setBootstrap(updated.state);
  }

  async function handleStartNewProject() {
    if (!api || sending) {
      return;
    }
    const confirmed = window.confirm(
      "Start a new project?\n\n" +
        "Your game files on disk stay saved.\n\n" +
        "This will leave the current workspace unset, stop the emulator, clear emulator logs, and clear this chat.",
    );
    if (!confirmed) {
      return;
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
    if (!providerSettings.apiKey.trim()) {
      setProviderSettingsError("API key is required.");
      return;
    }
    if (!providerSettings.model.trim()) {
      setProviderSettingsError("Model is required.");
      return;
    }
    if (providerSettings.baseUrl.trim()) {
      try {
        new URL(providerSettings.baseUrl.trim());
      } catch {
        setProviderSettingsError("Endpoint must be a valid URL.");
        return;
      }
    }
    setSavingProviderSettings(true);
    try {
      const saved = await api.saveProviderSettings({
        baseUrl: providerSettings.baseUrl,
        apiKey: providerSettings.apiKey,
        model: providerSettings.model
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

    const shouldRunIntake = !bootstrap?.workspaceRoot;
    if (!shouldRunIntake) {
      await submitPrompt({
        prompt: current,
        workspacePath: bootstrap.workspaceRoot ?? undefined,
        templateMode: sessionTemplateMode ?? undefined,
        widgetSize: sessionWidgetSize ?? undefined,
        projectType: sessionProjectType ?? undefined
      });
      return;
    }
    const inferredType = inferProjectType(current);
    const inferredSize = inferredType === "widget" ? inferWidgetSize(current) : null;
    setPendingPrompt(current);
    setIntakeProjectType(inferredType);
    setIntakeWidgetSize(inferredSize);
    setIntakeWorkspacePath(null);
    const nextStep = resolveNextIntakeStep(inferredType, inferredSize, null);
    setIntakeStep(nextStep);
    if (nextStep === "projectType") {
      postStatus("Choose project type to continue: game or widget.");
    } else if (nextStep === "widgetSize") {
      postStatus("Choose widget size to continue.");
    } else if (nextStep === "workspace") {
      postStatus("Choose an empty workspace folder to continue.");
    }
  }

  return (
    <main className="app-shell">
      <header className="window-chrome-band" role="banner">
        {screen === "main" ? (
          <>
            <div className="window-chrome-band__leading">
              <h1
                className="window-chrome-band__title"
                title={
                  bootstrap?.workspaceRoot ??
                  "Embedded assistant for pygame + pydartsnut"
                }
              >
                <span className="window-chrome-band__title-text">
                  {bootstrap?.workspaceRoot
                    ? workspaceFolderBasename(bootstrap.workspaceRoot)
                    : "Dartsnut Agent"}
                </span>
              </h1>
              <button
                type="button"
                className="chrome-icon-btn"
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
              <button
                type="button"
                className="chrome-icon-btn"
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
            <div className="window-chrome-band__drag-spacer" aria-hidden />
            <div className="window-chrome-band__trailing">
              <ThemeSwitcherIcon id="main-theme-icon" value={theme} onChange={handleThemeChange} />
            </div>
          </>
        ) : (
          <>
            <div className="window-chrome-band__leading">
              <button
                type="button"
                className="chrome-icon-btn"
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
              <h1 className="window-chrome-band__title window-chrome-band__title--settings">
                <span className="window-chrome-band__title-text">Settings</span>
              </h1>
            </div>
            <div className="window-chrome-band__drag-spacer" aria-hidden />
            <div className="window-chrome-band__trailing">
              <ThemeSwitcherIcon id="settings-theme-icon" value={theme} onChange={handleThemeChange} />
            </div>
          </>
        )}
      </header>
      {screen === "main" ? (
        <section className="left-rail">
          <div className="app-top">
            <div className="app-meta">
              {runtimeError ? <div className="runtime-error">{runtimeError}</div> : null}
              {pythonRuntimeStatus ? <div className="runtime-status">{pythonRuntimeStatus}</div> : null}
            </div>
          </div>

          <section
            className={`timeline${autoScrollEnabled ? " timeline--autoscroll" : ""}`}
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
            {entries.map((entry) => (
              <div key={entry.id} className={`entry ${entry.role}`}>
                {entry.role === "agent" ? (
                  <AgentEntryContent text={entry.text} isStreaming={Boolean(entry.streaming)} />
                ) : (
                  <div className="entry-text">{entry.text}</div>
                )}
              </div>
            ))}
          </section>

          <section className="composer">
            {pendingPrompt && intakeStep ? (
              <div className="composer-intake" role="region" aria-label="Creation intake">
                <p className="composer-intake-prompt" id="composer-intake-prompt">
                  <span className="composer-intake-prompt-lead">Intake required before creation.</span>
                  {intakeStep === "projectType" ? " Select project type." : ""}
                  {intakeStep === "widgetSize" ? " Select widget size." : ""}
                  {intakeStep === "workspace" ? " Select an empty workspace folder." : ""}
                </p>
                {intakeStep === "projectType" ? (
                  <div
                    className="composer-intake-chips"
                    role="group"
                    aria-labelledby="composer-intake-prompt"
                  >
                    <button
                      type="button"
                      className="composer-intake-chip"
                      onClick={() => continueIntake({ projectType: "game", widgetSize: null })}
                    >
                      Game
                    </button>
                    <button
                      type="button"
                      className="composer-intake-chip"
                      onClick={() => continueIntake({ projectType: "widget" })}
                    >
                      Widget
                    </button>
                    <button type="button" className="composer-intake-chip composer-intake-chip--quiet" onClick={clearIntake}>
                      Cancel
                    </button>
                  </div>
                ) : null}
                {intakeStep === "widgetSize" ? (
                  <div
                    className="composer-intake-chips"
                    role="group"
                    aria-labelledby="composer-intake-prompt"
                  >
                    {SUPPORTED_WIDGET_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className="composer-intake-chip"
                        onClick={() => continueIntake({ widgetSize: size })}
                      >
                        {size}
                      </button>
                    ))}
                    <button type="button" className="composer-intake-chip composer-intake-chip--quiet" onClick={clearIntake}>
                      Cancel
                    </button>
                  </div>
                ) : null}
                {intakeStep === "workspace" ? (
                  <div
                    className="composer-intake-chips composer-intake-chips--stack"
                    role="group"
                    aria-labelledby="composer-intake-prompt"
                  >
                    <button
                      type="button"
                      className="composer-intake-chip composer-intake-chip--primary"
                      onClick={async () => {
                        const pickResult = await api.pickWorkspace({ requireEmpty: true });
                        setBootstrap(pickResult.state);
                        if (pickResult.accepted && pickResult.selectedPath) {
                          await continueIntake({ workspacePath: pickResult.selectedPath });
                          return;
                        }
                        if (pickResult.reason === "non_empty") {
                          postStatus("Selected workspace is not empty. Please choose a different folder.");
                          return;
                        }
                        if (pickResult.reason === "cancelled") {
                          postStatus("Workspace selection cancelled.");
                        }
                      }}
                    >
                      Choose Empty Workspace
                    </button>
                    <button type="button" className="composer-intake-chip composer-intake-chip--quiet" onClick={clearIntake}>
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="composer-pill" ref={composerPillRef}>
              <textarea
                ref={promptInputRef}
                className="composer-pill-input"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Message..."
                rows={1}
                aria-label="Message"
              />
              <div className="composer-pill-trailing">
                {!autoScrollEnabled ? (
                  <button
                    type="button"
                    className="composer-pill-scroll"
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
                  className="composer-pill-send"
                  disabled={chatDisabled}
                  aria-busy={sending}
                  aria-label={sending ? "Sending" : "Send"}
                  onClick={() => void handleSend()}
                >
                  {sending ? (
                    <span className="composer-pill-send-busy" aria-hidden />
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
        </section>
      ) : (
        <section className="left-rail settings-screen">
          <div className="app-top">
            <div className="app-meta">
              {providerSettingsError ? <div className="runtime-error">{providerSettingsError}</div> : null}
              {providerSettingsNotice ? <div className="settings-notice">{providerSettingsNotice}</div> : null}
            </div>
          </div>
          <section className="settings-layout">
            <nav className="settings-menu" aria-label="Settings menu">
              <button type="button" className="settings-menu-item settings-menu-item-active">
                OpenAI key configure
              </button>
            </nav>
            <div className="settings-content">
              <label className="settings-field">
                <span>API endpoint</span>
                <input
                  type="url"
                  value={providerSettings.baseUrl}
                  onChange={(event) =>
                    setProviderSettings((prev) => ({ ...prev, baseUrl: event.target.value }))
                  }
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="settings-field">
                <span>API key</span>
                <input
                  type="password"
                  value={providerSettings.apiKey}
                  onChange={(event) =>
                    setProviderSettings((prev) => ({ ...prev, apiKey: event.target.value }))
                  }
                  placeholder="sk-..."
                />
              </label>
              <div className="settings-muted">Stored key preview: {maskApiKey(providerSettings.apiKey) || "(empty)"}</div>
              <label className="settings-field">
                <span>Model</span>
                <input
                  type="text"
                  value={providerSettings.model}
                  onChange={(event) =>
                    setProviderSettings((prev) => ({ ...prev, model: event.target.value }))
                  }
                  placeholder="gpt-4.1-mini"
                />
              </label>
              <div className="settings-actions">
                <button type="button" onClick={() => void handleSaveProviderSettings()} disabled={savingProviderSettings}>
                  {savingProviderSettings ? "Saving..." : "Save"}
                </button>
              </div>
              <div className="settings-field">
                <span>Python executable</span>
                <div className="settings-muted">{selectedPythonPath ?? "(auto detect)"}</div>
                <div className="settings-actions">
                  <button type="button" onClick={() => void handlePickPythonPath()}>
                    Choose Python
                  </button>
                </div>
              </div>
            </div>
          </section>
        </section>
      )}
      <aside className="right-pane">
        {assetManifest ? (
          <div className="right-pane-tabs" role="tablist" aria-label="Right pane view">
            <button
              type="button"
              className={`right-pane-tab${rightPaneTab === "emulator" ? " right-pane-tab--active" : ""}`}
              role="tab"
              aria-selected={rightPaneTab === "emulator"}
              onClick={() => setRightPaneTab("emulator")}
            >
              Emulator
            </button>
            <button
              type="button"
              className={`right-pane-tab${rightPaneTab === "assets" ? " right-pane-tab--active" : ""}`}
              role="tab"
              aria-selected={rightPaneTab === "assets"}
              onClick={() => setRightPaneTab("assets")}
            >
              Assets
              {pendingChangeSlotIds.length > 0 ? (
                <span className="right-pane-tab-badge" aria-label={`${pendingChangeSlotIds.length} pending`}>
                  {pendingChangeSlotIds.length}
                </span>
              ) : null}
            </button>
          </div>
        ) : null}
        <div className={`right-pane-body${assetManifest ? " right-pane-body--tabbed" : ""}`}>
          <div
            className="right-pane-section"
            hidden={Boolean(assetManifest) && rightPaneTab !== "emulator"}
          >
            <EmulatorPanel />
          </div>
          {assetManifest && bootstrap?.workspaceRoot ? (
            <div className="right-pane-section" hidden={rightPaneTab !== "assets"}>
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

function dedupeToolPlansLastWins(actions: ParsedAction[]): ParsedAction[] {
  const rev = [...actions].reverse();
  const seen = new Set<string>();
  const out: ParsedAction[] = [];
  for (const action of rev) {
    if (!action.isToolPlan) {
      continue;
    }
    const key = `${action.tool}\0${action.path ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(action);
  }
  out.reverse();
  return out;
}

/** Partial agent JSON while tokens arrive — avoid flashing the raw buffer as markdown. */
function textLooksLikeToolEnvelopeDraft(text: string): boolean {
  return text.includes("\"response\"") && (text.includes("\"tool\"") || text.includes("\"actions\""));
}

function AgentMarkdownBody({ source }: { source: string }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}

function AgentEntryContent({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const liveFormatted = formatAgentMessage(text);
  const leadText = liveFormatted.response || liveFormatted.narrative || "";
  const fileActions = liveFormatted.actions.filter((action) => action.isFileWrite);
  const planActions = dedupeToolPlansLastWins(liveFormatted.actions);
  const showRawMarkdownFallback =
    !leadText &&
    fileActions.length === 0 &&
    planActions.length === 0 &&
    (!isStreaming || !textLooksLikeToolEnvelopeDraft(text));

  return (
    <div className="entry-content">
      {leadText ? <AgentMarkdownBody source={leadText} /> : null}
      {planActions.length > 0 ? (
        <div className="entry-tool-plans" aria-label="Tool calls">
          {planActions.map((action, idx) => (
            <div key={`${action.tool}-${action.path ?? idx}`} className="entry-tool-plan">
              <code className="entry-tool-plan-name">{action.tool}</code>
              {action.path ? (
                <span className="entry-tool-plan-path">{action.path}</span>
              ) : (
                <span className="entry-tool-plan-path entry-tool-plan-path--muted">…</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {fileActions.map((action, idx) => (
        <div
          key={`${action.tool}-${action.path ?? idx}`}
          className={`entry-action${
            !isStreaming && typeof action.content === "string" ? " entry-action--final-diff" : ""
          }${
            isStreaming && typeof action.content === "string" && action.contentClosed !== true
              ? " entry-action--rolling-preview"
              : ""
          }`}
        >
          {isStreaming && typeof action.content === "string" && action.contentClosed !== true ? (
            <div className="rolling-preview">
              <pre className="entry-json">
                {getStreamingPreviewDiffLines(action)
                  .lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`)
                  .join("\n")}
              </pre>
            </div>
          ) : typeof action.content === "string" ? (
            <>
              {(() => {
                const diff = buildDiffLines(
                  action.previousContent ?? "",
                  action.content ?? "",
                  DIFF_MAX_LINES
                );
                const addCount = diff.lines.filter((l) => l.kind === "add").length;
                const removeCount = diff.lines.filter((l) => l.kind === "remove").length;
                const pathParts = action.path?.replace(/\\/g, "/").split("/");
                const fileLabel =
                  pathParts && pathParts.length > 0 ? pathParts[pathParts.length - 1]! : "file";
                const lang = languageFromPath(action.path);
                return (
                  <>
                    <div
                      className={`final-diff-card${isNewFileWrite(action) ? " final-diff-card--new-file" : ""}`}
                    >
                      <header className="final-diff-header">
                        <span className="final-diff-title">
                          <span className="final-diff-hash">#</span>
                          <span className="final-diff-filename">{fileLabel}</span>
                        </span>
                        <span className="final-diff-stats">
                          {addCount > 0 ? (
                            <span className="final-diff-stat final-diff-stat--add">+{addCount}</span>
                          ) : null}
                          {removeCount > 0 ? (
                            <span className="final-diff-stat final-diff-stat--remove">-{removeCount}</span>
                          ) : null}
                        </span>
                      </header>
                      <div className="final-diff-body">
                        {diff.lines.map((line, lineIdx) => (
                          <div
                            key={`${line.kind}-${lineIdx}`}
                            className={`final-diff-line final-diff-line--${line.kind}`}
                          >
                            <span className="final-diff-prefix">
                              {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                            </span>
                            <code
                              className="final-diff-code"
                              dangerouslySetInnerHTML={{
                                __html: highlightDiffLine(line.text, lang)
                              }}
                            />
                          </div>
                        ))}
                      </div>
                      <div className="final-diff-chevron" aria-hidden />
                    </div>
                    {diff.truncated ? (
                      <div className="diff-truncation">Additional changes not shown.</div>
                    ) : null}
                  </>
                );
              })()}
            </>
          ) : (
            <div className="entry-text">No file content provided.</div>
          )}
        </div>
      ))}
      {showRawMarkdownFallback ? <AgentMarkdownBody source={text} /> : null}
    </div>
  );
}
