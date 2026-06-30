export type TempWorkspaceGuardReason = "quit" | "open_workspace" | "new_project";

export type BeforeQuitBridgeAction =
  | "proceed"
  | "mark_teardown_done"
  | "wait_for_inflight_teardown"
  | "start_teardown";

export type BeforeQuitDeployAction =
  | "proceed"
  | "mark_restore_done"
  | "wait_for_inflight_restore"
  | "start_restore";

export function decideBeforeQuitBridgeAction(args: {
  teardownDone: boolean;
  hasBridgeProcess: boolean;
  teardownInFlight: boolean;
}): BeforeQuitBridgeAction {
  if (args.teardownDone) {
    return "proceed";
  }
  if (!args.hasBridgeProcess) {
    return "mark_teardown_done";
  }
  if (args.teardownInFlight) {
    return "wait_for_inflight_teardown";
  }
  return "start_teardown";
}

export function decideBeforeQuitDeployAction(args: {
  restoreDone: boolean;
  connected: boolean;
  restoreInFlight: boolean;
}): BeforeQuitDeployAction {
  if (args.restoreDone) {
    return "proceed";
  }
  if (!args.connected) {
    return "mark_restore_done";
  }
  if (args.restoreInFlight) {
    return "wait_for_inflight_restore";
  }
  return "start_restore";
}

export function shouldAllocateTempWorkspaceAfterDiscard(reason?: TempWorkspaceGuardReason): boolean {
  return reason !== "quit";
}
