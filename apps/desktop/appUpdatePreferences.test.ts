import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAutoUpdatePreference, writeAutoUpdatePreference } from "./appUpdatePreferences.ts";

describe("auto-update preference", () => {
  it("defaults to disabled when file is missing or malformed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-update-preference-"));
    const filePath = path.join(root, "preferences.json");
    expect(readAutoUpdatePreference(filePath)).toBe(false);
    fs.writeFileSync(filePath, "not json");
    expect(readAutoUpdatePreference(filePath)).toBe(false);
  });

  it("persists enabled and disabled values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-update-preference-"));
    const filePath = path.join(root, "nested", "preferences.json");
    writeAutoUpdatePreference(filePath, true);
    expect(readAutoUpdatePreference(filePath)).toBe(true);
    writeAutoUpdatePreference(filePath, false);
    expect(readAutoUpdatePreference(filePath)).toBe(false);
  });
});
