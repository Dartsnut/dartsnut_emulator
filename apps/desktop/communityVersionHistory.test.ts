const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isSameCommunityVersion,
  mergeCommunityVersionHistory
} = require("./dist-electron/communityVersionHistory.js");

function version(overrides = {}) {
  return {
    id: 10,
    appSystemId: 20,
    projectType: "game",
    version: "1.0.1",
    description: "Release notes",
    status: "1",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    reviewAction: "",
    reviewComment: "",
    reviewedAt: null,
    preview: ["https://example.test/preview.png"],
    ...overrides
  };
}

test("mergeCommunityVersionHistory retains a successful submission while list results lag", () => {
  const pending = version({ id: "pending:game:20:1.0.1" });
  const result = mergeCommunityVersionHistory([], [pending]);

  assert.deepEqual(result.versions, [pending]);
  assert.deepEqual(result.pendingVersions, [pending]);
});

test("mergeCommunityVersionHistory replaces a pending row with the authoritative response", () => {
  const pending = version({ id: "pending:game:20:1.0.1", status: "1" });
  const server = version({ id: 99, status: "2", reviewAction: "approve" });
  const result = mergeCommunityVersionHistory([server], [pending]);

  assert.deepEqual(result.versions, [server]);
  assert.deepEqual(result.pendingVersions, []);
});

test("isSameCommunityVersion acknowledges an exact id even when the version label differs", () => {
  assert.equal(isSameCommunityVersion(version({ id: 99, version: "1.0.1" }), version({ id: 99, version: "1.0.2" })), true);
});
