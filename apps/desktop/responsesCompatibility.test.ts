import { describe, expect, it } from "vitest";
import { isPoloAiUrl, normalizePoloAiResponse, normalizePoloAiTerminalPayload } from "./responsesCompatibility";

describe("PoloAI Responses compatibility", () => {
  it("normalizes invalid output statuses for poloai terminal payloads", () => {
    const input = {
      type: "response.completed",
      response: {
        output: [
          { type: "message", status: "finished" },
          { type: "function_call", status: "done" },
          { type: "message", status: "completed" }
        ]
      }
    };
    expect(isPoloAiUrl("https://poloai.top/v1/responses")).toBe(true);
    expect(isPoloAiUrl("https://api.openai.com/v1/responses")).toBe(false);
    expect(normalizePoloAiTerminalPayload(input)).toEqual({
      payload: {
        type: "response.completed",
        response: {
          output: [
            { type: "message", status: "completed" },
            { type: "function_call", status: "completed" },
            { type: "message", status: "completed" }
          ]
        }
      },
      normalizedCount: 2
    });
  });

  it("uses incomplete status for invalid output in an incomplete response", () => {
    const input = {
      type: "response.incomplete",
      response: { output: [{ type: "message", status: null }] }
    };
    expect(normalizePoloAiTerminalPayload(input)).toEqual({
      payload: { type: "response.incomplete", response: { output: [{ type: "message", status: "incomplete" }] } },
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
