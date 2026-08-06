const assert = require("node:assert/strict");
const test = require("node:test");

const {
  dartsnutLlmBridgeModelBaseUrl,
  mapDartsnutLlmBridgeFailure,
  startDartsnutLlmBridgeRun
} = require("./dist-electron/dartsnutLlmBridge.js");

test("builds OpenAI-compatible bridge base URL", () => {
  assert.equal(
    dartsnutLlmBridgeModelBaseUrl("https://api.dartsnut.com/"),
    "https://api.dartsnut.com/agent/llm/v1"
  );
});

test("maps stable API bridge failures", () => {
  assert.equal(mapDartsnutLlmBridgeFailure(401, null).reason, "auth_required");
  assert.equal(mapDartsnutLlmBridgeFailure(200, { code: 1038 }).reason, "auth_required");
  assert.equal(mapDartsnutLlmBridgeFailure(403, { error: "NO_BOUND_MACHINE" }).reason, "no_bound_machine");
  assert.equal(mapDartsnutLlmBridgeFailure(429, { error: "DAILY_QUOTA_EXCEEDED" }).reason, "daily_quota_exceeded");
  assert.equal(mapDartsnutLlmBridgeFailure(409, { error: "RUN_ALREADY_ACTIVE" }).reason, "run_already_active");
  assert.equal(mapDartsnutLlmBridgeFailure(409, { error: { code: "RUN_EXPIRED" } }).reason, "run_expired");
});

test("starts run and injects account token plus run id into model requests", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      code: 1001,
      data: { url: "https://upstream.example.com/v1", key: "must-not-reach-desktop", name: "upstream-model" }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await startDartsnutLlmBridgeRun({
    baseApi: "https://api.dartsnut.com",
    token: "community-secret",
    runId: "run-1",
    fetchImpl
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.run.modelConfig.apiKey, "dartsnut-api-bridge-run-1");
  assert.equal(result.run.modelConfig.model, "dartsnut-llm");
  assert.equal(JSON.stringify(result.run.modelConfig).includes("must-not-reach-desktop"), false);
  assert.equal(JSON.stringify(result.run.modelConfig).includes("community-secret"), false);

  await result.run.modelConfig.fetchImpl("https://api.dartsnut.com/agent/llm/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer placeholder", "Content-Type": "application/json" },
    body: "{}"
  });
  await result.run.finish();
  await result.run.finish();

  // Stop and app-quit can race with the prompt finalizer; only one backend close is sent.
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://api.dartsnut.com/agent/llm/runs/start");
  assert.equal(calls[2].url, "https://api.dartsnut.com/agent/llm/runs/finish");
  const modelHeaders = new Headers(calls[1].init.headers);
  assert.equal(modelHeaders.get("token"), "community-secret");
  assert.equal(modelHeaders.get("x-dartsnut-agent-run-id"), "run-1");
  assert.equal(modelHeaders.get("source"), "agent");
  assert.equal(modelHeaders.has("authorization"), false);
});

test("always keeps Responses alias regardless of run-start model metadata", async () => {
  for (const data of [{}, { model: "gpt-compatible" }, { model: "ignored-model" }]) {
    const result = await startDartsnutLlmBridgeRun({
      baseApi: "https://api.dartsnut.com",
      token: "token",
      runId: `run-${Object.keys(data).length}`,
      fetchImpl: async () => new Response(JSON.stringify({ code: 1001, data }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.run.modelConfig.model, "dartsnut-llm");
    assert.equal(result.run.modelConfig.endpointKind, "openai-compatible");
  }
});

test("keeps response-chain scope stable across rotating bridge run ids", async () => {
  const start = async (runId: string) => startDartsnutLlmBridgeRun({
    baseApi: "https://api.example.com",
    token: "member-token",
    accountScope: "member@example.com",
    runId,
    fetchImpl: async (input) => new Response(JSON.stringify(
      String(input).endsWith("/runs/start")
        ? { code: 1001, data: {} }
        : { code: 1001 }
    ), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  const first = await start("run-1");
  const second = await start("run-2");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.run.modelConfig.chainScope, second.run.modelConfig.chainScope);
  assert.notEqual(first.run.modelConfig.apiKey, second.run.modelConfig.apiKey);
});

test("turns a run-start DNS failure into an actionable bridge message", async () => {
  const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND api.dartsnut.com"), {
    code: "ENOTFOUND",
    hostname: "api.dartsnut.com"
  });
  const fetchError = Object.assign(new TypeError("fetch failed"), { cause: dnsError });

  const result = await startDartsnutLlmBridgeRun({
    baseApi: "https://api.dartsnut.com",
    token: "token",
    runId: "run-start-dns-error",
    fetchImpl: async () => { throw fetchError; }
  });

  assert.deepEqual(result, {
    ok: false,
    failure: {
      reason: "service_unavailable",
      message: "Couldn’t reach Dartsnut LLM because api.dartsnut.com could not be found. Check your internet, DNS, or VPN settings, then try again."
    }
  });
});

test("captures bridge rejection from a model request", async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    if (count === 1) {
      return new Response(JSON.stringify({ code: 1001 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "RUN_EXPIRED", message: "Run expired." } }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await startDartsnutLlmBridgeRun({
    baseApi: "https://api.dartsnut.com",
    token: "token",
    runId: "run-2",
    fetchImpl
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  await result.run.modelConfig.fetchImpl("https://api.dartsnut.com/agent/llm/v1/responses", {});
  assert.deepEqual(result.run.readFailure(), { reason: "run_expired", message: "Run expired." });
});

test("turns a DNS fetch failure into an actionable bridge message", async () => {
  let count = 0;
  const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND api.dartsnut.com"), {
    code: "ENOTFOUND",
    hostname: "api.dartsnut.com"
  });
  const fetchError = Object.assign(new TypeError("fetch failed"), { cause: dnsError });
  const fetchImpl = async () => {
    count += 1;
    if (count === 1) {
      return new Response(JSON.stringify({ code: 1001 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw fetchError;
  };

  const result = await startDartsnutLlmBridgeRun({
    baseApi: "https://api.dartsnut.com",
    token: "token",
    runId: "run-dns-error",
    fetchImpl
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  await assert.rejects(
    result.run.modelConfig.fetchImpl("https://api.dartsnut.com/agent/llm/v1/responses", {}),
    /fetch failed/
  );
  assert.deepEqual(result.run.readFailure(), {
    reason: "service_unavailable",
    message: "Couldn’t reach Dartsnut LLM because api.dartsnut.com could not be found. Check your internet, DNS, or VPN settings, then try again."
  });
});
