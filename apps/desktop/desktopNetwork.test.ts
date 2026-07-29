const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyProxyResolution,
  configureSystemProxySession,
  initializeDesktopNetwork,
  sanitizeProxyResolution
} = require("./dist-electron/desktopNetwork.js");

test("sanitizes direct, HTTP, SOCKS, and PAC proxy resolutions", () => {
  assert.equal(sanitizeProxyResolution("DIRECT"), "DIRECT");
  assert.equal(sanitizeProxyResolution("PROXY 127.0.0.1:7890"), "PROXY 127.0.0.1:7890");
  assert.equal(sanitizeProxyResolution("SOCKS5 user:secret@127.0.0.1:7891"), "SOCKS5 127.0.0.1:7891");
  assert.equal(
    sanitizeProxyResolution("PROXY proxy.example:8080; DIRECT"),
    "PROXY proxy.example:8080; DIRECT"
  );
  assert.equal(sanitizeProxyResolution("unexpected private-value"), "UNKNOWN");
});

test("classifies direct, proxied, and unknown resolutions", () => {
  assert.equal(classifyProxyResolution("DIRECT"), "direct");
  assert.equal(classifyProxyResolution("PROXY 127.0.0.1:7890; DIRECT"), "proxy");
  assert.equal(classifyProxyResolution("SOCKS5 127.0.0.1:7891"), "proxy");
  assert.equal(classifyProxyResolution("UNKNOWN"), "unknown");
});

test("initializes system proxy before exposing Electron session fetch", async () => {
  const calls = [];
  const session = {
    setProxy: async (config) => calls.push(["setProxy", config]),
    resolveProxy: async (url) => {
      calls.push(["resolveProxy", url]);
      return url.includes("google") ? "PROXY 127.0.0.1:7890; DIRECT" : "DIRECT";
    },
    fetch: async (input, init) => {
      calls.push(["fetch", String(input), init]);
      return new Response("ok");
    }
  };

  const network = await initializeDesktopNetwork(session, {
    diagnosticUrls: ["https://accounts.google.com", "https://api.dartsnut.com"]
  });
  const response = await network.fetch(new URL("https://api.dartsnut.com/status"));

  assert.equal(await response.text(), "ok");
  assert.deepEqual(calls[0], ["setProxy", { mode: "system" }]);
  assert.deepEqual(network.state, {
    initialized: true,
    diagnostics: [
      {
        url: "https://accounts.google.com",
        resolution: "PROXY 127.0.0.1:7890; DIRECT",
        kind: "proxy"
      },
      { url: "https://api.dartsnut.com", resolution: "DIRECT", kind: "direct" }
    ]
  });
  assert.equal(calls.at(-1)[1], "https://api.dartsnut.com/status");
});

test("falls back to Electron session networking if system proxy setup fails", async () => {
  const errors = [];
  let fetchCalled = false;
  const session = {
    setProxy: async () => {
      throw new Error("proxy setup unavailable");
    },
    resolveProxy: async () => {
      throw new Error("should not resolve after failed setup");
    },
    fetch: async () => {
      fetchCalled = true;
      return new Response("fallback");
    }
  };

  const network = await initializeDesktopNetwork(session, { onError: (error) => errors.push(error) });
  const response = await network.fetch("https://api.dartsnut.com/status");

  assert.equal(await response.text(), "fallback");
  assert.equal(fetchCalled, true);
  assert.equal(network.state.initialized, false);
  assert.equal(network.state.error, "proxy setup unavailable");
  assert.equal(errors.length, 1);
});


test("configures auxiliary Electron sessions such as the updater for system proxy", async () => {
  const calls = [];
  await configureSystemProxySession({
    setProxy: async (config) => calls.push(config),
    resolveProxy: async () => "DIRECT",
    fetch: async () => new Response("ok")
  });

  assert.deepEqual(calls, [{ mode: "system" }]);
});
