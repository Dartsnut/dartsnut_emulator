/**
 * Pure helpers for comparing persisted temp-workspace paths with the active workspace root.
 * Main process should pass normalized absolute paths when possible.
 */
export function normalizeFsPathComparable(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
}

/** True when the UI should treat the workspace as the tracked unsaved temp project. */
export function isTemporaryWorkspaceForBootstrap(
  workspaceRoot: string | null,
  trackedTempPath: string | null
): boolean {
  if (!workspaceRoot || !trackedTempPath) {
    return false;
  }
  return normalizeFsPathComparable(workspaceRoot) === normalizeFsPathComparable(trackedTempPath);
}
