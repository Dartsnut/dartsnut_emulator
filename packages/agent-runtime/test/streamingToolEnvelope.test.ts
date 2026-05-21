import { describe, expect, it } from "vitest";
import {
  buildStreamingFileToolEnvelope,
  parsePartialFileToolArguments
} from "../src/streamingToolEnvelope";
import type { ParsedToolCall } from "../src/providerClient";

describe("streamingToolEnvelope", () => {
  it("parses partial write_file content from incomplete arguments JSON", () => {
    const partial = parsePartialFileToolArguments(
      "write_file",
      '{"path":"main.py","content":"import os\\nprint('
    );
    expect(partial).toEqual({ path: "main.py", content: "import os\nprint(" });
  });

  it("builds a compact UI envelope for in-flight tool calls", () => {
    const toolCalls: ParsedToolCall[] = [
      {
        id: "call_1",
        name: "write_file",
        argumentsJson: '{"path":"hello.txt","content":"hello"}'
      }
    ];
    const envelope = buildStreamingFileToolEnvelope(toolCalls, "");
    expect(envelope).toContain('"tool":"write_file"');
    expect(envelope).toContain('"path":"hello.txt"');
    expect(envelope).toContain('"content":"hello"');
    expect(envelope).toContain("Writing file");
  });

  it("orders previousContent before content for stable streaming tails", () => {
    const toolCalls: ParsedToolCall[] = [
      {
        id: "call_1",
        name: "write_file",
        argumentsJson: '{"path":"main.py","content":"next"}'
      }
    ];
    const envelope = buildStreamingFileToolEnvelope(toolCalls, "", () => "old", {
      includePreviousContent: true
    });
    expect(envelope).toBeDefined();
    const contentIdx = envelope!.indexOf('"content"');
    const previousIdx = envelope!.indexOf('"previousContent"');
    expect(previousIdx).toBeGreaterThanOrEqual(0);
    expect(previousIdx).toBeLessThan(contentIdx);
  });
});
