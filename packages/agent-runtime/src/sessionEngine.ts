import fs from "node:fs";
import path from "node:path";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import { WorkspacePolicy } from "./workspacePolicy";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CompletionProvider {
  complete(messages: ChatMessage[]): Promise<string>;
}

type ToolAction =
  | {
      tool: "list_files";
      path?: string;
    }
  | {
      tool: "read_file";
      path: string;
    }
  | {
      tool: "write_file";
      path: string;
      content: string;
    };

interface AgentActionEnvelope {
  response?: string;
  actions?: ToolAction[];
}

export interface SessionEngineOptions {
  provider: CompletionProvider;
  workspacePolicy: WorkspacePolicy;
  skillPrompt: string;
}

export class SessionEngine {
  constructor(private readonly options: SessionEngineOptions) {}

  private buildToolPrompt(): string {
    return [
      "You can use tools by returning STRICT JSON only.",
      "Schema: {\"response\": string, \"actions\": ToolAction[]}",
      "ToolAction variants:",
      "- {\"tool\":\"list_files\",\"path\":\".\"}",
      "- {\"tool\":\"read_file\",\"path\":\"relative/path.txt\"}",
      "- {\"tool\":\"write_file\",\"path\":\"relative/path.txt\",\"content\":\"...\"}",
      "Rules:",
      "1) Use relative paths only.",
      "2) Request tool actions when needed; after results, return final response with empty actions.",
      "3) Do not wrap JSON in markdown fences."
    ].join("\n");
  }

  private tryParseEnvelope(raw: string): AgentActionEnvelope | null {
    try {
      return JSON.parse(raw) as AgentActionEnvelope;
    } catch {
      return null;
    }
  }

  private listFiles(relativePath?: string): string[] {
    const root = this.options.workspacePolicy.resolveWithinRoot(relativePath ?? ".");
    const output: string[] = [];
    const stack = [root];
    while (stack.length > 0 && output.length < 200) {
      const current = stack.pop()!;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const rel = path.relative(
          this.options.workspacePolicy.resolveWithinRoot("."),
          absolute
        );
        if (entry.isDirectory()) {
          stack.push(absolute);
        } else {
          output.push(rel);
          if (output.length >= 200) {
            break;
          }
        }
      }
    }
    return output.sort();
  }

  private executeAction(action: ToolAction): string {
    if (action.tool === "list_files") {
      const files = this.listFiles(action.path);
      return JSON.stringify({ ok: true, files });
    }
    if (action.tool === "read_file") {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.stringify({ ok: true, path: action.path, content });
    }
    const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, action.content, "utf-8");
    return JSON.stringify({ ok: true, path: action.path, bytes: Buffer.byteLength(action.content) });
  }

  private readPreviousContent(action: ToolAction): string | undefined {
    if (action.tool !== "write_file") {
      return undefined;
    }
    try {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return undefined;
    }
  }

  async runPrompt(
    prompt: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<string> {
    // Sanity probe to ensure workspace guard is active from the first turn.
    this.options.workspacePolicy.resolveWithinRoot(".");

    const messages: ChatMessage[] = [
      { role: "system", content: this.options.skillPrompt },
      { role: "system", content: this.buildToolPrompt() },
      { role: "user", content: prompt }
    ];

    for (let step = 0; step < 4; step += 1) {
      if (step > 0) {
        onEvent({ type: "status", message: "Agent is thinking...", at: Date.now() });
      }
      const raw = await this.options.provider.complete(messages);
      const parsed = this.tryParseEnvelope(raw);

      if (!parsed) {
        onEvent({ type: "final", content: raw, at: Date.now() });
        return raw;
      }

      const actions = parsed.actions ?? [];
      if (actions.length === 0) {
        const finalText = parsed.response ?? "Done.";
        onEvent({ type: "final", content: finalText, at: Date.now() });
        return finalText;
      }

      // Surface tool action payloads to the UI so chat can render
      // rolling previews and final diff-style file change messages.
      const uiActions = actions.map((action) => {
        if (action.tool !== "write_file") {
          return action;
        }
        return {
          ...action,
          previousContent: this.readPreviousContent(action)
        };
      });
      const uiEnvelope = JSON.stringify(
        {
          response: parsed.response,
          actions: uiActions
        },
        null,
        2
      );
      onEvent({ type: "final", content: uiEnvelope, at: Date.now() });

      onEvent({
        type: "status",
        message: `Executing ${actions.length} tool action(s)...`,
        at: Date.now()
      });

      const toolResults = actions.map((action) => {
        try {
          return { action, result: this.executeAction(action) };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown tool error";
          return { action, result: JSON.stringify({ ok: false, error: message }) };
        }
      });

      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `TOOL_RESULTS:\n${JSON.stringify(toolResults, null, 2)}`
      });
    }

    const fallback = "Tool loop limit reached before final response.";
    onEvent({ type: "error", message: fallback, at: Date.now() });
    return fallback;
  }
}
