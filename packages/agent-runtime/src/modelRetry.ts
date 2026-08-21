import { retryPolicies, type ModelRetrySettings, type RetryPolicyContext } from "@openai/agents";

export const MODEL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export type ModelRetryDiagnostic = {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  reason: "network" | "http";
  status?: number;
  errorCode?: string;
};

const networkFailurePolicy = retryPolicies.networkError();

function retryReason(context: RetryPolicyContext): "network" | "http" {
  return context.normalized.isNetworkError ? "network" : "http";
}

export function createModelRetrySettings(
  onRetry?: (diagnostic: ModelRetryDiagnostic) => void
): ModelRetrySettings {
  return {
    maxRetries: MODEL_RETRY_DELAYS_MS.length,
    backoff: {
      initialDelayMs: MODEL_RETRY_DELAYS_MS[0],
      maxDelayMs: MODEL_RETRY_DELAYS_MS[MODEL_RETRY_DELAYS_MS.length - 1],
      multiplier: 2,
      jitter: false
    },
    policy: async (context) => {
      if (context.normalized.isAbort) {
        return false;
      }
      const networkDecision = await networkFailurePolicy(context);
      const networkRetry = typeof networkDecision === "boolean" ? networkDecision : networkDecision.retry;
      const status = context.normalized.statusCode;
      const shouldRetry = networkRetry || status === 408 || status === 429 || status !== undefined && status >= 500;
      if (!shouldRetry) {
        return false;
      }
      onRetry?.({
        attempt: context.attempt,
        nextAttempt: context.attempt + 1,
        delayMs: MODEL_RETRY_DELAYS_MS[context.attempt - 1],
        reason: retryReason(context),
        ...(context.normalized.statusCode !== undefined ? { status: context.normalized.statusCode } : {}),
        ...(context.normalized.errorCode ? { errorCode: context.normalized.errorCode } : {})
      });
      return true;
    }
  };
}
