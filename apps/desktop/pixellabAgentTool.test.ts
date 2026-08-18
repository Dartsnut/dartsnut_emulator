import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executePixelLabGenerationForAgent } from "./pixellabAgentTool";

function successfulFetch(assets: Array<{ mime_type: string; bytes: Buffer }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const isStart = String(input).endsWith("/generate");
    return new Response(JSON.stringify({
    code: 1001,
    data: isStart ? {
      generation_id: "12345678-abcd-4000-8000-123456789abc",
      status: "processing",
      operation: assets.length > 1 ? "animation" : "image",
      width: 64,
      height: 64,
      quota: { image_remaining: 20, animation_remaining: 10 }
    } : {
      generation_id: "12345678-abcd-4000-8000-123456789abc",
      status: "completed",
      operation: assets.length > 1 ? "animation" : "image",
      width: 64,
      height: 64,
      frame_count: assets.length > 1 ? assets.length : null,
      assets: assets.map((asset) => ({
        mime_type: asset.mime_type,
        data_base64: asset.bytes.toString("base64"),
        byte_length: asset.bytes.length
      })),
      quota: { image_remaining: 19, animation_remaining: 9 }
    }
  }), { status: isStart ? 202 : 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("PixelLab agent tool", () => {
  it("persists generated assets inside the workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pixellab-tool-"));
    const result = JSON.parse(await executePixelLabGenerationForAgent({
      args: { operation: "image", prompt: "tree", width: 64, height: 64 },
      workspacePath: workspace,
      baseApi: "https://api.dartsnut.test",
      token: "member-token",
      fetchImpl: successfulFetch([{ mime_type: "image/png", bytes: Buffer.from("png-data") }]),
      pollIntervalMs: 0, sleep: async () => {}
    }));
    expect(result.ok).toBe(true);
    expect(result.paths).toEqual(["assets/pixellab/image-12345678/image-01.png"]);
    expect(await fsp.readFile(path.join(workspace, result.paths[0]), "utf8")).toBe("png-data");
  });

  it("writes animation frames with stable numbered names", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pixellab-tool-"));
    const pngHeader = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(pngHeader);
    pngHeader.writeUInt32BE(64, 16);
    pngHeader.writeUInt32BE(64, 20);
    await fsp.writeFile(path.join(workspace, "hero.png"), pngHeader);
    const result = JSON.parse(await executePixelLabGenerationForAgent({
      args: {
        operation: "animation", prompt: "walk", width: 64, height: 64,
        reference_path: "hero.png", output_path: "assets/walk"
      },
      workspacePath: workspace,
      baseApi: "https://api.dartsnut.test",
      token: "member-token",
      fetchImpl: successfulFetch([
        { mime_type: "image/png", bytes: Buffer.from("frame-1") },
        { mime_type: "image/png", bytes: Buffer.from("frame-2") }
      ]),
      pollIntervalMs: 0, sleep: async () => {}
    }));
    expect(result.ok).toBe(true);
    expect(result.paths).toEqual(["assets/walk/frame-01.png", "assets/walk/frame-02.png"]);
  });

  it("rejects path traversal before calling the bridge", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pixellab-tool-"));
    let called = false;
    const result = JSON.parse(await executePixelLabGenerationForAgent({
      args: { operation: "image", prompt: "tree", width: 64, height: 64, output_path: "../outside.png" },
      workspacePath: workspace,
      baseApi: "https://api.dartsnut.test",
      token: "member-token",
      fetchImpl: (async () => { called = true; throw new Error("should not run"); }) as typeof fetch
    }));
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("returns auth failure without writing files", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pixellab-tool-"));
    const result = JSON.parse(await executePixelLabGenerationForAgent({
      args: { operation: "image", prompt: "tree", width: 64, height: 64 },
      workspacePath: workspace,
      baseApi: "https://api.dartsnut.test",
      token: "",
      fetchImpl: successfulFetch([])
    }));
    expect(result).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
  });

  it("returns resumable pending metadata without writing files", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pixellab-tool-"));
    const result = JSON.parse(await executePixelLabGenerationForAgent({
      args: { operation: "image", prompt: "tree", width: 64, height: 64 },
      workspacePath: workspace,
      baseApi: "https://api.dartsnut.test",
      token: "member-token",
      fetchImpl: successfulFetch([{ mime_type: "image/png", bytes: Buffer.from("png-data") }]),
      maxWaitMs: 0
    }));
    expect(result).toMatchObject({
      ok: false,
      code: "PIXELLAB_PENDING",
      generation_id: "12345678-abcd-4000-8000-123456789abc"
    });
    expect(await fsp.readdir(workspace)).toEqual([]);
  });

  it("resumes by generation id without reading generation inputs", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pixellab-tool-"));
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method || "GET") });
      return successfulFetch([{ mime_type: "image/png", bytes: Buffer.from("png-data") }])(input, init);
    }) as typeof fetch;
    const result = JSON.parse(await executePixelLabGenerationForAgent({
      args: { generation_id: "12345678-abcd-4000-8000-123456789abc" },
      workspacePath: workspace,
      baseApi: "https://api.dartsnut.test",
      token: "member-token",
      fetchImpl
    }));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });
});
