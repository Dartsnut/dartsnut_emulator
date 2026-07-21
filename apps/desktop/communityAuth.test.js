const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readCommunityAuth, writeCommunityAuth } = require("./dist-electron/communityAuth.js");

test("community auth remains backward compatible and persists analytics metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-auth-"));
  writeCommunityAuth(root, {
    token: "token",
    account: "account",
    analyticsUserId: "member-1",
    authMethod: "password"
  });
  assert.deepEqual(readCommunityAuth(root), {
    token: "token",
    account: "account",
    analyticsUserId: "member-1",
    authMethod: "password"
  });

  fs.writeFileSync(path.join(root, "community-auth.json"), JSON.stringify({ token: "legacy", account: "old" }));
  assert.deepEqual(readCommunityAuth(root), {
    token: "legacy",
    account: "old",
    analyticsUserId: null
  });
  fs.rmSync(root, { recursive: true, force: true });
});
