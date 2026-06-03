import type { AgentEvent } from "@dartsnut/shared-ipc";
import type { RunPromptOptions, SessionEngine } from "./sessionEngine";

export interface AgentSessionRuntimeOptions {
  workspacePath: string;
  engine: SessionEngine;
}

/**
 * Thin wrapper around SessionEngine — routing is handled by the orchestrator handoff graph.
 */
export class AgentSessionRuntime {
  constructor(private readonly options: AgentSessionRuntimeOptions) {}

  async runPrompt(
    prompt: string,
    onEvent: (event: AgentEvent) => void,
    abortSignal?: AbortSignal,
    runOptions?: RunPromptOptions
  ): Promise<string> {
    return this.options.engine.runPrompt(prompt, onEvent, abortSignal, runOptions);
  }
}
