import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, BootstrapState } from "@dartsnut/shared-ipc";

interface TimelineEntry {
  id: string;
  role: "user" | "agent" | "status" | "error";
  text: string;
  targetText?: string;
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

const ROLLING_PREVIEW_LINES = 8;
const DIFF_MAX_LINES = 220;

function getRollingPreview(content: string, progressRatio: number): {
  lines: string[];
  truncated: boolean;
} {
  const safeRatio = Number.isFinite(progressRatio) ? Math.max(0, Math.min(1, progressRatio)) : 1;
  const visibleChars = Math.max(1, Math.floor(content.length * safeRatio));
  const partial = content.slice(0, visibleChars);
  const allLines = partial.split(/\r?\n/);
  const lines = allLines.slice(-ROLLING_PREVIEW_LINES);
  return {
    lines,
    truncated: allLines.length > lines.length
  };
}

function buildDiffLines(oldText: string, newText: string, maxLines: number): {
  lines: DiffLine[];
  truncated: boolean;
} {
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
    if (lines.length >= maxLines) {
      return { lines: lines.slice(0, maxLines), truncated: true };
    }
  }

  while (i < n && lines.length < maxLines) {
    lines.push({ kind: "remove", text: oldLines[i] });
    i += 1;
  }
  if (i < n) {
    return { lines: lines.slice(0, maxLines), truncated: true };
  }

  while (j < m && lines.length < maxLines) {
    lines.push({ kind: "add", text: newLines[j] });
    j += 1;
  }
  if (j < m) {
    return { lines: lines.slice(0, maxLines), truncated: true };
  }

  return { lines, truncated: false };
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

  return { narrative: text, response: null, actions: [] };
}

function toEntry(event: AgentEvent, seq: number): TimelineEntry {
  if (event.type === "final") {
    return { id: `${event.type}-${event.at}-${seq}`, role: "agent", text: "", targetText: event.content };
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
    const timer = window.setInterval(() => {
      setEntries((prev) => {
        let changed = false;
        const next = prev.map((entry) => {
          if (!entry.targetText || entry.text.length >= entry.targetText.length) {
            return entry;
          }
          changed = true;
          const nextLength = Math.min(entry.targetText.length, entry.text.length + 2);
          return {
            ...entry,
            text: entry.targetText.slice(0, nextLength),
            targetText: nextLength >= entry.targetText.length ? undefined : entry.targetText
          };
        });
        return changed ? next : prev;
      });
    }, 16);
    return () => window.clearInterval(timer);
  }, []);

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
                <AgentEntryContent text={entry.text} targetText={entry.targetText} />
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
      <aside className="right-blank" aria-hidden="true" />
    </main>
  );
}

function AgentEntryContent({ text, targetText }: { text: string; targetText?: string }) {
  const liveFormatted = formatAgentMessage(text);
  const sourceFormatted = targetText ? formatAgentMessage(targetText) : liveFormatted;
  const isStreaming = Boolean(targetText);
  const progressRatio = targetText ? text.length / Math.max(1, targetText.length) : 1;
  const leadText = sourceFormatted.response || liveFormatted.narrative || "";
  const fileActions = sourceFormatted.actions.filter((action) => action.isFileWrite);

  return (
    <div className="entry-content">
      {leadText ? <div className="entry-text">{leadText}</div> : null}
      {fileActions.map((action, idx) => (
        <div key={`${action.tool}-${action.path ?? idx}`} className="entry-action">
          {isStreaming ? (
            <div className="rolling-preview">
              <div className="entry-action-meta">streaming preview (latest lines)</div>
              <pre className="entry-json">
                {getRollingPreview(action.content ?? "", progressRatio).lines.join("\n")}
              </pre>
              {getRollingPreview(action.content ?? "", progressRatio).truncated ? (
                <div className="diff-truncation">older preview lines hidden</div>
              ) : null}
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
