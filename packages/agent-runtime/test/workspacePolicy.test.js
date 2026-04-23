import { describe, expect, it } from "vitest";
import { WorkspacePolicy } from "../src/workspacePolicy";
describe("WorkspacePolicy", () => {
    it("allows paths within workspace", () => {
        const guard = new WorkspacePolicy("/tmp/workspace");
        const path = guard.resolveWithinRoot("src/main.py");
        expect(path).toContain("/tmp/workspace");
    });
    it("rejects paths that escape root", () => {
        const guard = new WorkspacePolicy("/tmp/workspace");
        expect(() => guard.resolveWithinRoot("../outside.txt")).toThrow();
    });
});
