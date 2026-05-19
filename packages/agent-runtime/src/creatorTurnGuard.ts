import fs from "node:fs";
import { transcriptUserBubbleText } from "@dartsnut/shared-ipc";
import type { ChatMessage } from "./providerClient";

export const CREATOR_INCOMPLETE_NUDGE_USER_MESSAGE =
  "You replied without creating the required project files. Implement now using tools: call `write_file` / `copy_asset_file` (and `reload_emulator` after `conf.json`) — do not only describe the plan in prose. Create `conf.json` and `main.py` in the workspace (plus any required fonts). Do not switch to a different widget/game idea; finish the current one. Do not ask more scoping questions unless truly blocked. State any defaults you chose in one sentence in your final reply.";

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
  return content.includes(CREATOR_INCOMPLETE_NUDGE_USER_MESSAGE.slice(0, 40));
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

export const CREATOR_INCOMPLETE_MAX_NUDGES = 4;

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
