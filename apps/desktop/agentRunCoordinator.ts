export type AgentRunLease = {
  abortController: AbortController;
  settle: () => void;
};

type ActiveAgentRun = {
  abortController: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
  didSettle: boolean;
};

/**
 * Ensures a replacement agent run cannot start until the previous run has
 * finished its provider/backend cleanup.
 */
export class AgentRunCoordinator {
  private activeRun: ActiveAgentRun | null = null;
  private transitionTail: Promise<void> = Promise.resolve();

  private async acquireTransition(): Promise<() => void> {
    let release!: () => void;
    const previous = this.transitionTail;
    this.transitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async begin(replacementReason = "replacement_run"): Promise<AgentRunLease> {
    const releaseTransition = await this.acquireTransition();
    try {
      const previous = this.activeRun;
      if (previous) {
        previous.abortController.abort(replacementReason);
        await previous.settled;
      }

      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      const run: ActiveAgentRun = {
        abortController: new AbortController(),
        settled,
        resolveSettled,
        didSettle: false
      };
      this.activeRun = run;

      return {
        abortController: run.abortController,
        settle: () => {
          if (run.didSettle) {
            return;
          }
          run.didSettle = true;
          if (this.activeRun === run) {
            this.activeRun = null;
          }
          run.resolveSettled();
        }
      };
    } finally {
      releaseTransition();
    }
  }

  hasActiveRun(): boolean {
    return this.activeRun !== null;
  }

  async cancelAndWait(reason = "cancel_requested"): Promise<boolean> {
    const releaseTransition = await this.acquireTransition();
    try {
      const run = this.activeRun;
      if (!run) {
        return false;
      }
      run.abortController.abort(reason);
      await run.settled;
      return true;
    } finally {
      releaseTransition();
    }
  }
}
