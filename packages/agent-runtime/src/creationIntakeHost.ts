import fs from "node:fs";
import path from "node:path";
import {
  validateDeployWorkspaceConf,
  WIDGET_DISPLAY_SIZES,
  type AgentEvent,
  type ProjectType,
  type WidgetSize
} from "@dartsnut/shared-ipc";
import type { HostAskQuestionHandler, HostIntakeToolHandler } from "./sessionEngine";

export interface IntakeToolState {
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
}

export function isIntakeStateReady(state: IntakeToolState): boolean {
  if (state.projectType === "game") {
    return true;
  }
  if (state.projectType === "widget") {
    return Boolean(state.widgetSize);
  }
  return false;
}

export function parseConfWidgetSize(size: unknown): WidgetSize | undefined {
  if (!Array.isArray(size) || size.length !== 2) {
    return undefined;
  }
  const w = Number(size[0]);
  const h = Number(size[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    return undefined;
  }
  const key = `${w}x${h}` as WidgetSize;
  return WIDGET_DISPLAY_SIZES.includes(key) ? key : undefined;
}

function readWorkspaceCreatorHints(absoluteWorkspacePath: string): {
  templateMode: "widget-creator" | "game-creator";
  projectType: ProjectType;
  widgetSize?: WidgetSize;
} | null {
  const confPath = path.join(absoluteWorkspacePath, "conf.json");
  if (!fs.existsSync(confPath)) {
    return null;
  }
  try {
    const conf = JSON.parse(fs.readFileSync(confPath, "utf-8")) as {
      type?: string;
      size?: unknown;
    };
    if (conf.type === "widget") {
      return {
        templateMode: "widget-creator",
        projectType: "widget",
        widgetSize: parseConfWidgetSize(conf.size)
      };
    }
    if (conf.type === "game") {
      return {
        templateMode: "game-creator",
        projectType: "game"
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function readWorkspaceConfIntakeSnapshot(
  absoluteWorkspacePath: string,
  intent?: IntakeToolState
): Record<string, unknown> {
  const confPath = path.join(absoluteWorkspacePath, "conf.json");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(absoluteWorkspacePath);
  } catch {
    entries = [];
  }
  const base: Record<string, unknown> = {
    workspacePath: absoluteWorkspacePath,
    directoryEntryCount: entries.length,
    confPath
  };
  if (!fs.existsSync(confPath)) {
    return {
      ...base,
      conf_status: "missing",
      guidance:
        "No conf.json yet — safe for a brand-new scaffold. Confirm the user's goal in one sentence, then the next agent phase can create conf.json + main.py."
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(confPath, "utf-8"));
  } catch {
    return {
      ...base,
      conf_status: "invalid_json",
      guidance:
        "conf.json exists but is not valid JSON. Ask whether to repair/replace it or pick a different empty folder."
    };
  }
  const deploy = validateDeployWorkspaceConf(raw);
  const hints = readWorkspaceCreatorHints(absoluteWorkspacePath);
  const conf = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const size = conf.size;
  const parsedSize = parseConfWidgetSize(size);
  const notes: string[] = [];
  if (intent?.projectType && deploy.ok && deploy.projectType !== intent.projectType) {
    notes.push(
      `User chose "${intent.projectType}" but conf.json declares "${deploy.projectType}". Ask one question: extend the existing project or use another folder.`
    );
  }
  if (
    intent?.projectType === "widget" &&
    intent.widgetSize &&
    parsedSize &&
    parsedSize !== intent.widgetSize
  ) {
    notes.push(
      `User chose widget size ${intent.widgetSize} but conf.json size maps to ${parsedSize}. Ask which size to follow.`
    );
  }
  if (deploy.ok && entries.some((n) => n === "main.py")) {
    notes.push("main.py is already present — confirm whether to modify it or start fresh.");
  }
  return {
    ...base,
    conf_status: deploy.ok ? "valid" : "invalid",
    deploy_eligibility: deploy,
    creator_hints: hints,
    conf_size_parsed: parsedSize ?? null,
    guidance_notes: notes
  };
}

export function nextAfterProjectType(pt: ProjectType): string {
  return pt === "widget"
    ? "Widget display size: if the user's message already names a supported WxH (128x160, 128x128, 128x64, 64x32), call set_widget_size with that value next. Otherwise call **dartsnut_ask_question** with question_id **widget_display_size** — do **not** pick a default, invent a size, or call set_widget_size or read_workspace_conf until they choose (or their next message is only one of those tokens — then call set_project_type with `widget` then set_widget_size with it)."
    : "Call **read_workspace_conf** — returns `conf.json` status for the active workspace.";
}

export async function executeIntakeHostTool(
  args: Record<string, unknown>,
  state: IntakeToolState,
  workspaceRoot: string
): Promise<string> {
  const action = args.action;
  if (typeof action !== "string") {
    return JSON.stringify({ ok: false, error: "action is required" });
  }
  if (action === "set_project_type") {
    const pt = args.project_type;
    if (pt !== "game" && pt !== "widget") {
      return JSON.stringify({ ok: false, error: "project_type must be \"game\" or \"widget\"." });
    }
    state.projectType = pt;
    if (pt === "game") {
      state.widgetSize = undefined;
    }
    return JSON.stringify({
      ok: true,
      recorded: { projectType: pt },
      next: nextAfterProjectType(pt)
    });
  }
  if (action === "set_widget_size") {
    if (state.projectType !== "widget") {
      return JSON.stringify({
        ok: false,
        error: "set_widget_size requires project_type widget (call set_project_type first)."
      });
    }
    const sz = args.widget_size;
    if (typeof sz !== "string" || !WIDGET_DISPLAY_SIZES.includes(sz as WidgetSize)) {
      return JSON.stringify({
        ok: false,
        error: `widget_size must be one of: ${WIDGET_DISPLAY_SIZES.join(", ")}.`
      });
    }
    state.widgetSize = sz as WidgetSize;
    return JSON.stringify({
      ok: true,
      recorded: { widgetSize: state.widgetSize },
      next: "Call **read_workspace_conf** — returns `conf.json` status for the active workspace."
    });
  }
  if (action === "read_workspace_conf") {
    if (!workspaceRoot) {
      return JSON.stringify({ ok: false, error: "No workspace is active." });
    }
    const snapshot = readWorkspaceConfIntakeSnapshot(workspaceRoot, state);
    return JSON.stringify({ ok: true, ...snapshot });
  }
  return JSON.stringify({ ok: false, error: `Unknown intake action: ${action}` });
}

export interface AskQuestionPrecheckResult {
  handled: boolean;
  response?: string;
}

/** Returns a tool JSON response when the question is already satisfied; otherwise not handled. */
export function precheckAskQuestion(
  args: Record<string, unknown>,
  state: IntakeToolState
): AskQuestionPrecheckResult {
  const questionId = args.question_id;
  if (typeof questionId !== "string") {
    return {
      handled: true,
      response: JSON.stringify({ ok: false, error: "question_id is required" })
    };
  }
  if (questionId === "project_type" && state.projectType) {
    return {
      handled: true,
      response: JSON.stringify({
        ok: true,
        recorded: { projectType: state.projectType },
        skipped: "already_recorded"
      })
    };
  }
  if (questionId === "widget_display_size") {
    if (state.projectType !== "widget") {
      return {
        handled: true,
        response: JSON.stringify({
          ok: false,
          error:
            "widget_display_size requires project_type widget (call set_project_type or ask project_type first)."
        })
      };
    }
    if (state.widgetSize) {
      return {
        handled: true,
        response: JSON.stringify({
          ok: true,
          recorded: { widgetSize: state.widgetSize },
          skipped: "already_recorded"
        })
      };
    }
  }
  return { handled: false };
}

export interface CreateIntakeHostHandlersOptions {
  workspaceRoot: string;
  /** When the model calls a blocking ask_question; return JSON tool result text. */
  resolveAskQuestion: (
    questionId: string,
    state: IntakeToolState
  ) => Promise<string>;
  onPromptEvent?: (event: AgentEvent) => void;
  onHostIntakeAction?: (action: string) => void;
  onAskQuestionInvoked?: (questionId: string) => void;
}

export interface CreateIntakeHostHandlersResult {
  state: IntakeToolState;
  hostIntakeToolHandler: HostIntakeToolHandler;
  hostAskQuestionHandler: HostAskQuestionHandler;
}

export function createIntakeHostHandlers(
  options: CreateIntakeHostHandlersOptions
): CreateIntakeHostHandlersResult {
  const state: IntakeToolState = {};
  const { workspaceRoot, resolveAskQuestion, onPromptEvent, onHostIntakeAction, onAskQuestionInvoked } =
    options;

  const hostIntakeToolHandler: HostIntakeToolHandler = async (args) => {
    const action = args.action;
    if (typeof action === "string") {
      onHostIntakeAction?.(action);
    }
    return executeIntakeHostTool(args, state, workspaceRoot);
  };

  const hostAskQuestionHandler: HostAskQuestionHandler = async (args) => {
    const precheck = precheckAskQuestion(args, state);
    if (precheck.handled && precheck.response !== undefined) {
      return precheck.response;
    }
    const questionId = args.question_id;
    if (typeof questionId !== "string") {
      return JSON.stringify({ ok: false, error: "question_id is required" });
    }
    onAskQuestionInvoked?.(questionId);
    if (questionId === "project_type") {
      onPromptEvent?.({
        type: "intake_project_type_prompt",
        at: Date.now(),
        visible: true,
        options: ["game", "widget"]
      });
    } else if (questionId === "widget_display_size") {
      onPromptEvent?.({
        type: "intake_widget_size_prompt",
        at: Date.now(),
        visible: true,
        sizes: [...WIDGET_DISPLAY_SIZES]
      });
    }
    return resolveAskQuestion(questionId, state);
  };

  return { state, hostIntakeToolHandler, hostAskQuestionHandler };
}
