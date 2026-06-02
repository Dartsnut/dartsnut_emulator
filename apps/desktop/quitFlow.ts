export type TempWorkspaceGuardReason = "quit" | "open_workspace" | "new_project";

export type BeforeQuitBridgeAction =
  | "proceed"
  | "mark_teardown_done"
  | "wait_for_inflight_teardown"
  | "start_teardown";

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

export function shouldAllocateTempWorkspaceAfterDiscard(reason?: TempWorkspaceGuardReason): boolean {
  return reason !== "quit";
}
