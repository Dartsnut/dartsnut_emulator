import type { AgentEvent } from "@dartsnut/shared-ipc";

const DEFAULT_BATCH_MS = 16;

type StreamKind = "stream" | "reasoning_stream";

function isBatchableStream(event: AgentEvent): event is AgentEvent & { type: StreamKind; delta: string } {
  return event.type === "stream" || event.type === "reasoning_stream";
}

export type AgentEventBatcher = {
  emit: (event: AgentEvent) => void;
  flush: () => void;
};

/**
 * Coalesces high-frequency stream/reasoning_stream deltas before IPC to the renderer.
 */
export function createAgentEventBatcher(
  deliver: (event: AgentEvent) => void,
  batchMs: number = DEFAULT_BATCH_MS
): AgentEventBatcher {
  const pending: Partial<Record<StreamKind, { delta: string; at: number }>> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushPending = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const kind of ["stream", "reasoning_stream"] as const) {
      const chunk = pending[kind];
      if (!chunk || chunk.delta.length === 0) {
        continue;
      }
      deliver({ type: kind, delta: chunk.delta, at: chunk.at });
      delete pending[kind];
    }
  };

  const scheduleFlush = () => {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      flushPending();
    }, batchMs);
  };

  return {
    emit(event: AgentEvent) {
      if (!isBatchableStream(event)) {
        flushPending();
        deliver(event);
        return;
      }
      const existing = pending[event.type];
      if (existing) {
        existing.delta += event.delta;
        existing.at = event.at;
      } else {
        pending[event.type] = { delta: event.delta, at: event.at };
      }
      scheduleFlush();
    },
    flush: flushPending
  };
}
