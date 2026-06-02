import type { AgentEvent } from "@dartsnut/shared-ipc";

export function formatAgentEventForConsole(
  event: AgentEvent
): { level: "debug" | "info" | "warn" | "error"; lines: string[] } | null {
  const json = JSON.stringify(event, null, 2);
  if (!json.trim()) {
    return null;
  }
  const level = event.type === "error" ? "error" : event.type === "status" ? "info" : "debug";
  return { level, lines: json.split("\n") };
}
