import crypto from "node:crypto";
import http from "node:http";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_OAUTH_TIMEOUT_MS = 120_000;

export type GoogleOAuthOptions = {
  clientId: string;
  clientSecret?: string;
  openExternal: (url: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type GoogleOAuthResult =
  | { ok: true; idToken: string }
  | { ok: false; code: string; message: string };

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildGoogleOAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

async function createLoopbackRedirectServer(timeoutMs: number): Promise<{
  redirectUri: string;
  redirectPromise: Promise<URL>;
  close: (error?: Error) => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const host = req.headers.host || "127.0.0.1";
    const url = new URL(req.url || "/", `http://${host}`);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>Dartsnut</title><p>Google sign-in complete. You can close this tab.</p>");
    resolveRedirect(url);
  });

  let settled = false;
  let timeoutId: NodeJS.Timeout | null = null;
  let resolveRedirect: (url: URL) => void = () => undefined;
  let rejectRedirect: (error: Error) => void = () => undefined;

  const close = async (error?: Error): Promise<void> => {
    if (error) {
      rejectRedirect(error);
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (!server.listening) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const redirectPromise = new Promise<URL>((resolve, reject) => {
    resolveRedirect = (url: URL) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(url);
    };
    rejectRedirect = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    timeoutId = setTimeout(() => rejectRedirect(new Error("Google sign-in timed out.")), timeoutMs);
  }).finally(() => close());

  const redirectUri = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate Google sign-in callback port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/oauth/google/callback`);
    });
  });
  return { redirectUri, redirectPromise, close };
}

export function buildGoogleOAuthTokenBody(input: {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): URLSearchParams {
  const body = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier
  });
  const clientSecret = input.clientSecret?.trim();
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }
  return body;
}

async function exchangeCodeForIdToken(input: {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const body = buildGoogleOAuthTokenBody(input);
  const res = await input.fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  const raw = await res.json().catch(() => null);
  const idToken = String((raw as Record<string, unknown> | null)?.id_token || "").trim();
  if (!res.ok || !idToken) {
    const details = String((raw as Record<string, unknown> | null)?.error_description || (raw as Record<string, unknown> | null)?.error || "").trim();
    throw new Error(details || "Google did not return an ID token.");
  }
  return idToken;
}

export async function signInWithGoogleOAuth(options: GoogleOAuthOptions): Promise<GoogleOAuthResult> {
  const clientId = options.clientId.trim();
  if (!clientId) {
    return { ok: false, code: "config_missing", message: "Google sign-in is not configured." };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const state = base64Url(crypto.randomBytes(24));
  const pkce = createPkcePair();
  try {
    const timeoutMs = options.timeoutMs ?? GOOGLE_OAUTH_TIMEOUT_MS;
    const redirectServer = await createLoopbackRedirectServer(timeoutMs);
    const { redirectUri } = redirectServer;
    const authUrl = buildGoogleOAuthUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge
    });
    try {
      await options.openExternal(authUrl);
    } catch (error) {
      await redirectServer.close(error instanceof Error ? error : new Error(String(error)));
      await redirectServer.redirectPromise.catch(() => undefined);
      throw error;
    }
    const url = await redirectServer.redirectPromise;
    const returnedState = String(url.searchParams.get("state") || "");
    if (returnedState !== state) {
      return { ok: false, code: "invalid_state", message: "Google sign-in returned an invalid state." };
    }
    const oauthError = String(url.searchParams.get("error") || "").trim();
    if (oauthError) {
      return { ok: false, code: "oauth_error", message: `Google sign-in failed: ${oauthError}` };
    }
    const code = String(url.searchParams.get("code") || "").trim();
    if (!code) {
      return { ok: false, code: "invalid_credentials", message: "Google sign-in did not return an authorization code." };
    }
    const idToken = await exchangeCodeForIdToken({
      clientId,
      clientSecret: options.clientSecret,
      redirectUri,
      code,
      codeVerifier: pkce.verifier,
      fetchImpl
    });
    return { ok: true, idToken };
  } catch (error) {
    return { ok: false, code: "network_error", message: error instanceof Error ? error.message : String(error) };
  }
}
