const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  listSideloadWorkspaceFiles,
  parseSideloadCapabilities,
  SideloadWebSocketClient,
} = require("./deployMachineSideload.ts");

class FakeWebSocket {
  readyState = 0;
  listeners = new Map();
  sent = [];

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  send(raw) {
    const request = JSON.parse(raw);
    this.sent.push(request);
    const response = { action: request.action, req_id: request.req_id, message: "Success" };
    if (request.action === "sideload_capabilities") {
      Object.assign(response, {
        protocol_version: 1,
        supported_sizes: ["128x160", "128x128", "128x64", "64x32"],
        heartbeat_interval_seconds: 10,
        heartbeat_expiry_seconds: 30,
      });
    }
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(response) }));
  }

  close() {
    this.readyState = 3;
  }
}

test("parseSideloadCapabilities requires protocol v1 and supported sizes", () => {
  assert.equal(parseSideloadCapabilities({ protocol_version: 2, supported_sizes: ["64x32"] }), null);
  assert.deepEqual(parseSideloadCapabilities({
    protocol_version: 1,
    supported_sizes: [[64, 32]],
    heartbeat_interval_seconds: 10,
    heartbeat_expiry_seconds: 30,
  }), {
    protocolVersion: 1,
    supportedSizes: ["64x32"],
    heartbeatIntervalSeconds: 10,
    heartbeatExpirySeconds: 30,
  });
});

test("listSideloadWorkspaceFiles excludes local and generated directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dartsnut-sideload-test-"));
  try {
    await fs.mkdir(path.join(root, "assets"));
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(path.join(root, ".venv", "bin"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "main.py"), "print('ok')");
    await fs.writeFile(path.join(root, "assets", "icon.bin"), "asset");
    await fs.writeFile(path.join(root, ".git", "config"), "ignored");
    await fs.writeFile(path.join(root, ".venv", "bin", "python"), "ignored");
    await fs.writeFile(path.join(root, "node_modules", "ignored.js"), "ignored");
    assert.deepEqual(await listSideloadWorkspaceFiles(root), ["assets/icon.bin", "main.py"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safe sideload uploads files, starts session, forwards events, then stops", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dartsnut-sideload-test-"));
  const socket = new FakeWebSocket();
  const logs = [];
  const frames = [];
  const exits = [];
  try {
    await fs.writeFile(path.join(root, "main.py"), "print('safe')");
    const client = new SideloadWebSocketClient({
      onLog: (entry) => logs.push(entry),
      onFrame: (frame) => frames.push(frame),
      onExit: (event) => exits.push(event),
      onStatus: () => { },
    }, () => socket);
    const probe = client.connectAndProbe("192.168.1.10");
    queueMicrotask(() => socket.open());
    assert.equal((await probe).protocolVersion, 1);

    const sessionId = await client.start(root, "clock", [64, 32], { color: "red" });
    assert.deepEqual(socket.sent.map((request) => request.action), [
      "sideload_capabilities",
      "sideload_upload",
      "sideload_start",
      "sideload_logs",
    ]);
    assert.equal(socket.sent[1].relative_path, "main.py");
    assert.equal(socket.sent[1].session_id, sessionId);
    assert.deepEqual(socket.sent[2].size, [64, 32]);
    assert.deepEqual(socket.sent[2].params, { color: "red" });

    socket.emit("message", { data: JSON.stringify({
      action: "sideload_log",
      req_id: null,
      session_id: sessionId,
      timestamp: 123,
      stream: "stderr",
      text: "failure",
    }) });
    socket.emit("message", { data: JSON.stringify({
      action: "sideload_frame",
      req_id: null,
      session_id: sessionId,
      width: 128,
      height: 160,
      encoding: "png",
      frame: "cG5n",
    }) });
    assert.equal(logs[0].text, "failure");
    assert.equal(frames[0].frame, "cG5n");

    await client.stop();
    assert.equal(socket.sent.at(-1).action, "sideload_stop");
    assert.equal(client.active, false);
    assert.deepEqual(exits, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
