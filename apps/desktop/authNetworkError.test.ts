import { describe, expect, it } from "vitest";
import { authNetworkErrorDetails, authNetworkErrorMessage } from "./authNetworkError";

describe("authNetworkErrorMessage", () => {
  it("preserves a nested DNS cause for logs and gives the sign-in screen an actionable message", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.dartsnut.com"), {
      code: "ENOTFOUND",
      hostname: "api.dartsnut.com"
    });
    const error = Object.assign(new TypeError("fetch failed"), { cause });

    expect(authNetworkErrorDetails(error)).toContain("ENOTFOUND api.dartsnut.com");
    expect(authNetworkErrorMessage(error, {
      action: "Couldn’t sign in to Dartsnut",
      endpoint: "https://api.dartsnut.com/community/member/login-in"
    })).toBe(
      "Couldn’t sign in to Dartsnut because api.dartsnut.com could not be found. Check your internet, DNS, or VPN settings, then try again."
    );
  });

  it("does not expose raw fetch wording for an unclassified network error", () => {
    expect(authNetworkErrorMessage(new TypeError("fetch failed"), {
      action: "Couldn’t sign in to Dartsnut",
      endpoint: "https://api.dartsnut.com"
    })).toBe("Couldn’t sign in to Dartsnut. Check your internet connection, VPN, or firewall, then try again.");
  });
});
