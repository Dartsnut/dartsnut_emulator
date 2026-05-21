import { describe, expect, it } from "vitest";
import {
  isCreatorTemplateMode,
  isFileMutationToolName,
  readCreatorArtifactStatus
} from "../src/creatorTurnGuard";

describe("readCreatorArtifactStatus", () => {
  it("reports conf and main presence from existsSync", () => {
    const exists = new Set(["/ws/conf.json", "/ws/main.py"]);
    const status = readCreatorArtifactStatus(
      (p) => exists.has(p),
      (rel) => `/ws/${rel}`
    );
    expect(status).toEqual({ confJson: true, mainPy: true });
  });

  it("returns false when paths are missing", () => {
    const status = readCreatorArtifactStatus(
      () => false,
      (rel) => `/ws/${rel}`
    );
    expect(status).toEqual({ confJson: false, mainPy: false });
  });
});

describe("isCreatorTemplateMode", () => {
  it("is true for creator modes only", () => {
    expect(isCreatorTemplateMode("widget-creator")).toBe(true);
    expect(isCreatorTemplateMode("game-creator")).toBe(true);
    expect(isCreatorTemplateMode("asset-applier")).toBe(false);
    expect(isCreatorTemplateMode(null)).toBe(false);
  });
});

describe("isFileMutationToolName", () => {
  it("includes write, replace, and copy asset tools", () => {
    expect(isFileMutationToolName("write_file")).toBe(true);
    expect(isFileMutationToolName("replace_in_file")).toBe(true);
    expect(isFileMutationToolName("copy_asset_file")).toBe(true);
    expect(isFileMutationToolName("read_file")).toBe(false);
  });
});
