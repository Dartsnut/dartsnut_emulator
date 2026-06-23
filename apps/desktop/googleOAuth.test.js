const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGoogleOAuthTokenBody,
  buildGoogleOAuthUrl,
  createPkcePair
} = require("./dist-electron/googleOAuth.js");

test("buildGoogleOAuthUrl targets Google authorization code flow with PKCE", () => {
  const rawUrl = buildGoogleOAuthUrl({
    clientId: "desktop-client",
    redirectUri: "http://127.0.0.1:12345/oauth/google/callback",
    state: "state-1",
    codeChallenge: "challenge-1"
  });
  const url = new URL(rawUrl);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "desktop-client");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:12345/oauth/google/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("createPkcePair returns url-safe verifier and challenge", () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(pair.verifier, pair.challenge);
});

test("buildGoogleOAuthTokenBody includes optional desktop client secret", () => {
  const body = buildGoogleOAuthTokenBody({
    clientId: "desktop-client",
    clientSecret: "desktop-secret",
    redirectUri: "http://127.0.0.1:12345/oauth/google/callback",
    code: "code-1",
    codeVerifier: "verifier-1"
  });
  assert.equal(body.get("client_id"), "desktop-client");
  assert.equal(body.get("client_secret"), "desktop-secret");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "code-1");
  assert.equal(body.get("code_verifier"), "verifier-1");
});
