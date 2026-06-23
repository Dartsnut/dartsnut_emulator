const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPublishTarball, isPublishAllowedFile, stagePublishWorkspace } = require("./publishPackage.ts");

function listRelativeFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        out.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

test("publish allowlist includes app source, config, images and sounds", () => {
  assert.equal(isPublishAllowedFile("conf.json"), true);
  assert.equal(isPublishAllowedFile("pyproject.toml"), true);
  assert.equal(isPublishAllowedFile("main.py"), true);
  assert.equal(isPublishAllowedFile("sprites/player.PNG"), true);
  assert.equal(isPublishAllowedFile("sounds/click.wav"), true);
  assert.equal(isPublishAllowedFile(".dartsnut/agent-session/conversation.json"), false);
  assert.equal(isPublishAllowedFile("uv.lock"), false);
});

test("stagePublishWorkspace skips venvs and agent session files", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-publish-test-"));
  let stagePath = null;
  try {
    fs.writeFileSync(path.join(workspace, "conf.json"), "{}");
    fs.writeFileSync(path.join(workspace, "pyproject.toml"), "[project]\nname = \"demo\"\n");
    fs.writeFileSync(path.join(workspace, "main.py"), "print('ok')\n");
    fs.mkdirSync(path.join(workspace, "assets", "img"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "assets", "img", "hero.png"), "png");
    fs.mkdirSync(path.join(workspace, "assets", "sounds"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "assets", "sounds", "hit.ogg"), "ogg");
    fs.mkdirSync(path.join(workspace, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".venv", "bin", "python"), "broken");
    fs.mkdirSync(path.join(workspace, ".dartsnut", "agent-session"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".dartsnut", "agent-session", "conversation.json"), "{}");
    fs.writeFileSync(path.join(workspace, "uv.lock"), "lock");

    const staged = stagePublishWorkspace(workspace);
    stagePath = staged.stagePath;

    assert.deepEqual(listRelativeFiles(stagePath), [
      "assets/img/hero.png",
      "assets/sounds/hit.ogg",
      "conf.json",
      "main.py",
      "pyproject.toml"
    ]);
    assert.equal(staged.fileCount, 5);
  } finally {
    if (stagePath) {
      fs.rmSync(stagePath, { recursive: true, force: true });
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("createPublishTarball puts filtered files under a single app id folder", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-publish-test-"));
  const extractPath = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-publish-extract-"));
  let tarballPath = null;
  try {
    fs.writeFileSync(path.join(workspace, "conf.json"), JSON.stringify({ id: "abc_def", type: "game" }));
    fs.writeFileSync(path.join(workspace, "main.py"), "print('ok')\n");
    fs.mkdirSync(path.join(workspace, "assets"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "assets", "hero.png"), "png");
    fs.writeFileSync(path.join(workspace, "README.md"), "ignored");

    tarballPath = await createPublishTarball(workspace, "abc_def");
    const extract = childProcess.spawnSync("tar", ["-xzf", tarballPath, "-C", extractPath], {
      encoding: "utf-8"
    });

    assert.equal(extract.status, 0, extract.stderr);
    assert.deepEqual(fs.readdirSync(extractPath).sort(), ["abc_def"]);
    assert.deepEqual(listRelativeFiles(path.join(extractPath, "abc_def")), [
      "assets/hero.png",
      "conf.json",
      "main.py"
    ]);
  } finally {
    if (tarballPath) {
      fs.rmSync(tarballPath, { force: true });
    }
    fs.rmSync(extractPath, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
