export type ProxyDiagnosticKind = "direct" | "proxy" | "unknown";

export type ProxyDiagnostic = {
  url: string;
  resolution: string;
  kind: ProxyDiagnosticKind;
};

export type DesktopNetworkState = {
  initialized: boolean;
  diagnostics: ProxyDiagnostic[];
  error?: string;
};

export type DesktopNetwork = {
  fetch: typeof fetch;
  resolveProxy: (url: string) => Promise<string>;
  state: DesktopNetworkState;
};

export type ElectronSessionLike = {
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
  resolveProxy: (url: string) => Promise<string>;
  setProxy: (config: { mode: "system" }) => Promise<void>;
};

const DEFAULT_DIAGNOSTIC_URLS = [
  "https://accounts.google.com",
  "https://api.dartsnut.com"
];

function sanitizedProxyToken(token: string): string {
  const normalized = token.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  const [schemeRaw, targetRaw] = normalized.split(" ", 2);
  const scheme = schemeRaw.toUpperCase();
  if (scheme === "DIRECT") {
    return "DIRECT";
  }
  if (!["PROXY", "HTTP", "HTTPS", "SOCKS", "SOCKS4", "SOCKS5", "QUIC"].includes(scheme)) {
    return "UNKNOWN";
  }
  const target = String(targetRaw || "").trim();
  if (!target) {
    return scheme;
  }
  const safeTarget = target.replace(/^.*@/, "");
  return `${scheme} ${safeTarget}`;
}

export function sanitizeProxyResolution(input: string): string {
  const tokens = input
    .split(";")
    .map(sanitizedProxyToken)
    .filter(Boolean);
  return tokens.length > 0 ? tokens.join("; ") : "UNKNOWN";
}

export function classifyProxyResolution(resolution: string): ProxyDiagnosticKind {
  const tokens = resolution.split(";").map((token) => token.trim().toUpperCase()).filter(Boolean);
  if (tokens.some((token) => /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5|QUIC)(?:\s|$)/.test(token))) {
    return "proxy";
  }
  if (tokens.length > 0 && tokens.every((token) => token === "DIRECT")) {
    return "direct";
  }
  return "unknown";
}

export async function configureSystemProxySession(electronSession: ElectronSessionLike): Promise<void> {
  await electronSession.setProxy({ mode: "system" });
}

export async function initializeDesktopNetwork(
  electronSession: ElectronSessionLike,
  options: {
    diagnosticUrls?: string[];
    onDiagnostic?: (diagnostic: ProxyDiagnostic) => void;
    onError?: (error: unknown) => void;
  } = {}
): Promise<DesktopNetwork> {
  const fetchImpl: typeof fetch = (input, init) => {
    const requestInput = input instanceof URL ? input.toString() : input;
    return electronSession.fetch(requestInput, { credentials: "omit", ...init });
  };
  const resolveProxy = (url: string) => electronSession.resolveProxy(url);
  const diagnostics: ProxyDiagnostic[] = [];
  let initialized = false;
  let errorMessage: string | undefined;

  try {
    await configureSystemProxySession(electronSession);
    initialized = true;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    options.onError?.(error);
  }

  if (initialized) {
    for (const url of options.diagnosticUrls ?? DEFAULT_DIAGNOSTIC_URLS) {
      try {
        const resolution = sanitizeProxyResolution(await resolveProxy(url));
        const diagnostic: ProxyDiagnostic = {
          url,
          resolution,
          kind: classifyProxyResolution(resolution)
        };
        diagnostics.push(diagnostic);
        options.onDiagnostic?.(diagnostic);
      } catch (error) {
        const diagnostic: ProxyDiagnostic = { url, resolution: "UNKNOWN", kind: "unknown" };
        diagnostics.push(diagnostic);
        options.onDiagnostic?.(diagnostic);
        options.onError?.(error);
      }
    }
  }

  return {
    fetch: fetchImpl,
    resolveProxy,
    state: {
      initialized,
      diagnostics,
      ...(errorMessage ? { error: errorMessage } : {})
    }
  };
}
