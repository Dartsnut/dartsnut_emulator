import type { CommunityAppSummary, CommunityVersionSummary, CommunityWorkspaceDefaults } from "./contracts";

export type CommunityVersionStateKey =
  | "draft"
  | "review"
  | "rejected"
  | "approved"
  | "published"
  | "withdrawn"
  | "revoked"
  | "unknown";

export type CommunityVersionState = {
  key: CommunityVersionStateKey;
  label: string;
  blocksSubmission: boolean;
  canWithdraw: boolean;
};

export function communityVersionState(status: string, reviewAction = ""): CommunityVersionState {
  const normalizedStatus = String(status);
  const normalizedAction = String(reviewAction).trim().toLowerCase();
  switch (normalizedStatus) {
    case "-2":
      return normalizedAction === "withdraw"
        ? { key: "withdrawn", label: "Withdrawn", blocksSubmission: false, canWithdraw: false }
        : { key: "revoked", label: "Officially revoked", blocksSubmission: false, canWithdraw: false };
    case "-1":
      return { key: "rejected", label: "Rejected", blocksSubmission: false, canWithdraw: false };
    case "0":
      return { key: "draft", label: "Draft", blocksSubmission: true, canWithdraw: true };
    case "1":
      return { key: "review", label: "Under review", blocksSubmission: true, canWithdraw: true };
    case "2":
      return { key: "approved", label: "Approved · awaiting publication", blocksSubmission: false, canWithdraw: false };
    case "3":
      return { key: "published", label: "Published", blocksSubmission: false, canWithdraw: false };
    default:
      return { key: "unknown", label: normalizedStatus ? `Status ${normalizedStatus}` : "Created", blocksSubmission: false, canWithdraw: false };
  }
}

export function hasBlockingCommunityVersion(versions: CommunityVersionSummary[]): boolean {
  return versions.some((version) => communityVersionState(version.status, version.reviewAction).blocksSubmission);
}

export function hasCommunityVersionNumber(versions: CommunityVersionSummary[], version: string): boolean {
  const normalized = version.trim().toLowerCase();
  return Boolean(normalized) && versions.some((row) => row.version.trim().toLowerCase() === normalized);
}

export function communityProjectMatchesWorkspace(
  project: CommunityAppSummary | null | undefined,
  workspace: CommunityWorkspaceDefaults
): boolean {
  return Boolean(
    project &&
      workspace.eligible &&
      workspace.projectType === project.projectType &&
      workspace.appId.trim() === project.appId.trim()
  );
}
