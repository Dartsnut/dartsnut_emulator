import { withDartsnutSourceHeader } from "./dartsnutSourceHeader";

export type PixelLabOperation = "image" | "animation";

export type PixelLabGenerateRequest = {
  operation: PixelLabOperation;
  description?: string;
  action?: string;
  width: number;
  height: number;
  reference_image?: string;
  reference_width?: number;
  reference_height?: number;
  seed?: number;
  no_background?: boolean;
  view?: "none" | "low top-down" | "high top-down" | "side";
  direction?: "none" | "south" | "east" | "west" | "north" | "south-east" | "south-west" | "north-east" | "north-west";
};

export type PixelLabBridgeAsset = {
  mime_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data_base64: string;
  byte_length: number;
};

export type PixelLabQuota = {
  usage_date: string;
  image_count: number;
  animation_count: number;
  image_limit: number;
  animation_limit: number;
  image_remaining: number;
  animation_remaining: number;
};

export type PixelLabBridgeResult = {
  generation_id: string;
  status: "completed";
  operation: PixelLabOperation;
  width: number;
  height: number;
  frame_count: number | null;
  assets: PixelLabBridgeAsset[];
  quota: PixelLabQuota;
};

export type PixelLabPendingResult = {
  generation_id: string;
  status: "processing";
  operation: PixelLabOperation;
  width: number;
  height: number;
  poll_after_ms: number;
  quota: PixelLabQuota;
};

export type PixelLabGenerationResult = PixelLabBridgeResult | PixelLabPendingResult;

export class PixelLabBridgeError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

type FetchLike = typeof fetch;

export const PIXELLAB_POLL_INTERVAL_MS = 5_000;
export const PIXELLAB_TOOL_MAX_WAIT_MS = 10 * 60_000;

function bridgeRoot(baseApi: string): string {
  return `${baseApi.trim().replace(/\/+$/, "")}/agent/pixellab`;
}

function envelopeMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const row = value as { desc?: unknown; msg?: unknown; message?: unknown };
  return String(row.desc || row.msg || row.message || "").trim();
}

async function bridgeJson(options: {
  url: string;
  token: string;
  init?: RequestInit;
  fetchImpl?: FetchLike;
}): Promise<{ response: Response; data: unknown }> {
  const token = options.token.trim();
  if (!token) throw new PixelLabBridgeError("AUTH_REQUIRED", "Sign in to use PixelLab generation.", 401);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.url, withDartsnutSourceHeader(options.url, {
      ...options.init,
      headers: {
        token,
        Accept: "application/json",
        ...options.init?.headers
      }
    }));
  } catch {
    throw new PixelLabBridgeError(
      "PIXELLAB_UNAVAILABLE",
      "Couldn’t reach the Dartsnut PixelLab bridge. Check your network and try again.",
      503
    );
  }
  const parsed = await response.json().catch(() => null) as {
    code?: unknown;
    error?: unknown;
    data?: unknown;
  } | null;
  if ((!response.ok && response.status !== 202) || Number(parsed?.code) !== 1001) {
    throw new PixelLabBridgeError(
      String(parsed?.error || "PIXELLAB_UNAVAILABLE"),
      envelopeMessage(parsed) || "PixelLab generation failed.",
      response.status
    );
  }
  if (!parsed?.data || typeof parsed.data !== "object") {
    throw new PixelLabBridgeError("PIXELLAB_PROTOCOL_ERROR", "PixelLab bridge returned an invalid response.", 502);
  }
  return { response, data: parsed.data };
}

export async function startPixelLabGeneration(options: {
  baseApi: string;
  token: string;
  request: PixelLabGenerateRequest;
  fetchImpl?: FetchLike;
}): Promise<PixelLabPendingResult> {
  const url = `${bridgeRoot(options.baseApi)}/generate`;
  const result = await bridgeJson({
    url,
    token: options.token,
    fetchImpl: options.fetchImpl,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(options.request)
    }
  });
  if (result.response.status !== 202 || (result.data as PixelLabPendingResult).status !== "processing") {
    throw new PixelLabBridgeError("PIXELLAB_PROTOCOL_ERROR", "PixelLab bridge did not accept the generation.", 502);
  }
  return result.data as PixelLabPendingResult;
}

export async function getPixelLabGeneration(options: {
  baseApi: string;
  token: string;
  generationId: string;
  fetchImpl?: FetchLike;
}): Promise<PixelLabGenerationResult> {
  const generationId = options.generationId.trim();
  if (!generationId) throw new PixelLabBridgeError("INVALID_REQUEST", "generation_id is required.", 400);
  const url = `${bridgeRoot(options.baseApi)}/generations/${encodeURIComponent(generationId)}`;
  const result = await bridgeJson({ url, token: options.token, fetchImpl: options.fetchImpl });
  const data = result.data as PixelLabGenerationResult;
  if (data.status === "processing" && result.response.status === 202) return data;
  if (data.status === "completed" && result.response.status === 200 && Array.isArray(data.assets)) return data;
  throw new PixelLabBridgeError("PIXELLAB_PROTOCOL_ERROR", "PixelLab bridge returned an invalid generation status.", 502);
}

export async function generatePixelLabAsset(options: {
  baseApi: string;
  token: string;
  request?: PixelLabGenerateRequest;
  generationId?: string;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<PixelLabGenerationResult> {
  let pending: PixelLabPendingResult;
  if (options.generationId?.trim()) {
    const resumed = await getPixelLabGeneration({
      baseApi: options.baseApi,
      token: options.token,
      generationId: options.generationId,
      fetchImpl: options.fetchImpl
    });
    if (resumed.status === "completed") return resumed;
    pending = resumed;
  } else {
    if (!options.request) throw new PixelLabBridgeError("INVALID_REQUEST", "Generation parameters are required.", 400);
    pending = await startPixelLabGeneration({
      baseApi: options.baseApi,
      token: options.token,
      request: options.request,
      fetchImpl: options.fetchImpl
    });
  }

  const maxWaitMs = options.maxWaitMs ?? PIXELLAB_TOOL_MAX_WAIT_MS;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + maxWaitMs;
  while (now() < deadline) {
    await sleep(options.pollIntervalMs ?? pending.poll_after_ms ?? PIXELLAB_POLL_INTERVAL_MS);
    const result = await getPixelLabGeneration({
      baseApi: options.baseApi,
      token: options.token,
      generationId: pending.generation_id,
      fetchImpl: options.fetchImpl
    });
    if (result.status === "completed") return result;
    pending = result;
  }
  return pending;
}
