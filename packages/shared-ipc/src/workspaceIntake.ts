/**
 * Whether the desktop should run creation intake (game/widget type, widget size)
 * before creator agent tools. Requires an active workspace with no conf.json yet.
 */
export function workspaceNeedsCreationIntake(
  workspaceRoot: string | null,
  confJsonExists: boolean
): boolean {
  if (!workspaceRoot) {
    return false;
  }
  return !confJsonExists;
}
