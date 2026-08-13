const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let helpers;
test.before(async () => {
  helpers = await import("./publish_release_helpers.mjs");
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "publish-release-"));
}

function writeManifests(root, versions) {
  helpers.VERSION_MANIFESTS.forEach((relativePath, index) => {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ name: `package-${index}`, version: versions[index] }, null, 2)}\n`);
  });
}

function writeArtifact(dir, name, contents = "artifact") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), contents);
}

test("resolveWorkspaceVersion updates all manifests for exact SemVer", () => {
  const root = tempDir();
  try {
    writeManifests(root, Array(5).fill("1.5.4"));
    assert.equal(helpers.resolveWorkspaceVersion(root, ["--", "1.6.0-beta.1"]), "1.6.0-beta.1");
    for (const relativePath of helpers.VERSION_MANIFESTS) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, relativePath))).version, "1.6.0-beta.1");
    }
    assert.throws(() => helpers.resolveWorkspaceVersion(root, ["minor"]), /Invalid exact SemVer/);
    assert.throws(() => helpers.resolveWorkspaceVersion(root, ["1.6.0", "extra"]), /Usage/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceVersion rejects mismatched current versions", () => {
  const root = tempDir();
  try {
    writeManifests(root, ["1.5.4", "1.5.4", "1.5.3", "1.5.4", "1.5.4"]);
    assert.throws(() => helpers.resolveWorkspaceVersion(root, []), /do not match/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("releaseTargetForPlatform maps host package command and rejects unsupported hosts", () => {
  assert.equal(helpers.releaseTargetForPlatform("darwin").packageScript, "package:mac");
  assert.equal(helpers.releaseTargetForPlatform("win32").packageScript, "package:win");
  assert.throws(() => helpers.releaseTargetForPlatform("linux"), /Unsupported release platform/);
});

test("collectReleaseArtifacts selects mac ZIP feed and excludes DMG from live updates", () => {
  const root = tempDir();
  try {
    writeArtifact(root, "Dartsnut Agent-1.5.4-arm64.dmg");
    writeArtifact(root, "Dartsnut Agent-1.5.4-arm64.dmg.blockmap");
    writeArtifact(root, "Dartsnut Agent-1.5.4-arm64-mac.zip");
    writeArtifact(root, "Dartsnut Agent-1.5.4-arm64-mac.zip.blockmap");
    writeArtifact(root, "latest-mac.yml", "path: Dartsnut Agent-1.5.4-arm64-mac.zip\n");
    const artifacts = helpers.collectReleaseArtifacts(root, helpers.releaseTargetForPlatform("darwin"), "1.5.4");
    assert.match(artifacts.installer, /\.dmg$/);
    assert.deepEqual(artifacts.liveUpdateFiles.map((filePath) => path.basename(filePath)), [
      "Dartsnut Agent-1.5.4-arm64-mac.zip",
      "Dartsnut Agent-1.5.4-arm64-mac.zip.blockmap",
      "latest-mac.yml"
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectReleaseArtifacts reuses Windows NSIS installer and validates complete feed", () => {
  const root = tempDir();
  try {
    writeArtifact(root, "Dartsnut Agent Setup 1.5.4.exe");
    writeArtifact(root, "Dartsnut Agent Setup 1.5.4.exe.blockmap");
    writeArtifact(root, "latest.yml", "path: Dartsnut Agent Setup 1.5.4.exe\n");
    const artifacts = helpers.collectReleaseArtifacts(root, helpers.releaseTargetForPlatform("win32"), "1.5.4");
    assert.equal(artifacts.installer, artifacts.liveUpdateFiles[0]);
    fs.unlinkSync(path.join(root, "Dartsnut Agent Setup 1.5.4.exe.blockmap"));
    assert.throws(
      () => helpers.collectReleaseArtifacts(root, helpers.releaseTargetForPlatform("win32"), "1.5.4"),
      /Missing live-update blockmap/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectReleaseArtifacts rejects stale and ambiguous artifacts", () => {
  const root = tempDir();
  try {
    writeArtifact(root, "Dartsnut Agent-1.5.4-arm64.dmg");
    writeArtifact(root, "Other-1.5.4.dmg");
    writeArtifact(root, "Dartsnut Agent-1.5.4.zip");
    writeArtifact(root, "Dartsnut Agent-1.5.4.zip.blockmap");
    writeArtifact(root, "latest-mac.yml", "path: Dartsnut Agent-1.5.4.zip\n");
    assert.throws(
      () => helpers.collectReleaseArtifacts(root, helpers.releaseTargetForPlatform("darwin"), "1.5.4"),
      /exactly one installer/
    );
    fs.unlinkSync(path.join(root, "Other-1.5.4.dmg"));
    assert.throws(
      () => helpers.collectReleaseArtifacts(root, helpers.releaseTargetForPlatform("darwin"), "1.5.4", Date.now() + 5000),
      /stale/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectReleaseArtifacts rejects wrong-version artifacts", () => {
  const root = tempDir();
  try {
    writeArtifact(root, "Dartsnut Agent-1.5.3-arm64.dmg");
    writeArtifact(root, "Dartsnut Agent-1.5.3.zip");
    writeArtifact(root, "Dartsnut Agent-1.5.3.zip.blockmap");
    writeArtifact(root, "latest-mac.yml", "path: Dartsnut Agent-1.5.3.zip\n");
    assert.throws(
      () => helpers.collectReleaseArtifacts(root, helpers.releaseTargetForPlatform("darwin"), "1.5.4"),
      /found 0/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("publishBuiltArtifacts updates matching release and uploads metadata last", async () => {
  const calls = [];
  const existing = { id: 7, platform: "mac", version: "1.5.4" };
  const api = {
    async login() { calls.push(["login"]); },
    async uploadInstaller(file) {
      calls.push(["installer", path.basename(file)]);
      return { url: "https://files.example/app.dmg", md5: "abc123" };
    },
    async findRelease(platform, version) {
      calls.push(["find", platform, version]);
      return existing;
    },
    async saveRelease(row, data) { calls.push(["save", row, data]); },
    async uploadLiveUpdate(file) { calls.push(["update", path.basename(file)]); }
  };
  await helpers.publishBuiltArtifacts({
    api,
    target: helpers.releaseTargetForPlatform("darwin"),
    version: "1.5.4",
    description: "Release notes",
    artifacts: {
      installer: "/release/app.dmg",
      liveUpdateFiles: ["/release/app.zip", "/release/app.zip.blockmap", "/release/latest-mac.yml"]
    }
  });
  assert.equal(calls[3][1], existing);
  assert.deepEqual(calls[3][2], {
    platform: "mac",
    version: "1.5.4",
    download_url: "https://files.example/app.dmg",
    download_md5: "abc123",
    is_current: true,
    status: true,
    description: "Release notes"
  });
  assert.deepEqual(calls.slice(-3).map((call) => call[1]), ["app.zip", "app.zip.blockmap", "latest-mac.yml"]);
});

test("publishBuiltArtifacts stops after first upload failure", async () => {
  const calls = [];
  const api = {
    async login() { calls.push("login"); },
    async uploadInstaller() { calls.push("installer"); return { url: "url", md5: "md5" }; },
    async findRelease() { calls.push("find"); return null; },
    async saveRelease() { calls.push("save"); },
    async uploadLiveUpdate(file) {
      calls.push(path.basename(file));
      if (file.endsWith(".blockmap")) throw new Error("upload failed");
    }
  };
  await assert.rejects(() => helpers.publishBuiltArtifacts({
    api,
    target: helpers.releaseTargetForPlatform("darwin"),
    version: "1.5.4",
    artifacts: {
      installer: "/release/app.dmg",
      liveUpdateFiles: ["/release/app.zip", "/release/app.zip.blockmap", "/release/latest-mac.yml"]
    }
  }), /upload failed/);
  assert.deepEqual(calls, ["login", "installer", "find", "save", "app.zip", "app.zip.blockmap"]);
});

test("loadReleaseConfig reads ignored env and validates required values", () => {
  const root = tempDir();
  const emptyRoot = tempDir();
  try {
    fs.writeFileSync(path.join(root, ".env.release.local"), [
      "DARTSNUT_RELEASE_API_BASE=https://api.example.com/",
      "DARTSNUT_RELEASE_ACCOUNT=release-admin",
      "DARTSNUT_RELEASE_PASSWORD='secret value'",
      "DARTSNUT_RELEASE_DESCRIPTION=Notes"
    ].join("\n"));
    assert.deepEqual(helpers.loadReleaseConfig(root, {}), {
      apiBase: "https://api.example.com",
      account: "release-admin",
      password: "secret value",
      description: "Notes"
    });
    assert.throws(
      () => helpers.loadReleaseConfig(emptyRoot, {}),
      /Missing release configuration/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("createReleaseApi uses exact duplicate match, token header, and edit endpoint", async () => {
  const calls = [];
  const payloads = [
    { code: 1001, data: { token: "admin-token" } },
    {
      code: 1001,
      data: {
        total: 3,
        list: [
          { id: 1, platform: "mac", version: "1.5.40" },
          { id: 2, platform: "windows", version: "1.5.4" },
          { id: 3, platform: "mac", version: "1.5.4" }
        ]
      }
    },
    { code: 1001, data: null }
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payloads.shift()), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const api = helpers.createReleaseApi({
    apiBase: "https://api.example.com",
    account: "admin",
    password: "secret"
  }, fetchImpl);

  await api.login();
  const existing = await api.findRelease("mac", "1.5.4");
  assert.equal(existing.id, 3);
  await api.saveRelease(existing, { platform: "mac", version: "1.5.4" });

  assert.equal(calls[0].options.headers.has("token"), false);
  assert.equal(calls[1].options.headers.get("token"), "admin-token");
  assert.match(calls[1].url, /platform=mac/);
  assert.match(calls[1].url, /version=1.5.4/);
  assert.match(calls[2].url, /\/platform\/app-release\/edit$/);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    id: 3,
    platform: "mac",
    version: "1.5.4"
  });
});

test("createReleaseApi paginates substring results and creates when exact version is absent", async () => {
  const calls = [];
  const payloads = [
    { code: 1001, data: { token: "admin-token" } },
    {
      code: 1001,
      data: {
        total: 101,
        list: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          platform: "windows",
          version: `2.0.0-${index}`
        }))
      }
    },
    {
      code: 1001,
      data: { total: 101, list: [{ id: 101, platform: "windows", version: "2.0.0-other" }] }
    },
    { code: 1001, data: null }
  ];
  const api = helpers.createReleaseApi({
    apiBase: "https://api.example.com",
    account: "admin",
    password: "secret"
  }, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payloads.shift()), { status: 200 });
  });

  await api.login();
  const existing = await api.findRelease("windows", "2.0.0");
  assert.equal(existing, null);
  await api.saveRelease(existing, { platform: "windows", version: "2.0.0" });

  assert.match(calls[1].url, /page=1/);
  assert.match(calls[2].url, /page=2/);
  assert.match(calls[3].url, /\/platform\/app-release\/add$/);
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    platform: "windows",
    version: "2.0.0"
  });
});

test("createReleaseApi surfaces API failure without exposing credentials", async () => {
  const api = helpers.createReleaseApi({
    apiBase: "https://api.example.com",
    account: "admin",
    password: "do-not-log"
  }, async () => new Response(JSON.stringify({
    code: 1004,
    data: null,
    msg: "Incorrect password",
    desc: null
  }), { status: 200 }));

  await assert.rejects(api.login(), (error) => {
    assert.match(error.message, /Incorrect password/);
    assert.doesNotMatch(error.message, /do-not-log/);
    return true;
  });
});
