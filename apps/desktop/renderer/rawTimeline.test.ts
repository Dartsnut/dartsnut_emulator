import { describe, expect, it } from "vitest";
import { describeTimelineError } from "./rawTimeline";

describe("describeTimelineError", () => {
  it("turns a raw fetch failure into an actionable message", () => {
    expect(describeTimelineError("fetch failed")).toEqual({
      title: "Couldn’t reach the model service",
      message: "Check your internet connection, VPN, or firewall, then try again.",
      technicalDetail: "fetch failed"
    });
  });

  it("keeps an underlying network error available as technical detail", () => {
    expect(describeTimelineError("Connection error: getaddrinfo ENOTFOUND api.dartsnut.com")).toEqual({
      title: "Couldn’t reach the model service",
      message: "Check your internet connection, VPN, or firewall, then try again.",
      technicalDetail: "Connection error: getaddrinfo ENOTFOUND api.dartsnut.com"
    });
  });
});
