import type { AgentEvent } from "@dartsnut/shared-ipc";
import { describe, expect, it } from "vitest";
import { formatAgentEventForConsole } from "../../../apps/desktop/agentEventConsole";

describe("agentEventConsole", () => {
  it("formats events as raw JSON lines", () => {
    const event: AgentEvent = {
      type: "final",
      at: 1,
      content: "Created file"
    };

    expect(formatAgentEventForConsole(event)).toEqual({
      level: "debug",
      lines: ['{', '  "type": "final",', '  "at": 1,', '  "content": "Created file"', '}']
    });
  });

  it("uses error level for error events", () => {
    const event: AgentEvent = {
      type: "error",
      at: 1,
      message: "failed"
    };

    expect(formatAgentEventForConsole(event)?.level).toBe("error");
  });
});
