/**
 * OpenAI Chat Completions function definitions for the agent runtime's tools.
 *
 * File tools mirror `SessionEngine.normalizeAction` / `executeAction`.
 * `dartsnut_project_intake` is executed by the host (Electron main) when configured.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import { DEFERRED_SKILL_IDS } from "./skillBundle";

const GET_DARTSNUT_SKILL_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_dartsnut_skill",
    description: [
      "Load the full markdown text for a **Dartsnut house skill** (runtime, display mapping, or asset pipeline).",
      "Call **before** write_file / replace_in_file / copy_asset_file when the router system prompt lists this skill for the session.",
      "Do not use for workspace project files — use read_file. Returns JSON with `content` (the skill body) when `ok` is true."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          enum: [...DEFERRED_SKILL_IDS],
          description: "Which bundled skill to retrieve."
        }
      },
      required: ["skill_id"],
      additionalProperties: false
    },
    strict: true
  }
};

const DARTSNUT_PROJECT_INTAKE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "dartsnut_project_intake",
    description: [
      "Dartsnut Chat **new-project / workspace** setup (host-executed). Use standard `tool_calls` only.",
      "Actions:",
      "- **set_project_type** — record whether the user is building a `game` or `widget` (required before scaffolding).",
      "- **set_widget_size** — for widgets only; one of the supported WxH tokens. Do **not** infer a default — the user must choose (or their message must already name a supported size).",
      "- **pick_workspace** — opens a folder picker for an **empty** project directory; required before any files are written.",
      "- **read_workspace_conf** — reads `conf.json` in the **currently selected** workspace and reports deploy-style validity plus guidance (call after the folder is chosen, and again if the user switches workspace).",
      "Typical order when starting from no workspace: infer or confirm `set_project_type` (the app may show **Game / Widget** chips until this is set) → if widget, confirm display size (ask if missing, or use the in-app size chips) then `set_widget_size` → `pick_workspace` → `read_workspace_conf`, then ask **one** focused follow-up question when `read_workspace_conf` shows an existing project or invalid `conf.json`."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set_project_type", "set_widget_size", "pick_workspace", "read_workspace_conf"]
        },
        project_type: {
          type: "string",
          enum: ["game", "widget"],
          description: "Required when action is set_project_type."
        },
        widget_size: {
          type: "string",
          enum: ["128x160", "128x128", "128x64", "64x32"],
          description: "Required when action is set_widget_size."
        }
      },
      required: ["action"],
      additionalProperties: false
    },
    strict: false
  }
};

/** File + asset tools only (no host intake). */
export const AGENT_FILE_TOOL_SCHEMAS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files inside the agent workspace, recursively. Returns paths relative to the workspace root. Use this to discover the layout before reading or editing.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative subdirectory to list. Defaults to the workspace root when omitted."
          }
        },
        additionalProperties: false
      },
      strict: false
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the UTF-8 contents of a workspace file. Do not use for binary assets — use copy_asset_file for fonts and images.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path to read."
          }
        },
        required: ["path"],
        additionalProperties: false
      },
      strict: true
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or fully overwrite an existing file with UTF-8 text. Prefer replace_in_file for targeted edits to existing files to keep payloads small.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path to write."
          },
          content: {
            type: "string",
            description: "Full file contents to write."
          }
        },
        required: ["path", "content"],
        additionalProperties: false
      },
      strict: true
    }
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description:
        "Replace the first occurrence of `find` with `replace` inside an existing workspace file. Fails if `find` is not present. Prefer this over write_file when editing existing files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path to edit."
          },
          find: {
            type: "string",
            description:
              "Exact text to locate inside the file. Must be non-empty and unique enough to identify a single occurrence."
          },
          replace: {
            type: "string",
            description: "Replacement text. May be empty to delete the matched span."
          }
        },
        required: ["path", "find", "replace"],
        additionalProperties: false
      },
      strict: true
    }
  },
  {
    type: "function",
    function: {
      name: "copy_asset_file",
      description:
        "Copy a binary asset (font, image, etc.) from the centralized widget asset library into the workspace. Trailing -<8 hex> hash suffixes are stripped from both source lookup and destination filenames.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Asset filename in the centralized widget asset library (basename only)."
          },
          path: {
            type: "string",
            description: "Workspace-relative destination path, including filename."
          }
        },
        required: ["source", "path"],
        additionalProperties: false
      },
      strict: true
    }
  }
];

const RELOAD_EMULATOR_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "reload_emulator",
    description:
      "Host-executed: re-applies the current workspace path to the embedded emulator, **re-reads `conf.json` from disk**, restarts the widget/game process, and refreshes deploy eligibility in the UI. Call after creating or editing `conf.json` (especially when the workspace started empty), or when the preview is stale.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    strict: true
  }
};

/** Default tool surface: workspace file tools + deferred skills + project intake helper. */
export const AGENT_TOOL_SCHEMAS: ChatCompletionTool[] = [
  ...AGENT_FILE_TOOL_SCHEMAS,
  GET_DARTSNUT_SKILL_TOOL,
  RELOAD_EMULATOR_TOOL,
  DARTSNUT_PROJECT_INTAKE_TOOL
];

/** Intake-only session: host tool exclusively (no writes to the placeholder workspace). */
export const AGENT_CREATION_INTAKE_TOOL_SCHEMAS: ChatCompletionTool[] = [DARTSNUT_PROJECT_INTAKE_TOOL];
