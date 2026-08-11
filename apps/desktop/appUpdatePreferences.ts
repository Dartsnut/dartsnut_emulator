import fs from "node:fs";
import path from "node:path";

export function readAutoUpdatePreference(filePath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { autoDownload?: unknown };
    return parsed.autoDownload === true;
  } catch {
    return false;
  }
}

export function writeAutoUpdatePreference(filePath: string, enabled: boolean): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ autoDownload: enabled }, null, 2));
}
