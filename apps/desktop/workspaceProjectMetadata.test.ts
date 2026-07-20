const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  syncPyprojectProjectMetadata,
  syncWorkspaceProjectMetadata
} = require("./dist-electron/workspaceProjectMetadata.js");

test("syncPyprojectProjectMetadata updates only project name and version", () => {
  const source = `# custom\n[project]\nname = "old"\nversion = "0.1.0"\ndependencies = ["demo==1"]\n\n[tool.demo]\nname = "untouched"\nversion = "also-untouched"\n`;
  const result = syncPyprojectProjectMetadata(source, "canonical-id", "2.3.4");
  assert.match(result, /\[project\]\nname = "canonical-id"\nversion = "2\.3\.4"/);
  assert.match(result, /dependencies = \["demo==1"\]/);
  assert.match(result, /\[tool\.demo\]\nname = "untouched"\nversion = "also-untouched"/);
});

test("syncPyprojectProjectMetadata inserts missing project fields", () => {
  const result = syncPyprojectProjectMetadata("[project]\nrequires-python = \">=3.11\"\n", "demo", "1.0.0");
  assert.match(result, /\[project\]\n\nname = "demo"\nversion = "1\.0\.0"\nrequires-python/);
});

test("syncWorkspaceProjectMetadata treats conf.json as canonical", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-metadata-"));
  try {
    fs.writeFileSync(path.join(workspace, "conf.json"), JSON.stringify({ id: "conf-id", version: "1.2.0", keep: true }, null, 2));
    fs.writeFileSync(path.join(workspace, "pyproject.toml"), "[project]\nname = \"wrong\"\nversion = \"0.0.1\"\ndependencies = []\n");
    assert.deepEqual(syncWorkspaceProjectMetadata(workspace), { appId: "conf-id", version: "1.2.0" });
    const pyproject = fs.readFileSync(path.join(workspace, "pyproject.toml"), "utf-8");
    assert.match(pyproject, /name = "conf-id"/);
    assert.match(pyproject, /version = "1\.2\.0"/);
    assert.match(pyproject, /dependencies = \[\]/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("syncWorkspaceProjectMetadata updates both version fields after confirmation", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-version-"));
  try {
    fs.writeFileSync(path.join(workspace, "conf.json"), JSON.stringify({ id: "demo", version: "1.0.0" }, null, 2));
    fs.writeFileSync(path.join(workspace, "pyproject.toml"), "[project]\nname = \"other\"\nversion = \"0.0.0\"\n");
    assert.deepEqual(syncWorkspaceProjectMetadata(workspace, "1.0.1"), { appId: "demo", version: "1.0.1" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, "conf.json"), "utf-8")).version, "1.0.1");
    const pyproject = fs.readFileSync(path.join(workspace, "pyproject.toml"), "utf-8");
    assert.match(pyproject, /name = "demo"/);
    assert.match(pyproject, /version = "1\.0\.1"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
