import type { AgentEvent } from "@dartsnut/shared-ipc";
import type { SessionEngine } from "./sessionEngine";

export interface CreationWorkflowOptions {
  engine: SessionEngine;
}

export class CreationWorkflow {
  constructor(private readonly options: CreationWorkflowOptions) { }

  runPrompt(
    prompt: string,
    onEvent: (event: AgentEvent) => void,
    abortSignal?: AbortSignal
  ): Promise<string> {
    return this.options.engine.runPrompt(prompt, onEvent, abortSignal);
  }
}
