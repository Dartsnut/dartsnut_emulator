import { useEffect, useMemo, useState } from "react";
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
  actions: Array<{
    tool: string;
    path?: string;
    content?: string;
    raw: string;
  }>;
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
        actions?: Array<{ tool?: string; path?: string; content?: string }>;
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

function toEntry(event: AgentEvent): TimelineEntry {
  if (event.type === "final") {
    return { id: `${event.type}-${event.at}`, role: "agent", text: "", targetText: event.content };
  }
  if (event.type === "error") {
    return { id: `${event.type}-${event.at}`, role: "error", text: event.message };
  }
  return { id: `${event.type}-${event.at}`, role: "status", text: event.message };
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const api = window.dartsnutApi;

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
      setEntries((prev) => [...prev, toEntry(event)]);
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
    setSending(true);
    if (!api) {
      setSending(false);
      return;
    }

    await api.sendPrompt(current);
    const refreshed = await api.getBootstrapState();
    setBootstrap(refreshed);
    setSending(false);
  }

  return (
    <main className="layout">
      <header>
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
            <strong>{entry.role}</strong>:
            {entry.role === "agent" ? (
              <AgentEntryContent text={entry.text} />
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
    </main>
  );
}

function AgentEntryContent({ text }: { text: string }) {
  const formatted = formatAgentMessage(text);
  return (
    <div className="entry-content">
      {formatted.narrative ? <div className="entry-text">{formatted.narrative}</div> : null}
      {formatted.response ? (
        <div className="entry-action">
          <div className="entry-action-title">response</div>
          <pre className="entry-json">{formatted.response}</pre>
        </div>
      ) : null}
      {formatted.actions.map((action, idx) => (
        <div key={`${action.tool}-${action.path ?? idx}`} className="entry-action">
          <div className="entry-action-title">{`action ${idx + 1}: ${action.tool}`}</div>
          {action.path ? <div className="entry-action-meta">{`path: ${action.path}`}</div> : null}
          {typeof action.content === "string" ? (
            <pre className="entry-json">{action.content}</pre>
          ) : (
            <pre className="entry-json">{action.raw}</pre>
          )}
        </div>
      ))}
      {!formatted.narrative && !formatted.response && formatted.actions.length === 0 ? (
        <div className="entry-text">{text}</div>
      ) : null}
    </div>
  );
}
