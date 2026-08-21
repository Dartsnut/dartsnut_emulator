import fsp from "node:fs/promises";
import path from "node:path";
import { WorkspacePolicy } from "@dartsnut/agent-runtime";
import {
  generatePixelLabAsset,
  PixelLabBridgeError,
  type PixelLabBridgeAsset,
  type PixelLabGenerateRequest,
  type PixelLabOperation
} from "./pixellabBridge";

type FetchLike = typeof fetch;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp"
};

function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function imageInfo(bytes: Buffer): { mime: "image/png" | "image/jpeg"; width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mime: "image/jpeg", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  throw new Error("reference_path must be a readable PNG or JPEG image.");
}

function outputPaths(
  policy: WorkspacePolicy,
  operation: PixelLabOperation,
  generationId: string,
  requestedPath: string | undefined,
  assets: PixelLabBridgeAsset[]
): Array<{ absolute: string; relative: string; bytes: Buffer }> {
  const fallbackDir = `assets/pixellab/${operation}-${generationId.slice(0, 8)}`;
  const destination = String(requestedPath || fallbackDir).trim().replace(/\\/g, "/");
  const requestedExt = path.posix.extname(destination).toLowerCase();
  const looksLikeFile = Boolean(MIME_EXTENSIONS[assets[0]?.mime_type]) && Object.values(MIME_EXTENSIONS).includes(requestedExt);
  return assets.map((asset, index) => {
    const extension = MIME_EXTENSIONS[asset.mime_type];
    if (!extension) throw new Error(`Unsupported PixelLab asset type: ${asset.mime_type}`);
    const bytes = Buffer.from(asset.data_base64, "base64");
    if (bytes.length === 0 || bytes.length !== Number(asset.byte_length)) {
      throw new Error("PixelLab bridge returned invalid asset bytes.");
    }
    let relative: string;
    if (looksLikeFile) {
      const stem = destination.slice(0, -requestedExt.length);
      relative = index === 0 ? destination : `${stem}-${String(index + 1).padStart(2, "0")}${extension}`;
    } else {
      const prefix = operation === "animation" ? "frame" : "image";
      relative = path.posix.join(destination, `${prefix}-${String(index + 1).padStart(2, "0")}${extension}`);
    }
    const absolute = policy.resolveWithinRoot(relative);
    return { absolute, relative, bytes };
  });
}

export async function executePixelLabGenerationForAgent(options: {
  args: Record<string, unknown>;
  workspacePath: string;
  baseApi: string;
  token: string;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<string> {
  try {
    const policy = new WorkspacePolicy(options.workspacePath);
    const requestedOutputPath = typeof options.args.output_path === "string"
      ? options.args.output_path.trim()
      : undefined;
    if (requestedOutputPath) policy.resolveWithinRoot(requestedOutputPath);
    const generationId = String(options.args.generation_id || "").trim();
    let request: PixelLabGenerateRequest | undefined;
    if (!generationId) {
      const operation = String(options.args.operation || "") as PixelLabOperation;
      if (operation !== "image" && operation !== "animation") throw new Error("operation must be image or animation.");
      const prompt = String(options.args.prompt || "").trim();
      if (!prompt) throw new Error("prompt is required.");
      const width = positiveInteger(options.args.width, "width");
      const height = positiveInteger(options.args.height, "height");
      request = {
        operation,
        width,
        height,
        no_background: options.args.no_background !== false
      };
      if (typeof options.args.seed === "number") request.seed = options.args.seed;
      if (operation === "image") {
        request.description = prompt;
      } else {
        const referencePath = String(options.args.reference_path || "").trim();
        if (!referencePath) throw new Error("reference_path is required for animation.");
        const referenceBytes = await fsp.readFile(policy.resolveWithinRoot(referencePath));
        const info = imageInfo(referenceBytes);
        request.action = prompt;
        request.reference_image = `data:${info.mime};base64,${referenceBytes.toString("base64")}`;
        request.reference_width = info.width;
        request.reference_height = info.height;
        request.view = String(options.args.view || "none") as PixelLabGenerateRequest["view"];
        request.direction = String(options.args.direction || "none") as PixelLabGenerateRequest["direction"];
      }
    }
    const result = await generatePixelLabAsset({
      baseApi: options.baseApi,
      token: options.token,
      request,
      generationId: generationId || undefined,
      fetchImpl: options.fetchImpl,
      pollIntervalMs: options.pollIntervalMs,
      maxWaitMs: options.maxWaitMs,
      sleep: options.sleep,
      now: options.now
    });
    if (result.status === "processing") {
      return JSON.stringify({
        ok: false,
        code: "PIXELLAB_PENDING",
        error: "PixelLab generation is still processing. Resume with this generation_id.",
        generation_id: result.generation_id,
        operation: result.operation,
        width: result.width,
        height: result.height,
        quota: result.quota
      });
    }
    const files = outputPaths(
      policy,
      result.operation,
      result.generation_id,
      requestedOutputPath,
      result.assets
    );
    if (options.args.overwrite !== true) {
      for (const file of files) {
        try {
          await fsp.access(file.absolute);
          throw new Error(`Destination already exists: ${file.relative}. Set overwrite=true to replace it.`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    for (const file of files) {
      await fsp.mkdir(path.dirname(file.absolute), { recursive: true });
      await fsp.writeFile(file.absolute, file.bytes);
    }
    return JSON.stringify({
      ok: true,
      generation_id: result.generation_id,
      operation: result.operation,
      width: result.width,
      height: result.height,
      frame_count: result.frame_count,
      paths: files.map((file) => file.relative),
      quota: result.quota
    });
  } catch (error) {
    const code = error instanceof PixelLabBridgeError ? error.code : "PIXELLAB_TOOL_ERROR";
    return JSON.stringify({ ok: false, code, error: error instanceof Error ? error.message : String(error) });
  }
}
