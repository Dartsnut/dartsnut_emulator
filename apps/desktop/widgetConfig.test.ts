const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readWidgetConfigSnapshot, watchWidgetConfigFile, widgetConfigPathForScope } = require("./dist-electron/widgetConfig.js");

function writePyproject(root) {
  fs.writeFileSync(path.join(root, "pyproject.toml"), '[project]\nname="demo"\nversion="1"\ndependencies=["pydartsnut"]\n');
}

function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for widget config change."));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("widgetConfigPathForScope selects workspace and emulator roots", () => {
  assert.equal(widgetConfigPathForScope("workspace", "/tmp/workspace", "/tmp/emulator"), path.resolve("/tmp/workspace/conf.json"));
  assert.equal(widgetConfigPathForScope("emulator", "/tmp/workspace", "/tmp/emulator"), path.resolve("/tmp/emulator/conf.json"));
  assert.equal(widgetConfigPathForScope("emulator", "/tmp/workspace", null), null);
});

test("readWidgetConfigSnapshot handles missing, invalid, non-widget, and ready configs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-widget-config-"));
  try {
    writePyproject(root);
    assert.equal(readWidgetConfigSnapshot("workspace", root, null).status, "not_widget");
    fs.writeFileSync(path.join(root, "conf.json"), "{");
    assert.equal(readWidgetConfigSnapshot("workspace", root, null).status, "invalid");
    fs.writeFileSync(path.join(root, "conf.json"), JSON.stringify({
      size: [128, 128],
      fields: [{ field_key: "title", field_name: "Title", field_type: "text", default: "Hi" }],
    }));
    const ready = readWidgetConfigSnapshot("workspace", root, null);
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.errors, []);
    assert.equal(ready.fields[0].id, "title");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readWidgetConfigSnapshot reports malformed fields without dropping valid definitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-widget-fields-"));
  try {
    writePyproject(root);
    fs.writeFileSync(path.join(root, "conf.json"), JSON.stringify({
      size: [128, 128],
      fields: [
        { id: "title", name: "Title", type: "text" },
        { id: "bad", name: "Bad", type: "unknown" },
      ],
    }));
    const snapshot = readWidgetConfigSnapshot("emulator", null, root);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.fields.length, 1);
    assert.match(snapshot.errors[0], /unsupported type/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watchWidgetConfigFile observes atomic conf.json replacement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-widget-watch-"));
  const confPath = path.join(root, "conf.json");
  let notifications = 0;
  fs.writeFileSync(confPath, JSON.stringify({ size: [128, 128], fields: [] }));
  const stop = watchWidgetConfigFile(confPath, () => { notifications += 1; }, 20);
  try {
    const nextPath = path.join(root, "conf.next.json");
    fs.writeFileSync(nextPath, JSON.stringify({ type: "widget", fields: [{ id: "title", name: "Title", type: "text" }] }));
    fs.renameSync(nextPath, confPath);
    await waitFor(() => notifications > 0);
    assert.ok(notifications > 0);
  } finally {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
