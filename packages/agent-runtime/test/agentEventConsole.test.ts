import type { AgentEvent } from "@dartsnut/shared-ipc";
import { describe, expect, it } from "vitest";
import {
  formatAgentEventForConsole,
  isStructuredAgentEnvelopeText,
  summarizeAgentTextForConsole
} from "../../../apps/desktop/agentEventConsole";

describe("agentEventConsole", () => {
  it("formats final agent events into readable console lines", () => {
    const event: AgentEvent = {
      type: "final",
      at: 1,
      content: JSON.stringify({
        response: "Created the file.",
        actions: [
          { tool: "read_file", path: "src/App.tsx" },
          { tool: "write_file", path: "src/App.tsx", content: "updated" }
        ]
      })
    };

    expect(formatAgentEventForConsole(event)).toEqual({
      level: "info",
      lines: ["Created the file.", "[read_file] src/App.tsx", "[write_file] src/App.tsx"]
    });
  });

  it("summarizes structured envelopes without returning raw JSON", () => {
    expect(
      summarizeAgentTextForConsole(
        JSON.stringify({
          response: "",
          actions: [{ tool: "write_file", path: "hello.txt", content: "hello" }]
        })
      )
    ).toEqual(["[write_file] hello.txt"]);
  });

  it("detects structured envelopes and ignores plain text", () => {
    expect(isStructuredAgentEnvelopeText('{"response":"Hello","actions":[]}')).toBe(true);
    expect(isStructuredAgentEnvelopeText("Working on it.")).toBe(false);
  });
});
