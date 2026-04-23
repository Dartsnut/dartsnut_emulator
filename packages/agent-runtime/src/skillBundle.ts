import fs from "node:fs";

export function loadSkillBundle(skillFilePath: string): string {
  if (!fs.existsSync(skillFilePath)) {
    throw new Error(`Skill bundle is missing at ${skillFilePath}`);
  }
  return fs.readFileSync(skillFilePath, "utf-8");
}
