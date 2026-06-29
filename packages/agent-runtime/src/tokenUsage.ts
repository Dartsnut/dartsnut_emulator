import type { AgentSessionTokenUsage, AgentTokenUsage } from "@dartsnut/shared-ipc";

function readTokenCount(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function hasAnyUsage(usage: AgentTokenUsage): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.totalTokens > 0;
}

export function normalizeTokenUsage(value: unknown): AgentTokenUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const inputTokens =
    readTokenCount(record, "inputTokens") ??
    readTokenCount(record, "input_tokens") ??
    readTokenCount(record, "prompt_tokens");
  const outputTokens =
    readTokenCount(record, "outputTokens") ??
    readTokenCount(record, "output_tokens") ??
    readTokenCount(record, "completion_tokens");
  const totalTokens = readTokenCount(record, "totalTokens") ?? readTokenCount(record, "total_tokens");
  if (inputTokens === null || outputTokens === null) {
    return null;
  }
  const usage = {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? inputTokens + outputTokens
  };
  return hasAnyUsage(usage) ? usage : null;
}

export function addTokenUsage(a: AgentTokenUsage, b: AgentTokenUsage): AgentTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens
  };
}

export function addRunTokenUsage(
  existing: AgentSessionTokenUsage | null | undefined,
  runUsage: AgentTokenUsage
): AgentSessionTokenUsage {
  const base = existing ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    ...addTokenUsage(base, runUsage),
    lastRun: runUsage
  };
}
