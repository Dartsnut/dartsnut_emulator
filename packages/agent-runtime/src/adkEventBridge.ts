import type { AgentEvent } from "@dartsnut/shared-ipc";

export interface AdkEventBridge {
  emit: (event: AgentEvent) => void;
}

/**
 * Bridges runtime events into the existing renderer-facing AgentEvent stream.
 */
export function createAdkEventBridge(emit: (event: AgentEvent) => void): AdkEventBridge {
  return { emit };
}

