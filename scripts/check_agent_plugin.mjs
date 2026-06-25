#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const pluginRoot = path.join(repoRoot, "plugins", "dartsnut-agent");
const sourceSkillsDir = path.join(repoRoot, "packages", "agent-runtime", "skills");

const exportedSkills = [
  "karpathy-guidelines",
  "creator-incremental",
  "conf-contract",
  "pydartsnut-core",
  "pydartsnut-game-io",
  "pydartsnut-widget-loop",
  "widget-fonts",
  "game-dart-colors",
  "dartsnut-display-mapping",
  "design-console-smallform",
  "asset-pipeline",
  "dartsnut-skill"
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFile(relativePath) {
  assert(fs.existsSync(path.join(repoRoot, relativePath)), `Missing file: ${relativePath}`);
}

const codexManifest = readJson("plugins/dartsnut-agent/.codex-plugin/plugin.json");
assert(codexManifest.name === "dartsnut-agent", "Codex manifest name must be dartsnut-agent");
assert(codexManifest.version === "0.1.0", "Codex manifest version must be 0.1.0");
assert(codexManifest.skills === "./skills/", "Codex manifest must point at ./skills/");
assert(codexManifest.interface?.displayName === "Dartsnut Agent", "Codex display name is missing");

assert(codexManifest.mcpServers === "./.mcp.json", "Codex manifest must opt into .mcp.json");
assert(
  codexManifest.interface?.capabilities?.includes("MCP"),
  "Codex manifest capabilities must include MCP"
);

const claudeManifest = readJson("plugins/dartsnut-agent/.claude-plugin/plugin.json");
assert(claudeManifest.name === "dartsnut-agent", "Claude manifest name must be dartsnut-agent");
assert(!("version" in claudeManifest), "Claude manifest intentionally omits version for git commit updates");

const codexMarketplace = readJson(".agents/plugins/marketplace.json");
assert(codexMarketplace.plugins?.[0]?.source?.path === "./plugins/dartsnut-agent", "Codex marketplace path is wrong");

const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
assert(claudeMarketplace.plugins?.[0]?.source === "./plugins/dartsnut-agent", "Claude marketplace path is wrong");

assertFile("plugins/dartsnut-agent/.mcp.json");

for (const skillId of exportedSkills) {
  assertFile(`packages/agent-runtime/skills/${skillId}.md`);
  const exportedPath = `plugins/dartsnut-agent/skills/${skillId}/SKILL.md`;
  assertFile(exportedPath);
  const body = fs.readFileSync(path.join(repoRoot, exportedPath), "utf8");
  assert(body.startsWith("---\n"), `${exportedPath} must start with frontmatter`);
  assert(body.includes(`name: ${skillId}`), `${exportedPath} is missing the skill name`);
  assert(body.includes("description:"), `${exportedPath} is missing a description`);
}

const extraSourceSkills = fs
  .readdirSync(sourceSkillsDir)
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length))
  .filter((skillId) => !exportedSkills.includes(skillId))
  .sort();

const expectedInternalOnly = ["creation-intake", "game-creator", "widget-creator"];
assert(
  JSON.stringify(extraSourceSkills) === JSON.stringify(expectedInternalOnly),
  `Unexpected non-exported skills: ${extraSourceSkills.join(", ")}`
);

console.log("Dartsnut agent plugin structure is valid.");
