import { createHash } from "node:crypto";
import type { CallModelInputFilter } from "@openai/agents";

export const EMPTY_MODEL_RESPONSE_MESSAGE =
  "The model returned no assistant response. The run was stopped to prevent a retry loop.";

function fingerprintModelInput(modelData: Parameters<CallModelInputFilter>[0]["modelData"]): string {
  return createHash("sha256")
    .update(JSON.stringify({ input: modelData.input, instructions: modelData.instructions ?? "" }))
    .digest("hex");
}

/** Reject an immediately repeated model request before it can loop forever. */
export function createSafeCallModelInputFilter(): CallModelInputFilter {
  let previousFingerprint: string | null = null;
  return ({ modelData }) => {
    const fingerprint = fingerprintModelInput(modelData);
    if (fingerprint === previousFingerprint) {
      throw new Error(EMPTY_MODEL_RESPONSE_MESSAGE);
    }
    previousFingerprint = fingerprint;
    return modelData;
  };
}
