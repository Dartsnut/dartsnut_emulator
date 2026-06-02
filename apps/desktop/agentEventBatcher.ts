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
  const pending: Partial<Record<StreamKind, { delta: string; at: number; reasoningId?: string }>> = {};
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
      if (kind === "reasoning_stream") {
        if (!chunk.reasoningId) {
          delete pending[kind];
          continue;
        }
        deliver({ type: kind, reasoningId: chunk.reasoningId, delta: chunk.delta, at: chunk.at });
      } else {
        deliver({ type: kind, delta: chunk.delta, at: chunk.at });
      }
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
        if (
          event.type === "reasoning_stream" &&
          existing.reasoningId &&
          existing.reasoningId !== event.reasoningId
        ) {
          flushPending();
        }
      }
      const current = pending[event.type];
      if (current) {
        current.delta += event.delta;
        current.at = event.at;
        if (event.type === "reasoning_stream") {
          current.reasoningId = event.reasoningId;
        }
      } else {
        pending[event.type] =
          event.type === "reasoning_stream"
            ? { delta: event.delta, at: event.at, reasoningId: event.reasoningId }
            : { delta: event.delta, at: event.at };
      }
      scheduleFlush();
    },
    flush: flushPending
  };
}
