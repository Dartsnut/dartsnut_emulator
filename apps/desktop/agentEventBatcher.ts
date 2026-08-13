import type { AgentEvent } from "@dartsnut/shared-ipc";

export type AgentEventBatcher = {
  emit: (event: AgentEvent) => void;
  flush: () => void;
};

/**
 * Keeps the event sink interface stable while forwarding SDK events unchanged.
 */
export function createAgentEventBatcher(
  deliver: (event: AgentEvent) => void,
  _batchMs?: number
): AgentEventBatcher {
  return {
    emit: deliver,
    flush: () => {}
  };
}
