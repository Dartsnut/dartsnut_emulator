import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspacePolicy } from "../src/workspacePolicy";

describe("WorkspacePolicy", () => {
  it("allows paths within workspace", () => {
    const root = path.resolve("/tmp/workspace");
    const guard = new WorkspacePolicy(root);
    expect(guard.resolveWithinRoot("src/main.py")).toBe(path.join(root, "src/main.py"));
  });

  it("rejects paths that escape root", () => {
    const guard = new WorkspacePolicy(path.resolve("/tmp/workspace"));
    expect(() => guard.resolveWithinRoot("../outside.txt")).toThrow();
  });
});
