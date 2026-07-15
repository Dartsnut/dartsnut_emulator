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
    return new Response(JSON.stringify({ code: 1001, data: {} }), {
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

  await result.run.modelConfig.fetchImpl("https://api.dartsnut.com/agent/llm/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer placeholder", "Content-Type": "application/json" },
    body: "{}"
  });
  await result.run.finish();

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://api.dartsnut.com/agent/llm/runs/start");
  assert.equal(calls[2].url, "https://api.dartsnut.com/agent/llm/runs/finish");
  const modelHeaders = new Headers(calls[1].init.headers);
  assert.equal(modelHeaders.get("token"), "community-secret");
  assert.equal(modelHeaders.get("x-dartsnut-agent-run-id"), "run-1");
  assert.equal(modelHeaders.get("source"), "agent");
  assert.equal(modelHeaders.has("authorization"), false);
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

  await result.run.modelConfig.fetchImpl("https://api.dartsnut.com/agent/llm/v1/chat/completions", {});
  assert.deepEqual(result.run.readFailure(), { reason: "run_expired", message: "Run expired." });
});
