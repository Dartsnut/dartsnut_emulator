#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

const sourceSkillsDir = path.join(repoRoot, "packages", "agent-runtime", "skills");
const pluginRoot = path.join(repoRoot, "plugins", "dartsnut-agent");
const codexMarketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
const claudeMarketplacePath = path.join(repoRoot, ".claude-plugin", "marketplace.json");

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

const skillDescriptions = {
  "karpathy-guidelines":
    "Behavioral guidelines for surgical coding changes, verification, assumptions, and avoiding overcomplicated edits.",
  "creator-incremental":
    "Dartsnut workspace scaffold rules, just-in-time skill loading, file constraints, and emulator verification workflow.",
  "conf-contract":
    "Root conf.json schema, defaults, size rules, preview handling, and reload requirements for Dartsnut projects.",
  "pydartsnut-core":
    "Core pydartsnut integration: Dartsnut instance setup, framebuffer rules, loop guard, dependencies, and run steps.",
  "pydartsnut-game-io":
    "Dartsnut game main.py guidance for pygame loops, dart hits, buttons, and framebuffer updates.",
  "pydartsnut-widget-loop":
    "Dartsnut widget main.py guidance for Pillow rendering, widget_params, and update loop behavior.",
  "widget-fonts":
    "Dartsnut widget font catalog usage, font copy conventions, and safe font loading rules.",
  "game-dart-colors":
    "Dartsnut game dart slot color mapping based on dart_index modulo four.",
  "dartsnut-display-mapping":
    "Dartsnut display and framebuffer mapping rules for panels, physical screens, layout, clipping, and fonts.",
  "design-console-smallform":
    "Pixel-perfect compact UI guidance for console-style Dartsnut games and widgets.",
  "asset-pipeline":
    "Dartsnut asset manifest, loader-helper, placeholder, and apply-mode workflow for art-bearing entities.",
  "dartsnut-skill":
    "Legacy Dartsnut runtime index that routes to the granular pydartsnut, conf, display, and asset skills."
};

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function rimraf(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function normalizeSkillBody(skillId, body) {
  let normalized = body.replace(/\r\n/g, "\n").trimEnd();

  if (skillId !== "karpathy-guidelines") {
    normalized = normalized
      .replace(/get_dartsnut_skill/g, "the corresponding Dartsnut plugin skill")
      .replace(/`pydartsnut-skill`/g, "`dartsnut-skill`");
  }

  if (/^---\n[\s\S]*?\n---\n/.test(normalized)) {
    return normalized;
  }

  const description = skillDescriptions[skillId];
  return [
    "---",
    `name: ${skillId}`,
    `description: ${description}`,
    "license: MIT",
    "---",
    "",
    normalized
  ].join("\n");
}

function buildCodexManifest() {
  const manifest = {
    name: "dartsnut-agent",
    version: "0.1.0",
    description: "Dartsnut agent skills and firmware bridge for building games and widgets.",
    author: {
      name: "Dartsnut"
    },
    license: "MIT",
    keywords: ["dartsnut", "skills", "firmware", "mcp", "widgets", "games"],
    skills: "./skills/",
    interface: {
      displayName: "Dartsnut Agent",
      shortDescription: "Skills and firmware tools for Dartsnut machines.",
      longDescription:
        "Build, modify, and verify Dartsnut games and widgets with packaged domain skills and a local firmware MCP bridge.",
      developerName: "Dartsnut",
      category: "Developer Tools",
      capabilities: ["Write"],
      defaultPrompt: [
        "Build a Dartsnut game.",
        "Create a Dartsnut widget.",
        "Review my Dartsnut project."
      ],
      brandColor: "#00A88F"
    }
  };

  if (process.env.DARTSNUT_EXPORT_FIRMWARE_MCP === "1") {
    manifest.mcpServers = "./.mcp.json";
    manifest.interface.capabilities = ["Write", "MCP"];
  }

  return manifest;
}

function buildClaudeManifest() {
  return {
    name: "dartsnut-agent",
    description: "Dartsnut agent skills and firmware bridge for building games and widgets.",
    author: {
      name: "Dartsnut"
    }
  };
}

function buildMcpConfig() {
  return {
    mcpServers: {
      "dartsnut-firmware": {
        command: "node",
        args: ["./mcp/dartsnut-firmware-bridge.js"],
        env: {
          DARTSNUT_MACHINE_URL: "${DARTSNUT_MACHINE_URL}"
        }
      }
    }
  };
}

function buildCodexMarketplace() {
  return {
    name: "dartsnut",
    interface: {
      displayName: "Dartsnut"
    },
    plugins: [
      {
        name: "dartsnut-agent",
        source: {
          source: "local",
          path: "./plugins/dartsnut-agent"
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL"
        },
        category: "Developer Tools"
      }
    ]
  };
}

function buildClaudeMarketplace() {
  return {
    name: "dartsnut",
    owner: {
      name: "Dartsnut"
    },
    plugins: [
      {
        name: "dartsnut-agent",
        source: "./plugins/dartsnut-agent",
        description: "Dartsnut agent skills and firmware bridge."
      }
    ]
  };
}

function buildReadme() {
  return `# Dartsnut Agent Plugin

This plugin is generated from \`packages/agent-runtime/skills\`.

Do not edit generated skill files directly. Update the source Markdown files and run:

\`\`\`bash
pnpm run export:agent-plugin
\`\`\`

## Components

- Codex manifest: \`.codex-plugin/plugin.json\`
- Claude manifest: \`.claude-plugin/plugin.json\`
- Skills: \`skills/<skill-id>/SKILL.md\`
- Firmware MCP bridge stub: \`mcp/dartsnut-firmware-bridge.js\`

## Firmware MCP bridge

The repository includes an MCP config template for a local server named \`dartsnut-firmware\`, but
the plugin manifest does not enable it by default until the bridge is implemented. To export a
manifest that declares the MCP server, run:

\`\`\`bash
DARTSNUT_EXPORT_FIRMWARE_MCP=1 pnpm run export:agent-plugin
\`\`\`

The bridge entrypoint is \`mcp/dartsnut-firmware-bridge.js\` and reads
\`DARTSNUT_MACHINE_URL\` when the firmware bridge is implemented.
`;
}

function buildMcpBridge() {
  return `#!/usr/bin/env node
console.error("dartsnut-firmware MCP bridge is not implemented yet.");
console.error("Set DARTSNUT_MACHINE_URL when the firmware MCP bridge is added.");
process.exit(1);
`;
}

function validateSourceSkills() {
  for (const skillId of exportedSkills) {
    const sourcePath = path.join(sourceSkillsDir, `${skillId}.md`);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing source skill: ${path.relative(repoRoot, sourcePath)}`);
    }
  }
}

function generateInto(rootDir, codexMarketplaceFile, claudeMarketplaceFile) {
  rimraf(rootDir);

  for (const skillId of exportedSkills) {
    const sourcePath = path.join(sourceSkillsDir, `${skillId}.md`);
    const body = normalizeSkillBody(skillId, readText(sourcePath));
    writeText(path.join(rootDir, "skills", skillId, "SKILL.md"), `${body}\n`);
  }

  writeJson(path.join(rootDir, ".codex-plugin", "plugin.json"), buildCodexManifest());
  writeJson(path.join(rootDir, ".claude-plugin", "plugin.json"), buildClaudeManifest());
  writeJson(path.join(rootDir, ".mcp.json"), buildMcpConfig());
  writeText(path.join(rootDir, "README.md"), buildReadme());
  writeText(path.join(rootDir, "mcp", "dartsnut-firmware-bridge.js"), buildMcpBridge());

  writeJson(codexMarketplaceFile, buildCodexMarketplace());
  writeJson(claudeMarketplaceFile, buildClaudeMarketplace());
}

function listFiles(dirPath) {
  const files = [];
  if (!fs.existsSync(dirPath)) {
    return files;
  }

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else {
        files.push(path.relative(dirPath, entryPath).replace(/\\/g, "/"));
      }
    }
  };

  walk(dirPath);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function compareDirs(expectedDir, actualDir) {
  const expectedFiles = listFiles(expectedDir);
  const actualFiles = listFiles(actualDir);
  const diffs = [];

  for (const file of new Set([...expectedFiles, ...actualFiles])) {
    const expectedPath = path.join(expectedDir, file);
    const actualPath = path.join(actualDir, file);
    const expectedExists = fs.existsSync(expectedPath);
    const actualExists = fs.existsSync(actualPath);
    if (!expectedExists || !actualExists) {
      diffs.push(file);
      continue;
    }
    if (readText(expectedPath) !== readText(actualPath)) {
      diffs.push(file);
    }
  }

  return diffs;
}

function runCheck() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-plugin-"));
  const expectedPluginRoot = path.join(tempRoot, "plugins", "dartsnut-agent");
  const expectedCodexMarketplace = path.join(tempRoot, ".agents", "plugins", "marketplace.json");
  const expectedClaudeMarketplace = path.join(tempRoot, ".claude-plugin", "marketplace.json");

  try {
    generateInto(expectedPluginRoot, expectedCodexMarketplace, expectedClaudeMarketplace);
    const pluginDiffs = compareDirs(expectedPluginRoot, pluginRoot);
    const marketplaceDiffs = [];

    if (!fs.existsSync(codexMarketplacePath) || readText(codexMarketplacePath) !== readText(expectedCodexMarketplace)) {
      marketplaceDiffs.push(path.relative(repoRoot, codexMarketplacePath));
    }
    if (!fs.existsSync(claudeMarketplacePath) || readText(claudeMarketplacePath) !== readText(expectedClaudeMarketplace)) {
      marketplaceDiffs.push(path.relative(repoRoot, claudeMarketplacePath));
    }

    if (pluginDiffs.length > 0 || marketplaceDiffs.length > 0) {
      const changed = [
        ...pluginDiffs.map((file) => path.posix.join("plugins/dartsnut-agent", file)),
        ...marketplaceDiffs
      ];
      throw new Error(`Generated plugin is stale:\n${changed.map((file) => `- ${file}`).join("\n")}`);
    }
  } finally {
    rimraf(tempRoot);
  }
}

validateSourceSkills();

if (checkOnly) {
  runCheck();
  console.log("Dartsnut agent plugin export is up to date.");
} else {
  generateInto(pluginRoot, codexMarketplacePath, claudeMarketplacePath);
  console.log("Exported Dartsnut agent plugin.");
}
