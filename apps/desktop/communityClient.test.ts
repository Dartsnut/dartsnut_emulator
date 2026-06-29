const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildInFilter,
  CommunityClient,
  filterAllowedDeviceIds,
  isApiSuccess,
  isSessionExpiredCode,
  mergeDeployDevices,
  normalizeApiJson,
  normalizeBoundDevices,
  normalizeCommunityGameCategories,
  normalizeCommunityGameControls,
  normalizeCommunityVersions,
  pickUploadMd5,
  pickUploadUrl,
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

test("normalizeCommunityGameCategories maps category rows", () => {
  const rows = normalizeCommunityGameCategories([
    { id: 3, game_cate_name: "Arcade" },
    { game_cate_id: "4", name: "Practice" },
    { id: "", game_cate_name: "skip" }
  ]);
  assert.deepEqual(rows, [
    { id: 3, name: "Arcade" },
    { id: "4", name: "Practice" }
  ]);
});

test("normalizeCommunityGameControls maps control options", () => {
  const rows = normalizeCommunityGameControls([
    { value: "dart", label: "Dart" },
    { id: "button" },
    { value: "" }
  ]);
  assert.deepEqual(rows, [
    { value: "dart", label: "Dart" },
    { value: "button", label: "button" }
  ]);
});

test("normalizeCommunityVersions maps game and widget version rows", () => {
  assert.deepEqual(
    normalizeCommunityVersions([
      { id: 9, game_system_id: 2, version: "1.2.3", status: 1, description: "review", created_at: "2026-01-02" },
      { id: "", version: "" }
    ], "game"),
    [
      {
        id: 9,
        appSystemId: 2,
        projectType: "game",
        version: "1.2.3",
        description: "review",
        status: "1",
        createdAt: "2026-01-02"
      }
    ]
  );
  assert.equal(
    normalizeCommunityVersions([{ id: "w1", widget_system_id: "7", version: "2.0.0" }], "widget")[0]?.appSystemId,
    "7"
  );
});

test("upload result helpers accept community response aliases", () => {
  assert.equal(pickUploadUrl({ url: "https://cdn.example/game.tar.gz" }), "https://cdn.example/game.tar.gz");
  assert.equal(pickUploadUrl({ game_download_url: "https://cdn.example/game.tar.gz" }), "https://cdn.example/game.tar.gz");
  assert.equal(pickUploadUrl({ widget_download_url: "https://cdn.example/widget.tar.gz" }), "https://cdn.example/widget.tar.gz");
  assert.equal(pickUploadMd5({ md5: "abc" }), "abc");
  assert.equal(pickUploadMd5({ game_download_md5: "def" }), "def");
  assert.equal(pickUploadMd5({ widget_download_md5: "ghi" }), "ghi");
});

test("CommunityClient adds source header to Dartsnut API requests", async () => {
  const calls = [];
  const client = new CommunityClient(
    readCommunityConfig({}),
    async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        json: async () => ({ code: 1001, data: { list: [] } })
      };
    }
  );

  const result = await client.listMyGames("token-1");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.dartsnut.com/community/game/my-list");
  assert.equal(calls[0].init.headers.source, "agent");
});

test("CommunityClient adds source header to Dartsnut Supabase requests", async () => {
  const calls = [];
  const client = new CommunityClient(
    readCommunityConfig({ DARTSNUT_SUPABASE_ANON_KEY: "anon-key" }),
    async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => []
      };
    }
  );

  const result = await client.fetchSupabaseStates(["device-1"]);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/base\.dartsnut\.com\/rest\/v1\/remote_devices\?/);
  assert.equal(calls[0].init.headers.source, "agent");
});

test("withdrawAppVersion falls back across review withdrawal routes", async () => {
  const calls = [];
  const client = new CommunityClient(
    {
      baseApi: "https://api.example.com",
      supabaseUrl: "",
      supabaseAnonKey: "",
      supabaseDeviceTable: "remote_devices",
      googleClientId: "",
      googleDesktopClientId: "",
      googleDesktopClientSecret: "",
      hasSupabase: false
    },
    async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith("/community/game-version/withdraw")) {
        return {
          status: 404,
          json: async () => ({ code: 404, msg: "missing" })
        };
      }
      return {
        status: 200,
        json: async () => ({ code: 1001, data: { status: 0 } })
      };
    }
  );

  const result = await client.withdrawAppVersion("token-1", {
    projectType: "game",
    versionId: 9,
    appSystemId: 2
  });

  assert.deepEqual(result, { ok: true, status: "0" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://api.example.com/community/game-version/withdraw");
  assert.equal(calls[1]?.url, "https://api.example.com/community/game-version/cancel-review");
  assert.deepEqual(JSON.parse(calls[1]?.init.body), {
    id: 9,
    version_id: 9,
    game_system_id: 2,
    submit_mode: "draft",
    status: 0
  });
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
  assert.equal(cfg.googleDesktopClientId, "");
  assert.equal(cfg.googleDesktopClientSecret, "");
});

test("readCommunityConfig reads desktop Google OAuth client id", () => {
  const cfg = readCommunityConfig({
    DARTSNUT_GOOGLE_CLIENT_ID: "web-client",
    DARTSNUT_GOOGLE_DESKTOP_CLIENT_ID: "desktop-client",
    DARTSNUT_GOOGLE_DESKTOP_CLIENT_SECRET: "desktop-secret"
  });
  assert.equal(cfg.googleClientId, "web-client");
  assert.equal(cfg.googleDesktopClientId, "desktop-client");
  assert.equal(cfg.googleDesktopClientSecret, "desktop-secret");
});
