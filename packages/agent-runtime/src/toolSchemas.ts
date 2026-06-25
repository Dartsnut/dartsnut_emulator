/**
 * OpenAI Chat Completions function definitions for the agent runtime's tools.
 *
 * File tools mirror `SessionEngine.normalizeAction` / `executeAction`.
 * `dartsnut_project_intake` and `dartsnut_ask_question` are executed by the host (Electron main) when configured.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import { DEFERRED_SKILL_IDS } from "./skillBundle";

const GET_DARTSNUT_SKILL_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_dartsnut_skill",
    description: [
      "Load markdown for a **Dartsnut house skill** (incremental scaffold, conf contract, pydartsnut runtime, display mapping, assets, etc.).",
      "Load **just-in-time** when the **upcoming step** needs it — decide from **meaning** in English, Simplified Chinese, or Traditional Chinese, not exact keywords (e.g. user offers a picture → `asset-pipeline`, then Assets pane bind — not chat paste).",
      "Per the router: always `creator-incremental`, `conf-contract`, `pydartsnut-core` first for new projects; other ids only when that step needs them.",
      "Call before write_file / replace_in_file / copy_asset_file for the step you are on. Not for workspace files — use read_file. Returns JSON with `content` when `ok` is true."
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

const DARTSNUT_ASK_QUESTION_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "dartsnut_ask_question",
    description: [
      "Dartsnut Agent **creation intake** only (host-executed). Presents a **blocking** question in the desktop UI — the call does not return until the user answers.",
      "Use native `tool_calls` only. Prefer this whenever the user must choose in the UI rather than inferring from their message.",
      "**question_id** `project_type` — Game vs Widget chips; on success updates the same intake state as `set_project_type`.",
      "**question_id** `widget_display_size` — only when intake is already `widget`; shows WxH chips; on success same as `set_widget_size`.",
      "Policy: if project type or widget size is uncertain, ask first; do not guess or default."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        question_id: {
          type: "string",
          enum: ["project_type", "widget_display_size"],
          description: "Which blocking intake question to present."
        }
      },
      required: ["question_id"],
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
      "Dartsnut Agent **new-project / workspace** setup (host-executed). Use standard `tool_calls` only.",
      "Actions:",
      "- **set_project_type** — record whether the user is building a `game` or `widget` (required before scaffolding). Use when the user already stated it clearly in text; otherwise call **`dartsnut_ask_question`** with `question_id` `project_type` first.",
      "- **set_widget_size** — for widgets only; one of the supported WxH tokens. Use when the user already named a supported size; otherwise call **`dartsnut_ask_question`** with `widget_display_size` first.",
      "- Never default project_type or widget_size when uncertain; ask the user.",
      "- **read_workspace_conf** — reads `conf.json` in the **selected** workspace and reports deploy-style validity plus guidance. **If no workspace is selected yet**, the host **creates** an empty directory under the OS temp folder, selects it, then reads — call after type (and widget size if applicable) are resolved; call again if the user switches workspace via the app shell.",
      "Typical order when starting from no workspace: infer or **`dartsnut_ask_question`(`project_type`)** → if widget, infer size or **`dartsnut_ask_question`(`widget_display_size`)** then `set_widget_size` when needed → **`read_workspace_conf`** (host allocates temp workspace on first call if needed), then ask **one** focused follow-up question when the snapshot shows an existing project or invalid `conf.json`."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set_project_type", "set_widget_size", "read_workspace_conf"]
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

const DARTSNUT_MACHINE_MCP_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "dartsnut_machine_mcp",
    description: [
      "Host-executed bridge to a real Dartsnut machine MCP service. Use only when the task requires interacting with physical hardware, firmware state, or live machine capabilities.",
      "Call `connect` first; the desktop host will ask the user to select a logged-in machine or enter an IP address, then connect to `http://<host>:9252/mcp`.",
      "After connecting, call `list_tools` to discover what this machine supports. Use `call_tool` only with a discovered tool name and JSON arguments.",
      "Do not assume firmware tool names before discovery."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["connect", "list_tools", "call_tool", "disconnect"],
          description: "MCP operation to perform."
        },
        tool_name: {
          type: "string",
          description: "Required when action is `call_tool`; must be a name returned by `list_tools`."
        },
        arguments: {
          type: "object",
          description: "JSON arguments forwarded to the discovered MCP tool when action is `call_tool`."
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
      name: "grep_files",
      description:
        "Search workspace file contents with a regular expression. Returns matching lines with their workspace-relative path and 1-based line number. Use this to find where something is defined or used before reading or editing. Binary files, `.dartsnut/`, and `node_modules/` are skipped.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "JavaScript regular expression to match against each line."
          },
          glob: {
            type: "string",
            description:
              "Optional filename glob to restrict the search (e.g. `**/*.py`, `assets/**`). Matches the workspace-relative path."
          },
          path: {
            type: "string",
            description: "Optional workspace-relative subdirectory to search within. Defaults to the workspace root."
          },
          ignore_case: {
            type: "boolean",
            description: "Case-insensitive matching when true. Defaults to false."
          },
          max_results: {
            type: "number",
            description: "Maximum number of matching lines to return (default 200, hard cap 1000)."
          }
        },
        required: ["pattern"],
        additionalProperties: false
      },
      strict: false
    }
  },
  {
    type: "function",
    function: {
      name: "glob_files",
      description:
        "List workspace files whose relative path matches a glob pattern (e.g. `**/*.py`, `fonts/**`, `conf.json`). Returns sorted workspace-relative paths. Use to discover files by name/extension before reading them.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern matched against the workspace-relative path. Supports `*`, `?`, and `**`."
          },
          path: {
            type: "string",
            description: "Optional workspace-relative subdirectory to search within. Defaults to the workspace root."
          },
          max_results: {
            type: "number",
            description: "Maximum number of paths to return (default 500, hard cap 2000)."
          }
        },
        required: ["pattern"],
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
        "Read the UTF-8 contents of a workspace file. Omit offset/limit to read the whole file (use this before replace_in_file so your `find` text matches exactly). Pass offset/limit to read a line range of a large file; ranged reads come back with line-number prefixes for reference only — strip them before using the text in edits. Do not use for binary assets — use copy_asset_file for fonts and images.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path to read."
          },
          offset: {
            type: "number",
            description: "1-based line number to start reading from. When set, the response is a numbered slice rather than the raw whole file."
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read starting at offset. Defaults to 2000 when offset is set."
          }
        },
        required: ["path"],
        additionalProperties: false
      },
      strict: false
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
        "Replace `find` with `replace` inside an existing workspace file. By default replaces a single occurrence and FAILS if `find` is not present or matches more than once — when that happens, include more surrounding context in `find` to make it unique, or set replace_all to true. Prefer this over write_file when editing existing files.",
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
              "Exact text to locate inside the file. Must be non-empty. Unless replace_all is true, it must match exactly one occurrence."
          },
          replace: {
            type: "string",
            description: "Replacement text. May be empty to delete the matched span."
          },
          replace_all: {
            type: "boolean",
            description: "When true, replace every occurrence of `find` instead of requiring a unique match. Defaults to false."
          }
        },
        required: ["path", "find", "replace"],
        additionalProperties: false
      },
      strict: false
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
      "Host-executed: re-applies the current workspace path to the embedded emulator, **re-reads `conf.json` from disk**, restarts the widget/game process, and refreshes deploy eligibility in the UI. After reload, call **get_emulator_logs** to confirm the project starts without Python errors.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    strict: true
  }
};

const GET_EMULATOR_LOGS_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_emulator_logs",
    description:
      "Host-executed: returns recent Python bridge **stdout/stderr** from the embedded emulator plus running/status/lastError. Use after **reload_emulator** (or when debugging) to verify the widget compiles and runs — scan for Traceback, SyntaxError, or ModuleNotFoundError before continuing.",
    parameters: {
      type: "object",
      properties: {
        max_lines: {
          type: "number",
          description: "Maximum log lines to return (default 80, max 200)."
        }
      },
      additionalProperties: false
    },
    strict: true
  }
};

const CHECK_PYTHON_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "check_python",
    description:
      "Host-executed **syntax check** (no execution): runs `python -m py_compile` on the given workspace file(s). Use it as a fast check after writing/editing `main.py` (and before `reload_emulator`) to catch SyntaxError early. Returns `{ ok, errors }`; an empty `errors` array means the files parse. This does NOT run the program — use `reload_emulator` + `get_emulator_logs` to verify runtime behavior.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Workspace-relative Python files to compile. Defaults to [\"main.py\"] when omitted."
        }
      },
      additionalProperties: false
    },
    strict: false
  }
};

const SEARCH_TOOL_NAMES = ["grep_files", "glob_files"] as const;

function fileTool(name: string): ChatCompletionTool {
  return AGENT_FILE_TOOL_SCHEMAS.find((t) => t.type === "function" && t.function?.name === name)!;
}

/** Default / full tool surface: file + search tools, deferred skills, emulator verify, check_python, project intake. */
export const AGENT_TOOL_SCHEMAS: ChatCompletionTool[] = [
  ...AGENT_FILE_TOOL_SCHEMAS,
  GET_DARTSNUT_SKILL_TOOL,
  RELOAD_EMULATOR_TOOL,
  GET_EMULATOR_LOGS_TOOL,
  CHECK_PYTHON_TOOL,
  DARTSNUT_ASK_QUESTION_TOOL,
  DARTSNUT_PROJECT_INTAKE_TOOL,
  DARTSNUT_MACHINE_MCP_TOOL
];

export type AgentToolSchemaDefinition = {
  description: string;
  parameters: Record<string, unknown>;
};

/** Asset applier: bind art to existing slots (no copy_asset_file, no intake). */
export const AGENT_ASSET_APPLIER_TOOL_SCHEMAS: ChatCompletionTool[] = [
  fileTool("list_files"),
  ...SEARCH_TOOL_NAMES.map(fileTool),
  fileTool("read_file"),
  fileTool("write_file"),
  fileTool("replace_in_file"),
  GET_DARTSNUT_SKILL_TOOL,
  RELOAD_EMULATOR_TOOL,
  GET_EMULATOR_LOGS_TOOL,
  CHECK_PYTHON_TOOL
];

const ALL_TOOL_SCHEMAS: ChatCompletionTool[] = [
  ...AGENT_TOOL_SCHEMAS,
  ...AGENT_ASSET_APPLIER_TOOL_SCHEMAS
];

/** Lookup a tool's JSON Schema parameters (Gemini-compatible explicit `type` fields). */
export function getAgentToolDefinition(name: string): AgentToolSchemaDefinition | undefined {
  const seen = new Set<string>();
  for (const entry of ALL_TOOL_SCHEMAS) {
    if (entry.type !== "function" || entry.function?.name !== name) {
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const parameters = entry.function.parameters;
    if (!parameters || typeof parameters !== "object") {
      return undefined;
    }
    return {
      description: entry.function.description ?? name,
      parameters: parameters as Record<string, unknown>
    };
  }
  return undefined;
}
