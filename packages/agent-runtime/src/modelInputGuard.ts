import { createHash } from "node:crypto";
import type { CallModelInputFilter } from "@openai/agents";

export const EMPTY_MODEL_RESPONSE_MESSAGE =
  "The model returned no assistant response. The run was stopped to prevent a retry loop.";

export type RepeatedModelInputDiagnostic = {
  inputItems: number;
  instructionsChars: number;
  repeatedCount?: number;
};

function fingerprintModelInput(modelData: Parameters<CallModelInputFilter>[0]["modelData"]): string {
  return createHash("sha256")
    .update(JSON.stringify({ input: modelData.input, instructions: modelData.instructions ?? "" }))
    .digest("hex");
}

function summarizeModelInput(
  modelData: Parameters<CallModelInputFilter>[0]["modelData"]
): RepeatedModelInputDiagnostic {
  const input = modelData.input;
  return {
    inputItems: input.length,
    instructionsChars: typeof modelData.instructions === "string" ? modelData.instructions.length : 0
  };
}

/**
 * Reject a genuinely stuck model request before it can loop forever.
 *
 * Responses-compatible gateways may emit one duplicate request while they
 * settle a tool result. Treat the first repeat as progress-tolerant; abort
 * only after three consecutive identical inputs.
 */
export function createSafeCallModelInputFilter(
  onRepeatedInput?: (diagnostic: RepeatedModelInputDiagnostic) => void
): CallModelInputFilter {
  let previousFingerprint: string | null = null;
  let repeatedCount = 0;
  return ({ modelData }) => {
    const fingerprint = fingerprintModelInput(modelData);
    if (fingerprint === previousFingerprint) {
      repeatedCount += 1;
      if (repeatedCount >= 3) {
        onRepeatedInput?.({
          ...summarizeModelInput(modelData),
          repeatedCount
        });
        throw new Error(EMPTY_MODEL_RESPONSE_MESSAGE);
      }
    } else {
      repeatedCount = 0;
    }
    previousFingerprint = fingerprint;
    return modelData;
  };
}
