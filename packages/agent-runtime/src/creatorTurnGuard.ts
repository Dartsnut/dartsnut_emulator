import { transcriptUserBubbleText } from "@dartsnut/shared-ipc";
import type { ChatMessage } from "./providerClient";

export const CREATOR_INCOMPLETE_NUDGE_USER_MESSAGE =
  "You replied without creating the required project files. Follow the **Build plan** with tools — do not only describe the plan in prose or paste file bodies in chat. Phase 1: `write_file` `conf.json` then `reload_emulator`. Phase 2: minimal `main.py`. Then `replace_in_file` for behavior. Load `creator-incremental`, `conf-contract`, `pydartsnut-core` via `get_dartsnut_skill` if needed. Do not switch to a different widget/game idea. State any defaults in one sentence in your final reply.";

export const CREATOR_STALL_NUDGE_USER_MESSAGE =
  "Phase 3+ is not implemented in the workspace yet — `main.py` is still the phase-2 stub. **Do not** implement in thinking/reasoning (no code fences there). In your **assistant message**, post a short **Agent steps** remainder (bullets only, no code), then use tools: `read_file` `main.py`, `copy_asset_file` for fonts if needed, and `replace_in_file` (or `write_file`) to add the real behavior. Focus on one tool round for the core implementation.";

export const CREATOR_INCOMPLETE_MAX_NUDGES = 4;
export const CREATOR_STALL_MAX_NUDGES = 3;

const REASONING_STALL_CHAR_THRESHOLD = 1500;

export function isCreatorTemplateMode(mode: string | null | undefined): boolean {
  return mode === "game-creator" || mode === "widget-creator";
}

export function isFileMutationToolName(name: string): boolean {
  return name === "write_file" || name === "replace_in_file" || name === "copy_asset_file";
}

export function readCreatorArtifactStatus(
  existsSync: (absolutePath: string) => boolean,
  resolveWithinRoot: (relativePath: string) => string
): { confJson: boolean; mainPy: boolean } {
  try {
    return {
      confJson: existsSync(resolveWithinRoot("conf.json")),
      mainPy: existsSync(resolveWithinRoot("main.py"))
    };
  } catch {
    return { confJson: false, mainPy: false };
  }
}

function isCreatorNudgeMessage(content: string): boolean {
  return (
    content.includes(CREATOR_INCOMPLETE_NUDGE_USER_MESSAGE.slice(0, 40)) ||
    content.includes(CREATOR_STALL_NUDGE_USER_MESSAGE.slice(0, 40))
  );
}

/**
 * True when main.py is still the minimal phase-2 blank-frame stub (PVRV9g-style).
 */
export function mainPyLooksLikePhase2Stub(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 1200) {
    return false;
  }
  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > 30) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  const hasBlankFrame =
    lower.includes("image.new") &&
    (lower.includes("(0, 0, 0)") || lower.includes("(0,0,0)") || lower.includes("rgb"));
  if (!hasBlankFrame) {
    return false;
  }
  const hasRealWidgetLogic =
    /imagedraw|draw\.text|fonts\/|copy_asset|flipclock|class\s+\w+/i.test(trimmed) ||
    (trimmed.match(/def\s+\w+/g)?.length ?? 0) > 1;
  return !hasRealWidgetLogic;
}

function reasoningLooksLikeImplementationDump(reasoningChars: number, reasoningContent?: string): boolean {
  if (reasoningChars > REASONING_STALL_CHAR_THRESHOLD) {
    return true;
  }
  const text = reasoningContent?.trim() ?? "";
  return text.includes("```");
}

/**
 * True when the user gave a concrete build/edit request (not host boilerplate).
 */
export function hasSubstantiveCreatorUserRequest(
  initialPrompt: string,
  messages: ChatMessage[],
  systemSlots: number
): boolean {
  const fromInitial = transcriptUserBubbleText(initialPrompt);
  if (fromInitial && fromInitial.trim().length >= 2 && !isCreatorNudgeMessage(fromInitial)) {
    return true;
  }
  for (let i = systemSlots; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    if (message.content.startsWith("TOOL_RESULTS:")) {
      continue;
    }
    if (isCreatorNudgeMessage(message.content)) {
      continue;
    }
    const bubble = transcriptUserBubbleText(message.content);
    if (bubble && bubble.trim().length >= 2) {
      return true;
    }
    if (!message.content.includes("Creation **intake just finished**") && message.content.trim().length >= 8) {
      return true;
    }
  }
  return false;
}

export function shouldInjectCreatorIncompleteNudge(input: {
  templateMode: string | null | undefined;
  artifacts: { confJson: boolean; mainPy: boolean };
  filesWrittenThisTurn: number;
  initialPrompt: string;
  messages: ChatMessage[];
  systemSlots: number;
  nudgeCount: number;
  maxNudges?: number;
}): boolean {
  const maxNudges = input.maxNudges ?? CREATOR_INCOMPLETE_MAX_NUDGES;
  if (input.nudgeCount >= maxNudges) {
    return false;
  }
  if (!isCreatorTemplateMode(input.templateMode)) {
    return false;
  }
  if (input.artifacts.confJson && input.artifacts.mainPy) {
    return false;
  }
  if (!hasSubstantiveCreatorUserRequest(input.initialPrompt, input.messages, input.systemSlots)) {
    return false;
  }
  return true;
}

export function shouldInjectCreatorStallNudge(input: {
  templateMode: string | null | undefined;
  artifacts: { confJson: boolean; mainPy: boolean };
  filesWrittenThisTurn: number;
  toolCallCount: number;
  reasoningChars: number;
  reasoningContent?: string;
  mainPyContent?: string;
  initialPrompt: string;
  messages: ChatMessage[];
  systemSlots: number;
  nudgeCount: number;
  maxNudges?: number;
}): boolean {
  const maxNudges = input.maxNudges ?? CREATOR_STALL_MAX_NUDGES;
  if (input.nudgeCount >= maxNudges) {
    return false;
  }
  if (!isCreatorTemplateMode(input.templateMode)) {
    return false;
  }
  if (!input.artifacts.confJson || !input.artifacts.mainPy) {
    return false;
  }
  if (input.toolCallCount > 0 || input.filesWrittenThisTurn > 0) {
    return false;
  }
  if (!hasSubstantiveCreatorUserRequest(input.initialPrompt, input.messages, input.systemSlots)) {
    return false;
  }
  if (!reasoningLooksLikeImplementationDump(input.reasoningChars, input.reasoningContent)) {
    return false;
  }
  const mainPy = input.mainPyContent ?? "";
  if (mainPy.length > 0 && !mainPyLooksLikePhase2Stub(mainPy)) {
    return false;
  }
  return true;
}
