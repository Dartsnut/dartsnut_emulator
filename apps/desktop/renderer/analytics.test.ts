import { describe, expect, it } from "vitest";
import { sanitizeAnalyticsParams } from "./analytics";

describe("sanitizeAnalyticsParams", () => {
  it("keeps coarse analytics metadata", () => {
    expect(sanitizeAnalyticsParams({
      control_id: "agent_send",
      outcome: "success",
      duration_ms: 1250,
      signed_in: true
    })).toEqual({
      control_id: "agent_send",
      outcome: "success",
      duration_ms: 1250,
      signed_in: true
    });
  });

  it("drops sensitive keys and identifying values", () => {
    expect(sanitizeAnalyticsParams({
      prompt: "make a game",
      file_path: "/Users/example/game.py",
      device_id: "device-1",
      account: "person@example.com",
      arbitrary_email: "person@example.com",
      arbitrary_path: "/Users/example/game.py",
      arbitrary_ip: "192.168.1.5",
      tool_name: "write_file"
    })).toEqual({ tool_name: "write_file" });
  });
});
