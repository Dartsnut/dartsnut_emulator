const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  updatePyprojectProjectVersion,
  syncWorkspaceProjectMetadata
} = require("./dist-electron/workspaceProjectMetadata.js");

test("updatePyprojectProjectVersion updates only project version", () => {
  const source = `# custom\n[project]\nname = "old"\nversion = "0.1.0"\ndependencies = ["demo==1"]\n\n[tool.demo]\nname = "untouched"\nversion = "also-untouched"\n`;
  const result = updatePyprojectProjectVersion(source, "2.3.4");
  assert.match(result, /\[project\]\nname = "old"\nversion = "2\.3\.4"/);
  assert.match(result, /dependencies = \["demo==1"\]/);
  assert.match(result, /\[tool\.demo\]\nname = "untouched"\nversion = "also-untouched"/);
});

test("updatePyprojectProjectVersion requires an existing project version", () => {
  assert.throws(() => updatePyprojectProjectVersion("[project]\nname = \"demo\"\n", "1.0.0"), /version/);
});

test("syncWorkspaceProjectMetadata reads pyproject.toml as canonical for a game", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-metadata-"));
  try {
    fs.writeFileSync(path.join(workspace, "pyproject.toml"), "[project]\nname = \"game-id\"\nversion = \"1.2.0\"\ndependencies = [\"pydartsnut\"]\n");
    assert.deepEqual(syncWorkspaceProjectMetadata(workspace), { appId: "game-id", version: "1.2.0" });
    const pyproject = fs.readFileSync(path.join(workspace, "pyproject.toml"), "utf-8");
    assert.match(pyproject, /name = "game-id"/);
    assert.match(pyproject, /version = "1\.2\.0"/);
    assert.match(pyproject, /dependencies = \["pydartsnut"\]/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("syncWorkspaceProjectMetadata updates only pyproject.toml version", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-version-"));
  try {
    fs.writeFileSync(path.join(workspace, "pyproject.toml"), "[project]\nname = \"demo\"\nversion = \"1.0.0\"\ndependencies = [\"pydartsnut\"]\n");
    assert.deepEqual(syncWorkspaceProjectMetadata(workspace, "1.0.1"), { appId: "demo", version: "1.0.1" });
    const pyproject = fs.readFileSync(path.join(workspace, "pyproject.toml"), "utf-8");
    assert.match(pyproject, /name = "demo"/);
    assert.match(pyproject, /version = "1\.0\.1"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
