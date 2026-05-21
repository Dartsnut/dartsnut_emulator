import { describe, expect, it } from "vitest";
import { TOOL_ENVELOPE_STREAM_REPLACE } from "@dartsnut/shared-ipc";
import { applyStreamDeltaToEntryText } from "./applyStreamDelta";

describe("applyStreamDeltaToEntryText", () => {
  it("appends plain assistant text", () => {
    expect(applyStreamDeltaToEntryText("Hello", " world")).toBe("Hello world");
  });

  it("replaces tool envelope tail when previousContent is inserted", () => {
    const first = `${TOOL_ENVELOPE_STREAM_REPLACE}{"response":"Writing file…","actions":[{"tool":"write_file","path":"main.py","content":"a"`;
    let text = applyStreamDeltaToEntryText("", first);
    const second = `${TOOL_ENVELOPE_STREAM_REPLACE}{"response":"Writing file…","actions":[{"tool":"write_file","path":"main.py","previousContent":"old","content":"ab"`;
    text = applyStreamDeltaToEntryText(text, second);
    expect(text).toContain('"previousContent":"old"');
    expect(text).toContain('"content":"ab"');
    expect(text).not.toContain(TOOL_ENVELOPE_STREAM_REPLACE);
    expect(text.match(/"content":"a"/g)?.length ?? 0).toBe(0);
  });

  it("keeps narrative lead before the envelope", () => {
    const text = applyStreamDeltaToEntryText(
      "Planning the widget.\n\n",
      `${TOOL_ENVELOPE_STREAM_REPLACE}{"response":"Writing file…","actions":[{"tool":"write_file","path":"x.py","content":"1"}]}`
    );
    expect(text.startsWith("Planning the widget.")).toBe(true);
    expect(text).toContain('"path":"x.py"');
  });
});
