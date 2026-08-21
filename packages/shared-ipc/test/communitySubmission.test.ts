import { describe, expect, it } from "vitest";
import {
  communityProjectMatchesWorkspace,
  communityVersionState,
  hasBlockingCommunityVersion,
  hasCommunityVersionNumber
} from "../src/communitySubmission";
import type { CommunityAppSummary, CommunityVersionSummary, CommunityWorkspaceDefaults } from "../src/contracts";

const version = (status: string, versionNumber = "1.0.0", reviewAction = ""): CommunityVersionSummary => ({
  id: 1,
  appSystemId: 2,
  projectType: "game",
  version: versionNumber,
  description: "Release",
  status,
  createdAt: null,
  updatedAt: null,
  reviewAction,
  reviewComment: "",
  reviewedAt: null,
  preview: []
});

it("maps the creator lifecycle statuses", () => {
  expect(communityVersionState("0").key).toBe("draft");
  expect(communityVersionState("1").key).toBe("review");
  expect(communityVersionState("-1").key).toBe("rejected");
  expect(communityVersionState("2").key).toBe("approved");
  expect(communityVersionState("3").key).toBe("published");
  expect(communityVersionState("-2", "withdraw").key).toBe("withdrawn");
  expect(communityVersionState("-2", "revoke").key).toBe("revoked");
});

describe("submission guards", () => {
  it("blocks only draft or in-review versions", () => {
    expect(hasBlockingCommunityVersion([version("-1"), version("3")])).toBe(false);
    expect(hasBlockingCommunityVersion([version("1")])).toBe(true);
    expect(hasBlockingCommunityVersion([version("0")])).toBe(true);
  });

  it("detects reused version values case-insensitively", () => {
    expect(hasCommunityVersionNumber([version("-1", "V1.2.0")], "v1.2.0")).toBe(true);
    expect(hasCommunityVersionNumber([version("-1", "1.2.0")], "1.2.1")).toBe(false);
  });
});

it("matches projects to the open workspace by type and app id", () => {
  const project: CommunityAppSummary = {
    id: 2,
    appId: "demo",
    appName: "Demo",
    projectType: "game",
    mainCover: "",
    description: "",
    status: "1",
    createdAt: null
  };
  const workspace: CommunityWorkspaceDefaults = {
    eligible: true,
    appId: "demo",
    projectType: "game",
    appName: "Demo",
    version: "1.0.0",
    description: "",
    widgetSize: ""
  };
  expect(communityProjectMatchesWorkspace(project, workspace)).toBe(true);
  expect(communityProjectMatchesWorkspace({ ...project, projectType: "widget" }, workspace)).toBe(false);
});
