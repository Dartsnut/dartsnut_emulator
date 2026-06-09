const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildInFilter,
  filterAllowedDeviceIds,
  isApiSuccess,
  isSessionExpiredCode,
  mergeDeployDevices,
  normalizeApiJson,
  normalizeBoundDevices,
  readCommunityConfig
} = require("./dist-electron/communityClient.js");

test("isApiSuccess accepts community success codes", () => {
  assert.equal(isApiSuccess(1001), true);
  assert.equal(isApiSuccess(200), true);
  assert.equal(isApiSuccess(500), false);
});

test("isSessionExpiredCode matches community auth redirects", () => {
  assert.equal(isSessionExpiredCode(1026), true);
  assert.equal(isSessionExpiredCode(1006), true);
  assert.equal(isSessionExpiredCode(1038), true);
  assert.equal(isSessionExpiredCode(1001), false);
});

test("normalizeApiJson parses string envelopes", () => {
  assert.deepEqual(normalizeApiJson('{"code":1001,"data":[]}'), { code: 1001, data: [] });
});

test("buildInFilter quotes device ids for PostgREST", () => {
  assert.equal(buildInFilter(["abc", "def"]), 'in.("abc","def")');
});

test("filterAllowedDeviceIds only returns bound ids", () => {
  assert.deepEqual(filterAllowedDeviceIds(["a", "b"], ["b", "x"]), ["b"]);
  assert.deepEqual(filterAllowedDeviceIds(["a", "b"], null), ["a", "b"]);
});

test("normalizeBoundDevices maps device_id and name", () => {
  const rows = normalizeBoundDevices([
    { device_id: " d1 ", name: "Kitchen", model: "X1" },
    { deviceId: "", name: "skip" }
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { deviceId: "d1", name: "Kitchen", model: "X1" });
});

test("mergeDeployDevices pulls ip and ssid from state", () => {
  const devices = mergeDeployDevices(
    [{ deviceId: "d1", name: "Binding", model: "" }],
    {
      d1: {
        state: { ip_address: "192.168.1.10", ssid: "HomeWiFi", device_info: { name: "Pi" } },
        updated_at: "2026-01-01T00:00:00Z"
      }
    }
  );
  assert.equal(devices[0]?.ipAddress, "192.168.1.10");
  assert.equal(devices[0]?.ssid, "HomeWiFi");
  assert.equal(devices[0]?.name, "Binding");
  assert.equal(devices[0]?.updatedAt, "2026-01-01T00:00:00Z");
});

test("readCommunityConfig applies defaults and hasSupabase flag", () => {
  const cfg = readCommunityConfig({
    DARTSNUT_BASE_API: "https://api.example.com/",
    DARTSNUT_SUPABASE_URL: "https://base.example.com",
    DARTSNUT_SUPABASE_ANON_KEY: "anon-key"
  });
  assert.equal(cfg.baseApi, "https://api.example.com");
  assert.equal(cfg.hasSupabase, true);
  assert.equal(cfg.supabaseDeviceTable, "remote_devices");
});
