import { describe, expect, it, vi } from "vitest";
import type { RetryPolicyContext } from "@openai/agents";
import { createModelRetrySettings, MODEL_RETRY_DELAYS_MS } from "../src/modelRetry";

function context(overrides: Partial<RetryPolicyContext> = {}): RetryPolicyContext {
  return {
    error: new Error("failure"),
    attempt: 1,
    maxRetries: 5,
    stream: true,
    normalized: {
      isAbort: false,
      isNetworkError: false
    },
    ...overrides
  };
}

describe("createModelRetrySettings", () => {
  it("configures five exact exponential retries without jitter", () => {
    const settings = createModelRetrySettings();

    expect(settings.maxRetries).toBe(5);
    expect(settings.backoff).toEqual({
      initialDelayMs: 1_000,
      maxDelayMs: 16_000,
      multiplier: 2,
      jitter: false
    });
    expect(MODEL_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it.each([408, 429, 500, 503, 599])("retries transient HTTP %s", async (statusCode) => {
    const policy = createModelRetrySettings().policy!;
    const decision = await policy(context({ normalized: { isAbort: false, isNetworkError: false, statusCode } }));

    expect(decision).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])("does not retry permanent HTTP %s", async (statusCode) => {
    const policy = createModelRetrySettings().policy!;

    await expect(policy(context({ normalized: { isAbort: false, isNetworkError: false, statusCode } })))
      .resolves.toBe(false);
  });

  it("retries network failures and reports attempt diagnostics", async () => {
    const onRetry = vi.fn();
    const policy = createModelRetrySettings(onRetry).policy!;

    await expect(policy(context({
      attempt: 3,
      normalized: { isAbort: false, isNetworkError: true, errorCode: "ECONNRESET" },
      previousResponseId: "response-1",
      statefulRequest: true
    }))).resolves.toBe(true);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 3,
      nextAttempt: 4,
      delayMs: 4_000,
      reason: "network",
      errorCode: "ECONNRESET"
    });
  });

  it("does not select cancellation for retry", async () => {
    const policy = createModelRetrySettings().policy!;

    await expect(policy(context({ normalized: { isAbort: true, isNetworkError: false } }))).resolves.toBe(false);
  });
});
