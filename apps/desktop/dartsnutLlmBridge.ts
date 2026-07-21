import type { DartsnutLlmFailureReason } from "@dartsnut/shared-ipc";
import type { AgentModelConfig } from "@dartsnut/agent-runtime";
import { withDartsnutSourceHeader } from "./dartsnutSourceHeader";

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
  finish: () => Promise<void>;
};

type FetchLike = typeof fetch;

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
  runId: string;
  fetchImpl?: FetchLike;
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
  try {
    startResponse = await postRunEndpoint(options.baseApi, "start", token, options.runId, fetchImpl);
  } catch {
    return {
      ok: false,
      failure: { reason: "service_unavailable", message: DEFAULT_FAILURE_MESSAGES.service_unavailable }
    };
  }
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
  const bridgeFetch: FetchLike = async (input, init) => {
    let response: Response;
    try {
      response = await fetchImpl(input, {
        ...init,
        headers: buildBridgeHeaders(input, init, token, options.runId)
      });
    } catch (error) {
      latestFailure = {
        reason: "service_unavailable",
        message: error instanceof Error && error.message
          ? error.message
          : DEFAULT_FAILURE_MESSAGES.service_unavailable
      };
      throw error;
    }
    if (!response.ok) {
      latestFailure = await readFailureResponse(response);
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
        fetchImpl: bridgeFetch
      },
      readFailure: () => latestFailure,
      finish: () => {
        if (!finishPromise) {
          finishPromise = (async () => {
            try {
              const response = await postRunEndpoint(options.baseApi, "finish", token, options.runId, fetchImpl);
              if (!response.ok) {
                console.warn("[agent] backend run finish failed", {
                  runId: options.runId,
                  status: response.status
                });
              } else {
                console.info("[agent] backend run finished", {
                  runId: options.runId,
                  status: response.status
                });
              }
            } catch (error) {
              // A failed finish cannot keep the desktop open forever, but must be visible in logs.
              console.warn("[agent] backend run finish request failed", {
                runId: options.runId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          })();
        }
        return finishPromise;
      }
    }
  };
}
