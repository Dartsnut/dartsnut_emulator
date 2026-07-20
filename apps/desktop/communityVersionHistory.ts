import type { CommunityVersionSummary } from "@dartsnut/shared-ipc";

function normalizedVersion(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * A successful submit response arrives before the creator-version list can
 * reflect the new row. A version number is unique within one project, so it
 * is a safe acknowledgement key when the legacy endpoint omits an id.
 */
export function isSameCommunityVersion(
  left: Pick<CommunityVersionSummary, "id" | "version">,
  right: Pick<CommunityVersionSummary, "id" | "version">
): boolean {
  if (String(left.id).trim() && String(left.id) === String(right.id)) return true;
  const leftVersion = normalizedVersion(left.version);
  const rightVersion = normalizedVersion(right.version);
  return Boolean(leftVersion && rightVersion && leftVersion === rightVersion);
}

export function mergeCommunityVersionHistory(
  serverVersions: CommunityVersionSummary[],
  pendingVersions: CommunityVersionSummary[]
): { versions: CommunityVersionSummary[]; pendingVersions: CommunityVersionSummary[] } {
  const unresolvedPending = pendingVersions.filter(
    (pending) => !serverVersions.some((version) => isSameCommunityVersion(version, pending))
  );
  return {
    // Keep a just-submitted release at the head of the rail until the server
    // returns it, then show the authoritative server row in its place.
    versions: [...unresolvedPending, ...serverVersions],
    pendingVersions: unresolvedPending
  };
}
