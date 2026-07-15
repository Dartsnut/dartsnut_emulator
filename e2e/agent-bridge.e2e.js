const assert = require('node:assert/strict');
const test = require('node:test');
const { startDartsnutLlmBridgeRun } = require('../apps/desktop/dist-electron/dartsnutLlmBridge.js');

const API_BASE = process.env.DARTSNUT_E2E_API_BASE || 'http://127.0.0.1:13300';
const ACCOUNT = process.env.DARTSNUT_E2E_ACCOUNT || 'agent-e2e@example.com';
const PASSWORD = process.env.DARTSNUT_E2E_PASSWORD || 'test-password';

async function login() {
  const response = await fetch(`${API_BASE}/community/member/login-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', source: 'agent' },
    body: JSON.stringify({ account: ACCOUNT, password: PASSWORD })
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.equal(payload.code, 1001, JSON.stringify(payload));
  return payload.data.token;
}

test('desktop bridge starts, proxies, streams, and finishes one API agent run', async () => {
  const token = await login();
  const started = await startDartsnutLlmBridgeRun({
    baseApi: API_BASE,
    token,
    runId: crypto.randomUUID()
  });
  assert.equal(started.ok, true, started.ok ? '' : started.failure.message);
  if (!started.ok) return;

  const response = await started.run.modelConfig.fetchImpl(
    `${API_BASE}/agent/llm/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-model-is-overridden',
        stream: true,
        messages: [{ role: 'user', content: 'e2e ping' }]
      })
    }
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /mock response/);
  assert.match(text, /total_tokens/);
  assert.equal(started.run.readFailure(), null);
  await started.run.finish();
});
