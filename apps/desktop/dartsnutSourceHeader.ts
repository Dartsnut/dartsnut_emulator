export const DARTSNUT_SOURCE_HEADER_NAME = "source";
export const DARTSNUT_SOURCE_HEADER_VALUE = "agent";

export function isDartsnutUrl(input: RequestInfo | URL): boolean {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === "dartsnut.com" || hostname.endsWith(".dartsnut.com");
  } catch {
    return false;
  }
}

export function withDartsnutSourceHeader(input: RequestInfo | URL, init: RequestInit = {}): RequestInit {
  if (!isDartsnutUrl(input)) {
    return init;
  }
  return {
    ...init,
    headers: withSourceHeader(init.headers)
  };
}

function withSourceHeader(headers: HeadersInit | undefined): HeadersInit {
  if (headers instanceof Headers) {
    const next = new Headers(headers);
    next.set(DARTSNUT_SOURCE_HEADER_NAME, DARTSNUT_SOURCE_HEADER_VALUE);
    return next;
  }
  if (Array.isArray(headers)) {
    return [
      ...headers.filter(([name]) => name.toLowerCase() !== DARTSNUT_SOURCE_HEADER_NAME),
      [DARTSNUT_SOURCE_HEADER_NAME, DARTSNUT_SOURCE_HEADER_VALUE]
    ];
  }
  const next = Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => name.toLowerCase() !== DARTSNUT_SOURCE_HEADER_NAME)
  );
  return {
    ...next,
    [DARTSNUT_SOURCE_HEADER_NAME]: DARTSNUT_SOURCE_HEADER_VALUE
  };
}
