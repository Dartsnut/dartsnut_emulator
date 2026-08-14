/**
 * OpenAI Responses function definitions for the agent runtime's tools.
 *
 * File tools mirror `SessionEngine.normalizeAction` / `executeAction`.
 */

import { DEFERRED_SKILL_IDS } from "./skillBundle";

export type AgentToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
};
type ToolDefinition = Omit<AgentToolSchema, "type">;
type WrappedToolDefinition = { type: "function"; function: ToolDefinition };

function responseTool(definition: WrappedToolDefinition): AgentToolSchema {
  return { type: "function", ...definition.function };
}

const GET_DARTSNUT_SKILL_TOOL = responseTool({
  type: "function",
  function: {
    name: "get_dartsnut_skill",
    description:
      "Load one Dartsnut domain skill before editing related project files. Returns JSON with `content` when successful.",
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
});

const DARTSNUT_MACHINE_MCP_TOOL = responseTool({
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
});

/** File + asset tools only (no host intake). */
const AGENT_FILE_TOOL_DEFINITIONS: WrappedToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files inside the agent workspace, recursively. Returns paths relative to the workspace root. Generated dependency/cache directories including `.venv/`, `venv/`, `node_modules/`, `.dartsnut/`, and `.git/` are skipped.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative subdirectory to list. Defaults to the workspace root when omitted."
          },
          max_results: {
            type: "number",
            description: "Maximum number of paths to return (default 500, hard cap 2000)."
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
        "Search workspace file contents with a regular expression. Returns matching lines with their workspace-relative path and 1-based line number. Binary files and generated dependency/cache directories such as `.venv/`, `venv/`, `.dartsnut/`, and `node_modules/` are skipped.",
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
        "List workspace files whose relative path matches a glob pattern (e.g. `**/*.py`, `fonts/**`, `conf.json`). Generated dependency/cache directories such as `.venv/`, `venv/`, `.dartsnut/`, and `node_modules/` are skipped.",
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
  },
  {
    type: "function",
    function: {
      name: "copy_chat_attachment",
      description:
        "Copy a media file the user dropped into chat into an agent-chosen workspace path. Use this before referencing a chat attachment in code/config. The source path is private; select by attachment_id from the user prompt. Set overwrite=true only when intentionally replacing an existing workspace asset.",
      parameters: {
        type: "object",
        properties: {
          attachment_id: {
            type: "string",
            description: "Attachment ID shown in the prompt, e.g. chat-..."
          },
          path: {
            type: "string",
            description: "Workspace-relative destination path, including filename."
          },
          overwrite: {
            type: "boolean",
            description: "When true, replace an existing file at path. Defaults to false."
          }
        },
        required: ["attachment_id", "path"],
        additionalProperties: false
      },
      strict: false
    }
  }
];

export const AGENT_FILE_TOOL_SCHEMAS: AgentToolSchema[] = AGENT_FILE_TOOL_DEFINITIONS.map(responseTool);

const RELOAD_EMULATOR_TOOL = responseTool({
  type: "function",
  function: {
    name: "reload_emulator",
    description:
      "Host-executed: re-applies the current workspace path to the embedded emulator, **re-reads `conf.json` from disk**, restarts the widget/game process, and refreshes deploy eligibility in the UI. Optional params are passed as widget/game launch params, clear_inputs resets buttons/darts before reload, and wait_for_frame_ms waits for a fresh frame. After reload, call **observe_emulator** and **get_emulator_logs** to confirm the project starts without Python errors.",
    parameters: {
      type: "object",
      properties: {
        params: {
          type: "object",
          description: "Optional JSON params passed to the app on reload, matching widget params semantics."
        },
        clear_inputs: {
          type: "boolean",
          description: "When true, clear all darts and release all buttons before reloading."
        },
        wait_for_frame_ms: {
          type: "number",
          description: "Optional maximum milliseconds for the host to wait for a fresh frame after reload."
        }
      },
      additionalProperties: false
    },
    strict: false
  }
});

const OBSERVE_EMULATOR_TOOL = responseTool({
  type: "function",
  function: {
    name: "observe_emulator",
    description:
      "Host-executed: waits for or reads the latest emulator frame and returns current emulator state, recent logs, display mapping metadata, frame hashes, non-black bounds/occupancy, dominant colors, and optional PNG base64 for the full surface, cropped main surface, cropped bottom surface, and hardware mockup. Use after reload_emulator and after input scenarios to verify the display is nonblank and mapped correctly.",
    parameters: {
      type: "object",
      properties: {
        include_png: {
          type: "boolean",
          description: "When true, include PNG base64 for the logical surface plus cropped main/bottom panel surfaces when available."
        },
        include_hardware_mockup: {
          type: "boolean",
          description: "When true with include_png, include the hardware/mockup PNG in addition to the surface PNG."
        },
        wait_for_frame_ms: {
          type: "number",
          description: "Maximum milliseconds to wait for a current frame before returning an actionable error."
        },
        max_log_lines: {
          type: "number",
          description: "Recent emulator log lines to include with the observation."
        }
      },
      additionalProperties: false
    },
    strict: false
  }
});

const CONTROL_EMULATOR_INPUT_TOOL = responseTool({
  type: "function",
  function: {
    name: "control_emulator_input",
    description:
      "Host-executed: drives emulator input without using the renderer UI. Supports throw_dart, remove_dart, clear_darts, set_button, tap_button, and sequence. Use for game verification before observing the display and logs.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "object",
          description:
            "Input action. Shapes: {type:'throw_dart', index:0..11 or 'next', x, y}, {type:'remove_dart', x, y}, {type:'clear_darts'}, {type:'set_button', button, pressed}, {type:'tap_button', button, duration_ms}, or {type:'sequence', actions:[...]}"
        }
      },
      required: ["action"],
      additionalProperties: false
    },
    strict: false
  }
});

const RUN_EMULATOR_SCENARIO_TOOL = responseTool({
  type: "function",
  function: {
    name: "run_emulator_scenario",
    description:
      "Host-executed: runs a bounded emulator test scenario with steps such as reload, wait_frame, observe, input, delay, and logs. Hard caps are 30 steps, 30 seconds, and 4 observations. Use this for autonomous game/widget acceptance testing instead of many small tool calls.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: { type: "object" },
          description: "Ordered scenario steps: reload, wait_frame, observe, input, delay, or logs."
        },
        timeout_ms: {
          type: "number",
          description: "Optional total scenario timeout, capped by the host at 30000ms."
        }
      },
      required: ["steps"],
      additionalProperties: false
    },
    strict: false
  }
});

const GET_EMULATOR_LOGS_TOOL = responseTool({
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
});

const CHECK_PYTHON_TOOL = responseTool({
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
});

const SEARCH_TOOL_NAMES = ["grep_files", "glob_files"] as const;

function fileTool(name: string): AgentToolSchema {
  return AGENT_FILE_TOOL_SCHEMAS.find((tool) => tool.name === name)!;
}

/** Default tool surface: workspace, skills, emulator verification, and machine MCP. */
export const AGENT_TOOL_SCHEMAS: AgentToolSchema[] = [
  ...AGENT_FILE_TOOL_SCHEMAS,
  GET_DARTSNUT_SKILL_TOOL,
  RELOAD_EMULATOR_TOOL,
  GET_EMULATOR_LOGS_TOOL,
  OBSERVE_EMULATOR_TOOL,
  CONTROL_EMULATOR_INPUT_TOOL,
  RUN_EMULATOR_SCENARIO_TOOL,
  CHECK_PYTHON_TOOL,
  DARTSNUT_MACHINE_MCP_TOOL
];

export type AgentToolSchemaDefinition = {
  description: string;
  parameters: Record<string, unknown>;
};

/** Asset applier: bind art to existing slots (no copy_asset_file, no intake). */
export const AGENT_ASSET_APPLIER_TOOL_SCHEMAS: AgentToolSchema[] = [
  fileTool("list_files"),
  ...SEARCH_TOOL_NAMES.map(fileTool),
  fileTool("read_file"),
  fileTool("write_file"),
  fileTool("replace_in_file"),
  GET_DARTSNUT_SKILL_TOOL,
  RELOAD_EMULATOR_TOOL,
  GET_EMULATOR_LOGS_TOOL,
  OBSERVE_EMULATOR_TOOL,
  CONTROL_EMULATOR_INPUT_TOOL,
  RUN_EMULATOR_SCENARIO_TOOL,
  CHECK_PYTHON_TOOL
];

const ALL_TOOL_SCHEMAS: AgentToolSchema[] = [
  ...AGENT_TOOL_SCHEMAS,
  ...AGENT_ASSET_APPLIER_TOOL_SCHEMAS
];

/** Lookup a tool's JSON Schema parameters (Gemini-compatible explicit `type` fields). */
export function getAgentToolDefinition(name: string): AgentToolSchemaDefinition | undefined {
  const seen = new Set<string>();
  for (const entry of ALL_TOOL_SCHEMAS) {
    if (entry.name !== name) {
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const parameters = entry.parameters;
    if (!parameters || typeof parameters !== "object") {
      return undefined;
    }
    return {
      description: entry.description ?? name,
      parameters: parameters as Record<string, unknown>
    };
  }
  return undefined;
}
