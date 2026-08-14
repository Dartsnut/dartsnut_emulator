import { describe, expect, it } from "vitest";
import { isPoloAiUrl, normalizePoloAiResponse, normalizePoloAiTerminalPayload } from "./responsesCompatibility";

describe("PoloAI Responses compatibility", () => {
  it("normalizes finished only for poloai terminal payloads", () => {
    const input = {
      type: "response.completed",
      response: { output: [{ type: "message", status: "finished" }] }
    };
    expect(isPoloAiUrl("https://poloai.top/v1/responses")).toBe(true);
    expect(isPoloAiUrl("https://api.openai.com/v1/responses")).toBe(false);
    expect(normalizePoloAiTerminalPayload(input)).toEqual({
      payload: { type: "response.completed", response: { output: [{ type: "message", status: "completed" }] } },
      normalizedCount: 1
    });
  });

  it("rewrites streamed terminal records and preserves other events", async () => {
    const body = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","status":"finished"}]}}\n\n'
    ].join("");
    const response = normalizePoloAiResponse(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }), "https://poloai.top/v1/responses");
    const text = await response.text();
    expect(text).toContain('"delta":"Hi"');
    expect(text).toContain('"status":"completed"');
    expect(text).not.toContain('"status":"finished"');
  });
});
