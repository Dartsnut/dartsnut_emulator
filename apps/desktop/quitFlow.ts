export interface ShutdownCleanupTask {
  name: string;
  run: () => Promise<unknown> | unknown;
}

export interface ShutdownCleanupFailure {
  name: string;
  reason: unknown;
}

export async function runShutdownCleanup(
  tasks: ShutdownCleanupTask[],
  onFailure: (failure: ShutdownCleanupFailure) => void,
): Promise<void> {
  const started = tasks.map((task) => {
    try {
      return Promise.resolve(task.run());
    } catch (reason) {
      return Promise.reject(reason);
    }
  });
  const settled = await Promise.allSettled(started);
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      onFailure({ name: tasks[index].name, reason: result.reason });
    }
  });
}

export function createShutdownCleanupRunner(
  taskFactory: () => ShutdownCleanupTask[],
  onFailure: (failure: ShutdownCleanupFailure) => void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = runShutdownCleanup(taskFactory(), onFailure);
    }
    return inFlight;
  };
}
