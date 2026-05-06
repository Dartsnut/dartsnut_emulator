import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, BootstrapState } from "@dartsnut/shared-ipc";
import { EmulatorPanel } from "./EmulatorPanel";

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
  previousContent?: string;
  isFileWrite: boolean;
    raw: string;
}

interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
}

const STREAM_PREVIEW_LINES = 8;
const DIFF_MAX_LINES = 220;
const DIFF_CONTEXT_LINES = 3;

function getLatestPreviewLines(content: string): { lines: string[]; truncated: boolean } {
  const allLines = content.split(/\r?\n/);
  const lines = allLines.slice(-STREAM_PREVIEW_LINES);
  return {
    lines,
    truncated: allLines.length > lines.length
  };
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
  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }

  const changeIdxs: number[] = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].kind !== "context") {
      changeIdxs.push(idx);
    }
  }

  if (changeIdxs.length === 0) {
    return {
      lines: lines.slice(0, maxLines),
      truncated: true
    };
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

  const out: DiffLine[] = [];
  for (let w = 0; w < merged.length; w += 1) {
    const window = merged[w];
    if (w > 0 && merged[w - 1].end + 1 < window.start) {
      out.push({ kind: "context", text: "..." });
    }
    for (let i = window.start; i <= window.end; i += 1) {
      out.push(lines[i]);
    }
  }

  if (out.length <= maxLines) {
    return { lines: out, truncated: true };
  }

  return { lines: out.slice(0, maxLines), truncated: true };
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
    return { value: input.slice(startQuoteIdx + 1), nextIndex: input.length, closed: false };
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
    const tool = parseJsonStringValue(text, toolQuote).value;
    scanFrom = toolQuote + 1;
    if (tool !== "write_file") {
      continue;
    }

    const pathKey = text.indexOf("\"path\"", toolKey);
    let pathValue: string | undefined;
    if (pathKey >= 0) {
      const pathQuote = text.indexOf("\"", text.indexOf(":", pathKey));
      if (pathQuote >= 0) {
        pathValue = parseJsonStringValue(text, pathQuote).value;
      }
    }

    const contentKey = text.indexOf("\"content\"", toolKey);
    if (contentKey < 0) {
      continue;
    }
    const contentQuote = text.indexOf("\"", text.indexOf(":", contentKey));
    if (contentQuote < 0) {
      continue;
    }
    const contentValue = parseJsonStringValue(text, contentQuote).value;
    actions.push({
      tool: "write_file",
      path: pathValue,
      content: contentValue,
      isFileWrite: true,
      raw: ""
    });
    scanFrom = contentQuote + 1;
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
              content: action.content,
              previousContent:
                action.previousContent ?? action.originalContent ?? action.beforeContent,
              isFileWrite: action.tool === "write_file" && typeof action.content === "string",
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
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const pendingReplyIdRef = useRef<string | null>(null);
  const eventSeqRef = useRef(0);
  const activeStreamEntryIdRef = useRef<string | null>(null);

  const api = window.dartsnutApi;

  function clearPendingReplyIndicator() {
    const pendingId = pendingReplyIdRef.current;
    if (!pendingId) {
      return;
    }
    setEntries((prev) => prev.filter((entry) => entry.id !== pendingId));
    pendingReplyIdRef.current = null;
  }

  useEffect(() => {
    if (!api) {
      setRuntimeError("Desktop bridge is unavailable. Please restart the app.");
      return;
    }

    api.getBootstrapState().then(setBootstrap).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Failed to load bootstrap state.";
      setRuntimeError(message);
    });
    const unsubscribe = api.onAgentEvent((event) => {
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
        setEntries((prev) =>
          prev.map((entry) =>
            entry.id === streamId ? { ...entry, text: entry.text + event.delta, streaming: true } : entry
          )
        );
        return;
      }

      if (event.type === "final" && activeStreamEntryIdRef.current) {
        const streamId = activeStreamEntryIdRef.current;
        activeStreamEntryIdRef.current = null;
        setEntries((prev) =>
          prev.map((entry) =>
            entry.id === streamId ? { ...entry, text: event.content, streaming: false } : entry
          )
        );
        return;
      }

      const seq = eventSeqRef.current;
      eventSeqRef.current += 1;
      setEntries((prev) => [...prev, toEntry(event, seq)]);
    });
    return unsubscribe;
  }, [api]);

  const chatDisabled = useMemo(() => {
    if (!bootstrap) {
      return true;
    }
    return !bootstrap.workspaceRoot || bootstrap.providerStatus !== "ready" || sending;
  }, [bootstrap, sending]);

  async function handlePickWorkspace() {
    if (!api) {
      return;
    }
    const updated = await api.pickWorkspace();
    setBootstrap(updated);
  }

  async function handleSend() {
    if (!prompt.trim() || chatDisabled) {
      return;
    }
    const current = prompt.trim();
    setPrompt("");
    setEntries((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", text: current }]);
    const pendingReplyId = `agent-pending-${Date.now()}`;
    pendingReplyIdRef.current = pendingReplyId;
    setEntries((prev) => [
      ...prev,
      { id: pendingReplyId, role: "status", text: "Agent is thinking..." }
    ]);
    setSending(true);
    if (!api) {
      clearPendingReplyIndicator();
      setSending(false);
      return;
    }

    await api.sendPrompt(current);
    clearPendingReplyIndicator();
    const refreshed = await api.getBootstrapState();
    setBootstrap(refreshed);
    setSending(false);
  }

  return (
    <main className="app-shell">
      <section className="left-rail">
        <header className="app-header">
          <h1>Dartsnut Agent</h1>
          <p>Embedded coding assistant for pygame + pydartsnut applications.</p>
        </header>

        <section className="setup">
          {runtimeError ? <div className="runtime-error">{runtimeError}</div> : null}
          <button onClick={handlePickWorkspace}>Choose Workspace Folder</button>
          <div>Workspace: {bootstrap?.workspaceRoot ?? "Not selected"}</div>
          <div>Provider: {bootstrap?.providerStatus ?? "loading"}</div>
          <div>First-run proof: {bootstrap?.firstRunComplete ? "complete" : "pending"}</div>
        </section>

        <section className="timeline">
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
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask the agent to create or modify a Dartsnut app..."
          />
          <button disabled={chatDisabled} onClick={handleSend}>
            {sending ? "Running..." : "Send"}
          </button>
        </section>
      </section>
      <aside className="right-pane">
        <EmulatorPanel />
      </aside>
    </main>
  );
}

function AgentEntryContent({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const liveFormatted = formatAgentMessage(text);
  const leadText = liveFormatted.response || liveFormatted.narrative || "";
  const fileActions = liveFormatted.actions.filter((action) => action.isFileWrite);

  return (
    <div className="entry-content">
      {leadText ? <div className="entry-text">{leadText}</div> : null}
      {fileActions.map((action, idx) => (
        <div key={`${action.tool}-${action.path ?? idx}`} className="entry-action">
          {isStreaming && typeof action.content === "string" ? (
            <div className="rolling-preview">
              <pre className="entry-json">{getLatestPreviewLines(action.content).lines.join("\n")}</pre>
            </div>
          ) : typeof action.content === "string" ? (
            <div className="diff-view">
              <div className="entry-action-meta">final diff</div>
              {(() => {
                const diff = buildDiffLines(
                  action.previousContent ?? "",
                  action.content ?? "",
                  DIFF_MAX_LINES
                );
                return (
                  <>
                    <pre className="entry-json diff-json">
                      {diff.lines.map((line, lineIdx) => (
                        <div key={`${line.kind}-${lineIdx}`} className={`diff-line ${line.kind}`}>
                          <span className="diff-prefix">
                            {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                          </span>
                          <span>{line.text}</span>
                        </div>
                      ))}
                    </pre>
                    {!action.previousContent ? (
                      <div className="diff-truncation">previous file snapshot unavailable</div>
                    ) : null}
                    {diff.truncated ? (
                      <div className="diff-truncation">diff truncated to the latest visible lines</div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          ) : (
            <div className="entry-text">No file content provided.</div>
          )}
        </div>
      ))}
      {!leadText && fileActions.length === 0 ? (
        <div className="entry-text">{text}</div>
      ) : null}
    </div>
  );
}
