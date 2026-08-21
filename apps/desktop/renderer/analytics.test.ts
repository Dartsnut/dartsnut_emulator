import { describe, expect, it } from "vitest";
import { isFirebaseConfigComplete, sanitizeAnalyticsParams } from "./analytics";

describe("Firebase analytics config", () => {
  it("requires every client config value", () => {
    const complete = {
      apiKey: "api-key",
      authDomain: "example.firebaseapp.com",
      projectId: "example",
      storageBucket: "example.firebasestorage.app",
      messagingSenderId: "123",
      appId: "app-id",
      measurementId: "measurement-id"
    };

    expect(isFirebaseConfigComplete(complete)).toBe(true);
    expect(isFirebaseConfigComplete({ ...complete, apiKey: "" })).toBe(false);
    expect(isFirebaseConfigComplete({ ...complete, projectId: "   " })).toBe(false);
  });
});

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
