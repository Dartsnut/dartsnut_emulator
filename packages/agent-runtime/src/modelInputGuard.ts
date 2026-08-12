import { createHash } from "node:crypto";
import type { CallModelInputFilter } from "@openai/agents";

export const EMPTY_MODEL_RESPONSE_MESSAGE =
  "The model returned no assistant response. The run was stopped to prevent a retry loop.";

export type RepeatedModelInputDiagnostic = {
  inputItems: number;
  instructionsChars: number;
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

/** Reject an immediately repeated model request before it can loop forever. */
export function createSafeCallModelInputFilter(
  onRepeatedInput?: (diagnostic: RepeatedModelInputDiagnostic) => void
): CallModelInputFilter {
  let previousFingerprint: string | null = null;
  return ({ modelData }) => {
    const fingerprint = fingerprintModelInput(modelData);
    if (fingerprint === previousFingerprint) {
      onRepeatedInput?.(summarizeModelInput(modelData));
      throw new Error(EMPTY_MODEL_RESPONSE_MESSAGE);
    }
    previousFingerprint = fingerprint;
    return modelData;
  };
}
