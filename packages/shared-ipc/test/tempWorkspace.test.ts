import { describe, expect, it } from "vitest";
import { isTemporaryWorkspaceForBootstrap, normalizeFsPathComparable } from "../src/tempWorkspace";

describe("normalizeFsPathComparable", () => {
  it("normalizes slashes, trailing slashes, and case", () => {
    expect(normalizeFsPathComparable("C:\\Foo\\Bar\\")).toBe("c:/foo/bar");
    expect(normalizeFsPathComparable("/tmp/x")).toBe("/tmp/x");
  });
});

describe("isTemporaryWorkspaceForBootstrap", () => {
  it("is false when either argument is null", () => {
    expect(isTemporaryWorkspaceForBootstrap(null, "/tmp/a")).toBe(false);
    expect(isTemporaryWorkspaceForBootstrap("/tmp/a", null)).toBe(false);
  });

  it("is true when paths match after normalization", () => {
    expect(isTemporaryWorkspaceForBootstrap("/TMP/dartsnut-chat-abc", "/tmp/dartsnut-chat-abc/")).toBe(true);
  });

  it("is false when paths differ", () => {
    expect(isTemporaryWorkspaceForBootstrap("/tmp/a", "/tmp/b")).toBe(false);
  });
});
