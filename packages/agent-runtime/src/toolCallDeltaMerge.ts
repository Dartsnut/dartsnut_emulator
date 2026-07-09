export type StreamingToolCallAccumulator = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type ToolCallDeltaLike = {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

function nextAccumulatorIndex(accumulators: Map<number, StreamingToolCallAccumulator>): number {
  return Math.max(-1, ...accumulators.keys()) + 1;
}

function latestAccumulatorEntry(
  accumulators: Map<number, StreamingToolCallAccumulator>
): [number, StreamingToolCallAccumulator] | undefined {
  let latest: [number, StreamingToolCallAccumulator] | undefined;
  for (const entry of accumulators.entries()) {
    if (!latest || entry[0] > latest[0]) {
      latest = entry;
    }
  }
  return latest;
}

function isCompleteJsonValue(value: string): boolean {
  if (!value.trim()) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function startsJsonObject(value: string): boolean {
  return value.trimStart().startsWith("{");
}

function resolveImplicitIndex(
  accumulators: Map<number, StreamingToolCallAccumulator>,
  fallbackIndex: number,
  name: string,
  args: string
): number {
  const latest = latestAccumulatorEntry(accumulators);
  if (!latest) {
    return fallbackIndex;
  }

  const [latestIndex, latestAcc] = latest;
  if (!name) {
    if (startsJsonObject(args) && isCompleteJsonValue(latestAcc.argumentsJson)) {
      return nextAccumulatorIndex(accumulators);
    }
    return latestIndex;
  }

  if (latestAcc.name === name && !isCompleteJsonValue(latestAcc.argumentsJson)) {
    return latestIndex;
  }
  if (latestAcc.name === name && args.length > 0 && !startsJsonObject(args)) {
    return latestIndex;
  }

  const preferred = accumulators.get(fallbackIndex);
  if (!preferred) {
    return fallbackIndex;
  }
  return nextAccumulatorIndex(accumulators);
}

export function mergeToolCallDeltas(
  accumulators: Map<number, StreamingToolCallAccumulator>,
  deltas: ToolCallDeltaLike[]
): number[] {
  const changedIndices: number[] = [];
  for (let i = 0; i < deltas.length; i += 1) {
    const delta = deltas[i];
    if (!delta) {
      continue;
    }
    const id = typeof delta.id === "string" && delta.id.length > 0 ? delta.id : "";
    const fn = delta.function;
    const name = typeof fn?.name === "string" && fn.name.length > 0 ? fn.name : "";
    const args = typeof fn?.arguments === "string" && fn.arguments.length > 0 ? fn.arguments : "";
    let index: number;
    if (typeof delta.index === "number") {
      index = delta.index;
    } else if (id) {
      const existingById = Array.from(accumulators.entries()).find(([, acc]) => acc.id === id);
      index = existingById?.[0] ?? nextAccumulatorIndex(accumulators);
    } else {
      index = resolveImplicitIndex(accumulators, i, name, args);
    }

    const existing =
      accumulators.get(index) ?? { id: "", name: "", argumentsJson: "" };
    if (id) {
      existing.id = id;
    }
    if (name) {
      existing.name = name;
    }
    if (args) {
      existing.argumentsJson += args;
    }
    accumulators.set(index, existing);
    changedIndices.push(index);
  }
  return changedIndices;
}
