import { describe, expect, it } from "vitest";
import {
  generatePixelLabAsset,
  getPixelLabGeneration,
  PixelLabBridgeError
} from "./pixellabBridge";

describe("PixelLab bridge", () => {
  it("sends only the community token to the Dartsnut bridge", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const isStart = String(input).endsWith("/generate");
      return new Response(JSON.stringify({
        code: 1001,
        data: isStart ? {
          generation_id: "generation-1",
          status: "processing",
          operation: "image",
          width: 64,
          height: 64,
          quota: { image_remaining: 20, animation_remaining: 10 }
        } : {
          generation_id: "generation-1",
          status: "completed",
          operation: "image",
          width: 64,
          height: 64,
          frame_count: null,
          assets: [{ mime_type: "image/png", data_base64: "YWJj", byte_length: 3 }],
          quota: { image_remaining: 19, animation_remaining: 10 }
        }
      }), { status: isStart ? 202 : 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await generatePixelLabAsset({
      baseApi: "https://api.dartsnut.com/",
      token: "member-secret",
      request: { operation: "image", description: "tree", width: 64, height: 64 },
      fetchImpl: fetchImpl as typeof fetch,
      pollIntervalMs: 0,
      sleep: async () => {}
    });
    expect(result.generation_id).toBe("generation-1");
    expect(calls[0].url).toBe("https://api.dartsnut.com/agent/pixellab/generate");
    expect(calls[1].url).toBe("https://api.dartsnut.com/agent/pixellab/generations/generation-1");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("token")).toBe("member-secret");
    expect(headers.get("source")).toBeTruthy();
    expect(JSON.stringify(calls[0])).not.toContain("PIXELLAB_API_KEY");
  });

  it("returns pending after the tool deadline and resumes without another POST", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const isStart = String(input).endsWith("/generate");
      return new Response(JSON.stringify({
        code: 1001,
        data: isStart ? {
          generation_id: "generation-2", status: "processing", operation: "image",
          width: 64, height: 64, quota: { image_remaining: 19, animation_remaining: 10 }
        } : {
          generation_id: "generation-2", status: "completed", operation: "image",
          width: 64, height: 64, frame_count: null,
          assets: [{ mime_type: "image/png", data_base64: "YWJj", byte_length: 3 }],
          quota: { image_remaining: 19, animation_remaining: 10 }
        }
      }), { status: isStart ? 202 : 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const pending = await generatePixelLabAsset({
      baseApi: "https://api.dartsnut.com", token: "member-secret",
      request: { operation: "image", description: "tree", width: 64, height: 64 },
      fetchImpl, maxWaitMs: 0
    });
    expect(pending.status).toBe("processing");
    const completed = await generatePixelLabAsset({
      baseApi: "https://api.dartsnut.com", token: "member-secret",
      generationId: pending.generation_id, fetchImpl
    });
    expect(completed.status).toBe("completed");
    expect(calls.filter((url) => url.endsWith("/generate"))).toHaveLength(1);
  });

  it("maps stable quota failures", async () => {
    await expect(generatePixelLabAsset({
      baseApi: "https://api.dartsnut.com",
      token: "member-secret",
      request: { operation: "image", description: "tree", width: 64, height: 64 },
      fetchImpl: async () => new Response(JSON.stringify({
        code: 429,
        error: "IMAGE_QUOTA_EXCEEDED",
        desc: "Daily PixelLab image limit reached."
      }), { status: 429, headers: { "Content-Type": "application/json" } })
    })).rejects.toMatchObject<Partial<PixelLabBridgeError>>({
      code: "IMAGE_QUOTA_EXCEEDED",
      status: 429
    });
  });

  it("rejects malformed status responses", async () => {
    await expect(getPixelLabGeneration({
      baseApi: "https://api.dartsnut.com",
      token: "member-secret",
      generationId: "generation-1",
      fetchImpl: async () => new Response(JSON.stringify({
        code: 1001,
        data: { generation_id: "generation-1", status: "mystery" }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    })).rejects.toMatchObject<Partial<PixelLabBridgeError>>({ code: "PIXELLAB_PROTOCOL_ERROR" });
  });
});
