import { describe, expect, it } from "vitest";
import { TOOL_ENVELOPE_STREAM_REPLACE } from "@dartsnut/shared-ipc";
import {
  entryTextHasFileWriteActions,
  mergeAgentStreamEntryOnFinal,
  shouldClearFileWritePreviewOnStatus,
  shouldShowFileEditSummary,
  shouldShowRollingFilePreview
} from "../../../apps/desktop/renderer/fileWritePreviewPhase";

describe("fileWritePreviewPhase (renderer helpers)", () => {
  it("detects write_file and replace_in_file envelopes", () => {
    const envelope = JSON.stringify({
      response: "Writing file…",
      actions: [{ tool: "write_file", path: "main.py", content: "x" }]
    });
    expect(entryTextHasFileWriteActions(envelope)).toBe(true);
    expect(entryTextHasFileWriteActions('{"response":"Hi","actions":[]}')).toBe(false);
  });

  it("shows rolling preview while fileWritePreview is true even when not streaming", () => {
    expect(
      shouldShowRollingFilePreview({
        isStreaming: false,
        fileWritePreview: true,
        hasPreviewBody: true,
        hasPath: true
      })
    ).toBe(true);
    expect(
      shouldShowRollingFilePreview({
        isStreaming: false,
        fileWritePreview: false,
        hasPreviewBody: true,
        hasPath: true
      })
    ).toBe(false);
  });

  it("defers file summary until preview phase ends", () => {
    expect(
      shouldShowFileEditSummary({
        isStreaming: false,
        fileWritePreview: true,
        hasContent: true
      })
    ).toBe(false);
    expect(
      shouldShowFileEditSummary({
        isStreaming: false,
        fileWritePreview: false,
        hasContent: true
      })
    ).toBe(true);
  });

  it("clears preview on native file tool status lines", () => {
    expect(shouldClearFileWritePreviewOnStatus("Ran write file main.py")).toBe(true);
    expect(shouldClearFileWritePreviewOnStatus("Ran read file main.py")).toBe(false);
  });
});

describe("mergeAgentStreamEntryOnFinal", () => {
  it("applies pending envelope before empty final (large write_file payloads)", () => {
    const lead = "现在创建 main.py：\n\n";
    const envelope = `${TOOL_ENVELOPE_STREAM_REPLACE}${JSON.stringify({
      response: "Writing file…",
      actions: [{ tool: "write_file", path: "main.py", content: "x".repeat(4000) }]
    })}`;
    const merged = mergeAgentStreamEntryOnFinal(lead, envelope, "");
    expect(merged.fileWritePreview).toBe(true);
    expect(merged.text.startsWith(lead.trim())).toBe(true);
    expect(merged.text).toContain('"path":"main.py"');
    expect(merged.text).toContain("x".repeat(4000));
    expect(
      shouldShowRollingFilePreview({
        isStreaming: false,
        fileWritePreview: merged.fileWritePreview,
        hasPreviewBody: true,
        hasPath: true
      })
    ).toBe(true);
  });
});

describe("applyStreamDelta (desktop renderer)", () => {
  it("re-exports envelope replace behavior for preview integration", async () => {
    const { applyStreamDeltaToEntryText } = await import(
      "../../../apps/desktop/renderer/applyStreamDelta"
    );
    const first = `${TOOL_ENVELOPE_STREAM_REPLACE}{"response":"Writing file…","actions":[{"tool":"write_file","path":"main.py","content":"line1"`;
    let text = applyStreamDeltaToEntryText("", first);
    const second = `${TOOL_ENVELOPE_STREAM_REPLACE}{"response":"Writing file…","actions":[{"tool":"write_file","path":"main.py","content":"line1\\nline2"}]}`;
    text = applyStreamDeltaToEntryText(text, second);
    expect(entryTextHasFileWriteActions(text)).toBe(true);
    expect(text).toContain('"content":"line1\\nline2"');
  });
});
