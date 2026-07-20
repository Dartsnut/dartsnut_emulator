const assert = require("node:assert/strict");
const test = require("node:test");

const { signInWithGoogleOAuth } = require("./dist-electron/googleOAuth.js");

test("signInWithGoogleOAuth cancels while waiting for the browser callback", async () => {
  const controller = new AbortController();
  let notifyBrowserOpened;
  const browserOpened = new Promise((resolve) => {
    notifyBrowserOpened = resolve;
  });
  let tokenExchangeCalled = false;

  const resultPromise = signInWithGoogleOAuth({
    clientId: "desktop-client-id",
    openExternal: async () => notifyBrowserOpened(),
    fetchImpl: async () => {
      tokenExchangeCalled = true;
      throw new Error("Token exchange should not run after cancellation.");
    },
    signal: controller.signal,
    timeoutMs: 5_000
  });

  await browserOpened;
  controller.abort();

  assert.deepEqual(await resultPromise, {
    ok: false,
    code: "cancelled",
    message: "Google sign-in was cancelled."
  });
  assert.equal(tokenExchangeCalled, false);
});
