type NetworkErrorRecord = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  syscall?: unknown;
  hostname?: unknown;
  cause?: unknown;
};

/** Returns the nested transport error so it can be retained in desktop logs. */
export function authNetworkErrorDetails(error: unknown): string {
  const seen = new Set<object>();

  const visit = (value: unknown, depth: number): string => {
    if (depth > 4 || value == null) {
      return "";
    }
    if (typeof value !== "object") {
      return typeof value === "string" ? value.trim() : "";
    }
    if (seen.has(value)) {
      return "";
    }
    seen.add(value);

    const record = value as NetworkErrorRecord;
    const summary = [record.name, record.code, record.syscall, record.hostname, record.message]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .map((part) => part.trim())
      .join(" ");
    const cause = visit(record.cause, depth + 1);
    return [summary, cause].filter(Boolean).join("; caused by: ");
  };

  return visit(error, 0);
}

/** Converts low-level fetch failures into a concise message suitable for the sign-in screen. */
export function authNetworkErrorMessage(error: unknown, input: { action: string; endpoint: string }): string {
  const details = authNetworkErrorDetails(error).toLowerCase();
  let host = "the sign-in service";
  try {
    host = new URL(input.endpoint).host || host;
  } catch {
    // Keep the generic service name when a custom endpoint is malformed.
  }

  if (/enotfound|eai_again|getaddrinfo|dns/.test(details)) {
    return `${input.action} because ${host} could not be found. Check your internet, DNS, or VPN settings, then try again.`;
  }
  if (/timeout|timed out|aborterror/.test(details)) {
    return `${input.action} because the server took too long to respond. Check your connection and try again.`;
  }
  if (/certificate|cert_|self signed|unable to verify/.test(details)) {
    return `${input.action} because a secure connection could not be established. Check your network or VPN certificate settings, then try again.`;
  }
  return `${input.action}. Check your internet connection, VPN, or firewall, then try again.`;
}
