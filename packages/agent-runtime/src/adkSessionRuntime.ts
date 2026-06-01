import type { AgentEvent } from "@dartsnut/shared-ipc";
import type { SessionEngine } from "./sessionEngine";
import { CreationWorkflow } from "./creationWorkflow";
import { ModificationWorkflow } from "./modificationWorkflow";
import { decideWorkflowRoute } from "./workflowRouter";

export interface AgentSessionRuntimeOptions {
  workspacePath: string;
  engine: SessionEngine;
}

/**
 * ADK runtime entrypoint: creation for new scaffolds, modification for existing projects.
 *
 * Creation runs until the session engine finishes (including clean emulator verify when applicable).
 * There is no automatic handoff to modification after creation.
 */
export class AgentSessionRuntime {
  private readonly creation: CreationWorkflow;
  private readonly modification: ModificationWorkflow;

  constructor(private readonly options: AgentSessionRuntimeOptions) {
    this.creation = new CreationWorkflow({
      engine: options.engine
    });
    this.modification = new ModificationWorkflow({
      engine: options.engine
    });
  }

  async runPrompt(
    prompt: string,
    onEvent: (event: AgentEvent) => void,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const route = decideWorkflowRoute(this.options.workspacePath);

    if (route.kind === "modification") {
      onEvent({
        type: "status",
        message: "Workflow: modification (existing project)",
        at: Date.now()
      });
      return this.modification.runPrompt({ userPrompt: prompt }, onEvent, abortSignal);
    }

    onEvent({
      type: "status",
      message: route.confExists
        ? "Workflow: creation (finishing scaffold)"
        : "Workflow: creation",
      at: Date.now()
    });

    return this.creation.runPrompt(prompt, onEvent, abortSignal);
  }
}

/** @deprecated compatibility alias while ADK-era naming is removed. */
export type AdkSessionRuntimeOptions = AgentSessionRuntimeOptions;
/** @deprecated compatibility alias while ADK-era naming is removed. */
export const AdkSessionRuntime = AgentSessionRuntime;
