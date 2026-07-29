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
  normalizeAnalyticsUserId,
  normalizeBoundDevices,
  normalizeCommunityGameCategories,
  normalizeCommunityGameControls,
  normalizeCommunityPreviewUrls,
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
      {
        id: 9,
        game_system_id: 2,
        version: "1.2.3",
        status: -1,
        description: "review",
        created_at: "2026-01-02",
        updated_at: "2026-01-03",
        review_action: "reject",
        review_comment: "Add clearer instructions.",
        reviewed_at: "2026-01-03",
        preview: '["https://cdn.example/one.png", "https://cdn.example/two.webp"]'
      },
      { id: "", version: "" }
    ], "game"),
    [
      {
        id: 9,
        appSystemId: 2,
        projectType: "game",
        version: "1.2.3",
        description: "review",
        status: "-1",
        createdAt: "2026-01-02",
        updatedAt: "2026-01-03",
        reviewAction: "reject",
        reviewComment: "Add clearer instructions.",
        reviewedAt: "2026-01-03",
        preview: ["https://cdn.example/one.png", "https://cdn.example/two.webp"]
      }
    ]
  );
  assert.equal(
    normalizeCommunityVersions([{ id: "w1", widget_system_id: "7", version: "2.0.0" }], "widget")[0]?.appSystemId,
    "7"
  );
});


test("normalizeCommunityPreviewUrls accepts API arrays and serialized legacy arrays", () => {
  assert.deepEqual(
    normalizeCommunityPreviewUrls([" https://cdn.example/one.png ", "https://cdn.example/one.png", ""]),
    ["https://cdn.example/one.png"]
  );
  assert.deepEqual(
    normalizeCommunityPreviewUrls('["https://cdn.example/one.png", "https://cdn.example/two.webp"]'),
    ["https://cdn.example/one.png", "https://cdn.example/two.webp"]
  );
  assert.deepEqual(normalizeCommunityPreviewUrls("https://cdn.example/only.jpg"), ["https://cdn.example/only.jpg"]);
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

test("Google login reports when the account needs a password", async () => {
  const client = new CommunityClient(
    readCommunityConfig({}),
    async () => ({
      status: 200,
      json: async () => ({
        code: 1001,
        data: {
          token: "google-token",
          needs_password_setup: true,
          user_info: { id: 8, account: "person@example.com" }
        }
      })
    })
  );

  const result = await client.loginWithGoogleIdToken("google-id-token");

  assert.deepEqual(result, {
    ok: true,
    token: "google-token",
    account: "person@example.com",
    analyticsUserId: "8",
    needsPasswordSetup: true
  });
});

test("setPassword sends the community token and new password", async () => {
  const calls = [];
  const client = new CommunityClient(
    readCommunityConfig({}),
    async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        json: async () => ({ code: 1001, data: { user_info: { account: "person@example.com" } } })
      };
    }
  );

  const result = await client.setPassword("community-token", "new-password");

  assert.deepEqual(result, { ok: true, account: "person@example.com" });
  assert.equal(calls[0]?.url, "https://api.dartsnut.com/community/member/set-password");
  assert.equal(calls[0]?.init.headers.token, "community-token");
  assert.deepEqual(JSON.parse(calls[0]?.init.body), { password: "new-password" });
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

test("uploadWidgetZip includes required widget identity form fields", async () => {
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
      return { status: 200, json: async () => ({ code: 1001, data: { url: "https://cdn.example/widget.tar.gz", md5: "abc" } }) };
    }
  );

  const result = await client.uploadWidgetZip("token-1", new Blob(["widget"]), "scoreboard.tar.gz", 12, "scoreboard");

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url, "https://api.example.com/community/upload/upload-widget-zip");
  const form = calls[0]?.init.body;
  assert.equal(form.get("system_id"), "12");
  assert.equal(form.get("widget_id"), "scoreboard");
});

test("submitAppVersion includes the canonical widget app id", async () => {
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
      return { status: 200, json: async () => ({ code: 1001, data: { id: 8, status: 1 } }) };
    }
  );

  const result = await client.submitAppVersion("token-1", {
    projectType: "widget",
    appSystemId: 12,
    appId: "scoreboard",
    version: "1.0.1",
    downloadUrl: "https://cdn.example/scoreboard.tar.gz",
    downloadMd5: "md5",
    description: "Release notes",
    preview: ["https://cdn.example/preview.png"]
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url, "https://api.example.com/community/widget-version/add");
  assert.deepEqual(JSON.parse(calls[0]?.init.body), {
    widget_system_id: 12,
    widget_id: "scoreboard",
    app_id: "scoreboard",
    version: "1.0.1",
    widget_download_url: "https://cdn.example/scoreboard.tar.gz",
    widget_download_md5: "md5",
    description: "Release notes",
    fields: "",
    preview: ["https://cdn.example/preview.png"],
    submit_mode: "review"
  });
});

test("withdrawAppVersion calls the permanent withdrawal endpoint", async () => {
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
      return {
        status: 200,
        json: async () => ({ code: 1001, data: { id: 9, status: -2 } })
      };
    }
  );

  const result = await client.withdrawAppVersion("token-1", {
    projectType: "game",
    versionId: 9
  });

  assert.deepEqual(result, { ok: true, status: "-2" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.example.com/community/game-version/withdraw");
  assert.deepEqual(JSON.parse(calls[0]?.init.body), { id: 9 });
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


test("normalizeAnalyticsUserId only accepts opaque member identifiers", () => {
  assert.equal(normalizeAnalyticsUserId({ id: "member-123", account: "person@example.com" }, "person@example.com"), "member-123");
  assert.equal(normalizeAnalyticsUserId({ id: "person@example.com", uuid: "" }, "person@example.com"), null);
  assert.equal(normalizeAnalyticsUserId({ user_id: "192.168.1.4" }, "person@example.com"), null);
});

test("password login turns a nested fetch error into an actionable sign-in message", async () => {
  const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND api.dartsnut.com"), {
    code: "ENOTFOUND",
    hostname: "api.dartsnut.com"
  });
  const fetchError = Object.assign(new TypeError("fetch failed"), { cause: dnsError });
  const client = new CommunityClient(readCommunityConfig({}), async () => {
    throw fetchError;
  });

  const result = await client.loginWithPassword("person@example.com", "password");

  assert.deepEqual(result, {
    ok: false,
    code: "network_error",
    message: "Couldn’t sign in to Dartsnut because api.dartsnut.com could not be found. Check your internet, DNS, or VPN settings, then try again."
  });
});


test("createCommunityClient uses the injected cloud fetch", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      code: 1001,
      data: { token: "token", user_info: { account: "person@example.com" } }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const { createCommunityClient } = require("./dist-electron/communityClient.js");
  const client = createCommunityClient({}, fetchImpl);

  const result = await client.loginWithPassword("person@example.com", "password");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.dartsnut.com/community/member/login-in");
});
