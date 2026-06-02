import { describe, expect, it } from "vitest";
import type { AgentSessionTranscriptLine } from "../src/contracts";
import { transcriptLineToTimelineEntry } from "../../../apps/desktop/renderer/rawTimeline";

describe("transcript hydration parity", () => {
  it("maps assistant transcript lines to agent markdown entries", () => {
    const line: AgentSessionTranscriptLine = {
      kind: "assistant",
      at: 1,
      text: "**hello**"
    };
    const entry = transcriptLineToTimelineEntry(line, 0);
    expect(entry).toMatchObject({
      role: "agent",
      text: "**hello**"
    });
  });

  it("maps thinking transcript lines to collapsed thought entries", () => {
    const line: AgentSessionTranscriptLine = {
      kind: "thinking",
      at: 2,
      text: "reasoning body"
    };
    const entry = transcriptLineToTimelineEntry(line, 0);
    expect(entry).toMatchObject({
      role: "status",
      text: "Thought from transcript",
      reasoningMode: "summary",
      reasoningFullText: "reasoning body"
    });
  });

  it("maps tool_status transcript lines to parsed status metadata", () => {
    const line: AgentSessionTranscriptLine = {
      kind: "tool_status",
      at: 3,
      text:
        "Created main.py. @@tool_status_meta@@{\"callId\":\"c1\",\"toolName\":\"write_file\",\"phase\":\"result\",\"filePath\":\"main.py\",\"added\":10,\"deleted\":0}"
    };
    const entry = transcriptLineToTimelineEntry(line, 0);
    expect(entry).toMatchObject({
      role: "status",
      text: "Created main.py.",
      toolStatusMeta: {
        callId: "c1",
        toolName: "write_file",
        phase: "result",
        filePath: "main.py",
        added: 10,
        deleted: 0
      }
    });
  });
});
