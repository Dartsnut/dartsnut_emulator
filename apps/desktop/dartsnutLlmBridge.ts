import { createHash } from "node:crypto";
import type { DartsnutLlmFailureReason } from "@dartsnut/shared-ipc";
import type { AgentModelConfig } from "@dartsnut/agent-runtime";
import { withDartsnutSourceHeader } from "./dartsnutSourceHeader";
import { fetchBufferedModelResponse } from "./bufferedModelFetch";

export const DARTSNUT_LLM_MODEL_ALIAS = "dartsnut-llm";
export const DARTSNUT_LLM_BRIDGE_API_KEY_PLACEHOLDER = "dartsnut-api-bridge";

export type DartsnutLlmBridgeFailure = {
  reason: DartsnutLlmFailureReason;
  message: string;
};

export type DartsnutLlmBridgeRun = {
  runId: string;
  modelConfig: AgentModelConfig;
  readFailure: () => DartsnutLlmBridgeFailure | null;
  finish: (reason?: string) => Promise<void>;
};

type FetchLike = typeof fetch;
type DiagnosticLogger = (message: string, meta: Record<string, unknown>) => void;

type DartsnutApiEnvelope = {
  code?: number;
  desc?: string;
  message?: string;
  error?: string | { code?: string; message?: string };
  data?: unknown;
};

const DEFAULT_FAILURE_MESSAGES: Record<DartsnutLlmFailureReason, string> = {
  auth_required: "Sign in to your Dartsnut account to use Dartsnut LLM.",
  no_bound_machine: "Bind a Dartsnut machine to your account before using Dartsnut LLM.",
  daily_quota_exceeded: "Daily Dartsnut LLM token limit reached. Try again after 00:00 UTC.",
  run_already_active: "Another Dartsnut LLM agent run is already active for this account.",
  run_expired: "Dartsnut LLM agent run expired. Send your request again.",
  service_unavailable: "Dartsnut LLM is temporarily unavailable. Please try again later."
};

function trimBaseApi(baseApi: string): string {
  return baseApi.trim().replace(/\/+$/, "");
}

export function dartsnutLlmBridgeRoot(baseApi: string): string {
  return `${trimBaseApi(baseApi)}/agent/llm`;
}

export function dartsnutLlmBridgeModelBaseUrl(baseApi: string): string {
  return `${dartsnutLlmBridgeRoot(baseApi)}/v1`;
}

function errorCodeFromEnvelope(parsed: DartsnutApiEnvelope | null): string {
  if (!parsed) {
    return "";
  }
  if (typeof parsed.error === "string") {
    return parsed.error.trim().toUpperCase();
  }
  if (parsed.error && typeof parsed.error === "object") {
    return String(parsed.error.code || "").trim().toUpperCase();
  }
  return "";
}

function messageFromEnvelope(parsed: DartsnutApiEnvelope | null): string {
  if (!parsed) {
    return "";
  }
  if (typeof parsed.error === "object" && parsed.error) {
    const nested = String(parsed.error.message || "").trim();
    if (nested) {
      return nested;
    }
  }
  return String(parsed.desc || parsed.message || "").trim();
}

export function mapDartsnutLlmBridgeFailure(
  status: number,
  parsed: DartsnutApiEnvelope | null
): DartsnutLlmBridgeFailure {
  const code = errorCodeFromEnvelope(parsed);
  const apiCode = Number(parsed?.code);
  let reason: DartsnutLlmFailureReason;
  if (status === 401 || code === "AUTH_REQUIRED" || [1000, 1006, 1026, 1038].includes(apiCode)) {
    reason = "auth_required";
  } else if (status === 403 || code === "NO_BOUND_MACHINE") {
    reason = "no_bound_machine";
  } else if (code === "DAILY_QUOTA_EXCEEDED") {
    reason = "daily_quota_exceeded";
  } else if (code === "RUN_ALREADY_ACTIVE") {
    reason = "run_already_active";
  } else if (code === "RUN_EXPIRED" || code === "RUN_REQUEST_LIMIT_REACHED") {
    reason = "run_expired";
  } else {
    reason = "service_unavailable";
  }
  return {
    reason,
    message: messageFromEnvelope(parsed) || DEFAULT_FAILURE_MESSAGES[reason]
  };
}

async function readFailureResponse(response: Response): Promise<DartsnutLlmBridgeFailure> {
  let parsed: DartsnutApiEnvelope | null = null;
  try {
    parsed = (await response.clone().json()) as DartsnutApiEnvelope;
  } catch {
    // Use status-based fallback below.
  }
  return mapDartsnutLlmBridgeFailure(response.status, parsed);
}

async function readFailureEnvelope(response: Response): Promise<DartsnutApiEnvelope | null> {
  try {
    return (await response.clone().json()) as DartsnutApiEnvelope;
  } catch {
    return null;
  }
}

function requestPath(input: RequestInfo | URL): string {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.pathname;
  } catch {
    return "unknown";
  }
}

function summarizeResponsesRequest(input: RequestInfo | URL, init?: RequestInit): Record<string, unknown> {
  const body = typeof init?.body === "string" ? init.body : undefined;
  let parsed: Record<string, unknown> | null = null;
  if (body) {
    try {
      const value = JSON.parse(body) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // Body shape remains visible through bodyBytes without logging its contents.
    }
  }
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  const toolTypes = [...new Set(tools.map((tool) => {
    if (!tool || typeof tool !== "object") return "unknown";
    const type = (tool as { type?: unknown }).type;
    return typeof type === "string" ? type : "unknown";
  }))];
  const inputItems = Array.isArray(parsed?.input)
    ? parsed.input.length
    : typeof parsed?.input === "string"
      ? 1
      : undefined;
  return {
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    path: requestPath(input),
    stream: parsed?.stream === true,
    ...(typeof parsed?.model === "string" ? { model: parsed.model } : {}),
    ...(inputItems !== undefined ? { inputItems } : {}),
    toolCount: tools.length,
    toolTypes,
    hasPreviousResponseId: typeof parsed?.previous_response_id === "string" && parsed.previous_response_id.length > 0,
    hasReasoning: Boolean(parsed?.reasoning),
    hasInstructions: typeof parsed?.instructions === "string" && parsed.instructions.length > 0,
    ...(body ? { bodyBytes: Buffer.byteLength(body, "utf-8") } : {})
  };
}

function responseRequestId(response: Response): string | undefined {
  return response.headers.get("x-request-id")
    ?? response.headers.get("request-id")
    ?? response.headers.get("x-dartsnut-request-id")
    ?? undefined;
}

function fetchFailureDetails(error: unknown): string {
  const seen = new Set<object>();

  const visit = (value: unknown, depth: number): string => {
    if (depth > 4 || value == null) {
      return "";
    }
    if (typeof value !== "object") {
      return typeof value === "string" ? value.trim() : "";
    }
    if (seen.has(value)) {
      return "";
    }
    seen.add(value);

    const record = value as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      syscall?: unknown;
      hostname?: unknown;
      cause?: unknown;
    };
    const summary = [record.name, record.code, record.syscall, record.hostname, record.message]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .map((part) => part.trim())
      .join(" ");
    const cause = visit(record.cause, depth + 1);
    return [summary, cause].filter(Boolean).join("; caused by: ");
  };

  return visit(error, 0);
}

function fetchFailureMessage(error: unknown, baseApi: string): string {
  const details = fetchFailureDetails(error).toLowerCase();
  let host = "the Dartsnut LLM service";
  try {
    host = new URL(baseApi).host || host;
  } catch {
    // Keep the generic service name when a custom API URL is malformed.
  }

  if (/enotfound|eai_again|getaddrinfo|dns/.test(details)) {
    return `Couldn’t reach Dartsnut LLM because ${host} could not be found. Check your internet, DNS, or VPN settings, then try again.`;
  }
  if (/timeout|timed out|aborterror/.test(details)) {
    return "Dartsnut LLM took too long to respond. Check your connection and try again.";
  }
  if (/certificate|cert_|self signed|unable to verify/.test(details)) {
    return "Dartsnut LLM could not establish a secure connection. Check your network or VPN certificate settings, then try again.";
  }
  return "Couldn’t reach Dartsnut LLM. Check your internet connection, VPN, or firewall, then try again.";
}

function buildBridgeHeaders(input: RequestInfo | URL, init: RequestInit | undefined, token: string, runId?: string): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.delete("authorization");
  headers.set("token", token);
  headers.set("source", "agent");
  if (runId) {
    headers.set("x-dartsnut-agent-run-id", runId);
  }
  return headers;
}

async function postRunEndpoint(
  baseApi: string,
  endpoint: "start" | "finish",
  token: string,
  runId: string,
  fetchImpl: FetchLike
): Promise<Response> {
  const url = `${dartsnutLlmBridgeRoot(baseApi)}/runs/${endpoint}`;
  return fetchImpl(url, withDartsnutSourceHeader(url, {
    method: "POST",
    headers: {
      token,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ run_id: runId })
  }));
}

export async function startDartsnutLlmBridgeRun(options: {
  baseApi: string;
  token: string;
  accountScope?: string;
  runId: string;
  fetchImpl?: FetchLike;
  onDiagnostic?: DiagnosticLogger;
}): Promise<{ ok: true; run: DartsnutLlmBridgeRun } | { ok: false; failure: DartsnutLlmBridgeFailure }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token.trim();
  if (!token) {
    return {
      ok: false,
      failure: { reason: "auth_required", message: DEFAULT_FAILURE_MESSAGES.auth_required }
    };
  }

  let startResponse: Response;
  const startRequestAt = Date.now();
  options.onDiagnostic?.("bridge run start request", { runId: options.runId });
  try {
    startResponse = await postRunEndpoint(options.baseApi, "start", token, options.runId, fetchImpl);
  } catch (error) {
    options.onDiagnostic?.("bridge run start request failed", {
      runId: options.runId,
      elapsedMs: Date.now() - startRequestAt,
      error: fetchFailureDetails(error) || String(error)
    });
    return {
      ok: false,
      failure: { reason: "service_unavailable", message: fetchFailureMessage(error, options.baseApi) }
    };
  }
  options.onDiagnostic?.("bridge run start response", {
    runId: options.runId,
    status: startResponse.status,
    ok: startResponse.ok,
    elapsedMs: Date.now() - startRequestAt,
    requestId: responseRequestId(startResponse)
  });
  if (!startResponse.ok) {
    return { ok: false, failure: await readFailureResponse(startResponse) };
  }
  try {
    const envelope = (await startResponse.clone().json()) as DartsnutApiEnvelope;
    if (Number(envelope.code) !== 1001) {
      return { ok: false, failure: mapDartsnutLlmBridgeFailure(startResponse.status, envelope) };
    }
  } catch {
    return {
      ok: false,
      failure: { reason: "service_unavailable", message: DEFAULT_FAILURE_MESSAGES.service_unavailable }
    };
  }

  let latestFailure: DartsnutLlmBridgeFailure | null = null;
  let finishPromise: Promise<void> | null = null;
  let finishReason: string | null = null;
  const bridgeFetch: FetchLike = async (input, init) => {
    let response: Response;
    const requestAt = Date.now();
    const requestSummary = summarizeResponsesRequest(input, init);
    options.onDiagnostic?.("bridge model request", {
      runId: options.runId,
      ...requestSummary
    });
    try {
      response = await fetchBufferedModelResponse(fetchImpl, input, {
        ...init,
        headers: buildBridgeHeaders(input, init, token, options.runId)
      });
    } catch (error) {
      latestFailure = {
        reason: "service_unavailable",
        message: fetchFailureMessage(error, options.baseApi)
      };
      options.onDiagnostic?.("bridge model request failed", {
        runId: options.runId,
        ...requestSummary,
        elapsedMs: Date.now() - requestAt,
        error: fetchFailureDetails(error) || String(error)
      });
      throw error;
    }
    const responseMeta = {
      runId: options.runId,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") ?? undefined,
      elapsedMs: Date.now() - requestAt,
      requestId: responseRequestId(response)
    };
    options.onDiagnostic?.("bridge model response", responseMeta);
    if (response.ok) {
      latestFailure = null;
    } else {
      const envelope = await readFailureEnvelope(response);
      latestFailure = mapDartsnutLlmBridgeFailure(response.status, envelope);
      options.onDiagnostic?.("bridge model rejected", {
        ...responseMeta,
        code: errorCodeFromEnvelope(envelope) || undefined,
        apiCode: typeof envelope?.code === "number" ? envelope.code : undefined,
        message: latestFailure.message
      });
    }
    return response;
  };

  return {
    ok: true,
    run: {
      runId: options.runId,
      modelConfig: {
        baseUrl: dartsnutLlmBridgeModelBaseUrl(options.baseApi),
        apiKey: `${DARTSNUT_LLM_BRIDGE_API_KEY_PLACEHOLDER}-${options.runId}`,
        model: DARTSNUT_LLM_MODEL_ALIAS,
        endpointKind: "openai-compatible",
        supportsHostedTools: true,
        chainScope: createHash("sha256")
          .update(`${trimBaseApi(options.baseApi)}\0${options.accountScope?.trim() || token}`)
          .digest("hex"),
        fetchImpl: bridgeFetch
      },
      readFailure: () => latestFailure,
      finish: (reason = "unspecified") => {
        if (!finishPromise) {
          finishReason = reason;
          finishPromise = (async () => {
            const finishRequestAt = Date.now();
            options.onDiagnostic?.("bridge run finish request", { runId: options.runId, reason });
            try {
              const response = await postRunEndpoint(options.baseApi, "finish", token, options.runId, fetchImpl);
              if (!response.ok) {
                options.onDiagnostic?.("bridge run finish failed", {
                  runId: options.runId,
                  reason,
                  status: response.status,
                  elapsedMs: Date.now() - finishRequestAt,
                  requestId: responseRequestId(response)
                });
              } else {
                options.onDiagnostic?.("bridge run finished", {
                  runId: options.runId,
                  reason,
                  status: response.status,
                  elapsedMs: Date.now() - finishRequestAt,
                  requestId: responseRequestId(response)
                });
              }
            } catch (error) {
              // A failed finish cannot keep the desktop open forever, but must be visible in logs.
              options.onDiagnostic?.("bridge run finish request failed", {
                runId: options.runId,
                reason,
                elapsedMs: Date.now() - finishRequestAt,
                error: fetchFailureDetails(error) || String(error)
              });
            }
          })();
        } else {
          options.onDiagnostic?.("bridge run finish reused", {
            runId: options.runId,
            requestedReason: reason,
            originalReason: finishReason
          });
        }
        return finishPromise;
      }
    }
  };
}
