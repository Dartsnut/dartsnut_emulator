import { isStructuredAgentEnvelopeText } from "../agentEventConsole";
import { applyStreamDeltaToEntryText } from "./applyStreamDelta";

/** Status lines emitted after native file tools complete. */
export const FILE_MUTATION_STATUS_RE = /^Ran (write file|replace in file)/;

export function entryTextHasFileWriteActions(text: string): boolean {
  if (!isStructuredAgentEnvelopeText(text)) {
    return false;
  }
  return (
    /"tool"\s*:\s*"write_file"/.test(text) || /"tool"\s*:\s*"replace_in_file"/.test(text)
  );
}

export function shouldClearFileWritePreviewOnStatus(message: string): boolean {
  return FILE_MUTATION_STATUS_RE.test(message);
}

export function shouldShowRollingFilePreview(input: {
  isStreaming: boolean;
  fileWritePreview: boolean;
  hasPreviewBody: boolean;
  hasPath: boolean;
}): boolean {
  return (
    (input.isStreaming || input.fileWritePreview) &&
    (input.hasPreviewBody || input.hasPath)
  );
}

export function shouldShowFileEditSummary(input: {
  isStreaming: boolean;
  fileWritePreview: boolean;
  hasContent: boolean;
}): boolean {
  return !input.isStreaming && !input.fileWritePreview && input.hasContent;
}

/** Apply queued stream deltas before handling `final` so large tool envelopes are not dropped. */
export function mergeAgentStreamEntryOnFinal(
  entryText: string,
  pendingDelta: string,
  finalContent: string
): { text: string; fileWritePreview: boolean } {
  const text =
    pendingDelta.length > 0 ? applyStreamDeltaToEntryText(entryText, pendingDelta) : entryText;
  if (
    finalContent === "" &&
    text.trim().length > 0 &&
    isStructuredAgentEnvelopeText(text)
  ) {
    return {
      text,
      fileWritePreview: entryTextHasFileWriteActions(text)
    };
  }
  return {
    text: finalContent.length > 0 ? finalContent : text,
    fileWritePreview: false
  };
}
