/**
 * OpenAI Chat Completions function definitions for the agent runtime's tools.
 *
 * These mirror the parameter validation in `SessionEngine.normalizeAction` and are sent on each
 * `chat/completions` request so the model can emit native `tool_calls`.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";

export const AGENT_TOOL_SCHEMAS: ChatCompletionTool[] = [
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
