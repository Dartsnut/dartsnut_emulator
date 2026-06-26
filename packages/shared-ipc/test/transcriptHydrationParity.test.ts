import { describe, expect, it } from "vitest";
import type { AgentSessionTranscriptLine } from "../src/contracts";
import { mergeTimelineSkillStatusEntry, transcriptLineToTimelineEntry } from "../../../apps/desktop/renderer/rawTimeline";

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

  it("maps persisted Dartsnut skill tool statuses with skill metadata", () => {
    const line: AgentSessionTranscriptLine = {
      kind: "tool_status",
      at: 4,
      text:
        "Loaded Dartsnut skill. @@tool_status_meta@@{\"callId\":\"c2\",\"toolName\":\"get_dartsnut_skill\",\"phase\":\"result\",\"skillId\":\"conf-contract\"}"
    };

    expect(transcriptLineToTimelineEntry(line, 0)).toMatchObject({
      role: "status",
      text: "Loaded Dartsnut skill.",
      toolStatusMeta: {
        toolName: "get_dartsnut_skill",
        phase: "result",
        skillId: "conf-contract"
      }
    });
  });

  it("hides persisted internal agent lifecycle statuses", () => {
    const startedLine: AgentSessionTranscriptLine = {
      kind: "tool_status",
      at: 5,
      text: "Dartsnut Agent run started."
    };
    const agentLine: AgentSessionTranscriptLine = {
      kind: "tool_status",
      at: 6,
      text: "Agent: DartsnutAgent"
    };

    expect(transcriptLineToTimelineEntry(startedLine, 0)).toBeNull();
    expect(transcriptLineToTimelineEntry(agentLine, 1)).toBeNull();
  });

  it("merges Dartsnut skill status entries into one summary line", () => {
    const first = transcriptLineToTimelineEntry(
      {
        kind: "tool_status",
        at: 7,
        text:
          "Loaded Dartsnut skill. @@tool_status_meta@@{\"callId\":\"c3\",\"toolName\":\"get_dartsnut_skill\",\"phase\":\"result\",\"skillId\":\"conf-contract\"}"
      },
      0
    );
    const second = transcriptLineToTimelineEntry(
      {
        kind: "tool_status",
        at: 8,
        text:
          "Loaded Dartsnut skill. @@tool_status_meta@@{\"callId\":\"c4\",\"toolName\":\"get_dartsnut_skill\",\"phase\":\"result\",\"skillId\":\"pydartsnut-core\"}"
      },
      1
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const merged = mergeTimelineSkillStatusEntry(first!, second!);

    expect(merged).toMatchObject({
      text: "Loaded skills: conf-contract, pydartsnut-core",
      toolStatusMeta: {
        toolName: "get_dartsnut_skill",
        phase: "result",
        skillIds: ["conf-contract", "pydartsnut-core"]
      }
    });
  });
});
