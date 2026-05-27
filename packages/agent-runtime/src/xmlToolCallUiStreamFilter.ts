/**
 * Hides Claude / gateway XML tool syntax from assistant stream chunks sent to the UI.
 * Full text is still accumulated elsewhere for parseXmlToolCalls / promotion after completion.
 */

export type XmlToolUiStreamFilterState = {
  carry: string;
  phase: "text" | "open" | "body";
  /** Which closing tag to look for once inside the XML block. */
  bodyKind: "function_calls" | "tool_call" | null;
};

export function createXmlToolUiStreamFilterState(): XmlToolUiStreamFilterState {
  return { carry: "", phase: "text", bodyKind: null };
}

const OPEN_FC = /<function_calls\b/i;
const OPEN_TC = /<tool_call\b/i;
const CLOSE_FC = /<\/function_calls\s*>/i;
const CLOSE_TC = /<\/tool_call\s*>/i;

/** Longest opening we might split across chunks (<function_calls = 16 chars + margin). */
const MAX_OPEN_CARRY = 24;
/** Longest closing tag fragment we might split. */
const MAX_CLOSE_CARRY = 20;

function couldBeIncompleteOpenTag(tail: string): boolean {
  if (!tail.startsWith("<")) {
    return false;
  }
  const lower = tail.toLowerCase();
  const prefixes = ["<function_calls", "<tool_call"];
  return prefixes.some((p) => p.startsWith(lower) || lower.startsWith(p.slice(0, Math.min(lower.length, p.length))));
}

/**
 * Returns text safe to show in the chat timeline for this delta.
 * Discards content inside `<function_calls>…</function_calls>` and `<tool_call>…</tool_call>`.
 */
export function filterAssistantUiStreamDelta(
  state: XmlToolUiStreamFilterState,
  delta: string
): string {
  let work = state.carry + delta;
  state.carry = "";
  let out = "";

  while (work.length > 0) {
    if (state.phase === "text") {
      const idxFc = work.search(OPEN_FC);
      const idxTc = work.search(OPEN_TC);
      let openAt = -1;
      let kind: "function_calls" | "tool_call" = "function_calls";
      if (idxFc >= 0 && idxTc >= 0) {
        if (idxFc <= idxTc) {
          openAt = idxFc;
          kind = "function_calls";
        } else {
          openAt = idxTc;
          kind = "tool_call";
        }
      } else if (idxFc >= 0) {
        openAt = idxFc;
        kind = "function_calls";
      } else if (idxTc >= 0) {
        openAt = idxTc;
        kind = "tool_call";
      }

      if (openAt < 0) {
        const lastLt = work.lastIndexOf("<");
        if (lastLt >= 0 && work.length - lastLt <= MAX_OPEN_CARRY) {
          const tail = work.slice(lastLt);
          if (couldBeIncompleteOpenTag(tail) && !tail.includes(">")) {
            out += work.slice(0, lastLt);
            state.carry = tail;
            break;
          }
        }
        out += work;
        break;
      }

      out += work.slice(0, openAt);
      work = work.slice(openAt);
      state.phase = "open";
      state.bodyKind = kind;
      continue;
    }

    if (state.phase === "open") {
      const gt = work.indexOf(">");
      if (gt < 0) {
        state.carry = work;
        break;
      }
      work = work.slice(gt + 1);
      state.phase = "body";
      continue;
    }

    // body
    const closeRe = state.bodyKind === "function_calls" ? CLOSE_FC : CLOSE_TC;
    const m = closeRe.exec(work);
    if (m) {
      work = work.slice(m.index + m[0].length);
      state.phase = "text";
      state.bodyKind = null;
      continue;
    }

    const lastKeep = Math.max(0, work.length - MAX_CLOSE_CARRY);
    state.carry = work.slice(lastKeep);
    break;
  }

  return out;
}
