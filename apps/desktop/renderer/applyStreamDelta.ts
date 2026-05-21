import { TOOL_ENVELOPE_STREAM_REPLACE } from "@dartsnut/shared-ipc";

/** Apply stream deltas; tool-envelope replace markers rewrite the JSON tail without corrupting it. */
export function applyStreamDeltaToEntryText(currentText: string, pending: string): string {
  if (!pending.includes(TOOL_ENVELOPE_STREAM_REPLACE)) {
    return currentText + pending;
  }
  let text = currentText;
  let searchFrom = 0;
  while (searchFrom < pending.length) {
    const markerAt = pending.indexOf(TOOL_ENVELOPE_STREAM_REPLACE, searchFrom);
    if (markerAt < 0) {
      text += pending.slice(searchFrom);
      break;
    }
    if (markerAt > searchFrom) {
      text += pending.slice(searchFrom, markerAt);
    }
    const tailStart = markerAt + TOOL_ENVELOPE_STREAM_REPLACE.length;
    const nextMarker = pending.indexOf(TOOL_ENVELOPE_STREAM_REPLACE, tailStart);
    const tail = pending.slice(tailStart, nextMarker >= 0 ? nextMarker : undefined);
    const jsonStart = text.indexOf("{");
    const lead = jsonStart >= 0 ? text.slice(0, jsonStart) : text;
    text = lead + tail;
    searchFrom = nextMarker >= 0 ? nextMarker : pending.length;
  }
  return text;
}
