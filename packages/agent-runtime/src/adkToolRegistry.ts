import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";

/**
 * Transitional wrapper for tool registration while migrating orchestration to ADK.
 * We intentionally preserve existing tool names and JSON contracts.
 */
export class AdkToolRegistry {
  constructor(private readonly tools: ChatCompletionTool[]) {}

  listTools(): ChatCompletionTool[] {
    return this.tools;
  }
}

