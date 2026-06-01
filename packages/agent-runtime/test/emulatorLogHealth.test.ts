import { describe, expect, it } from "vitest";
import {
  assessEmulatorVerifyBatch,
  emulatorLogTextHasRuntimeErrors,
  emulatorLogsPayloadHasRuntimeErrors,
  isEmulatorLogsToolResultClean,
  parseEmulatorLogsToolResult
} from "../src/emulatorLogHealth";

describe("emulatorLogTextHasRuntimeErrors", () => {
  it("detects Python tracebacks and syntax errors", () => {
    expect(emulatorLogTextHasRuntimeErrors("Traceback (most recent call last):\n  File main.py")).toBe(
      true
    );
    expect(emulatorLogTextHasRuntimeErrors("SyntaxError: invalid syntax")).toBe(true);
    expect(emulatorLogTextHasRuntimeErrors("widget started ok")).toBe(false);
  });
});

describe("isEmulatorLogsToolResultClean", () => {
  it("accepts clean host payloads", () => {
    const payload = JSON.stringify({
      ok: true,
      lines: [{ source: "stdout", text: "widget started" }],
      emulator: { running: true, status: "Running", lastError: null }
    });
    expect(isEmulatorLogsToolResultClean(payload)).toBe(true);
  });

  it("rejects payloads with lastError or traceback lines", () => {
    expect(
      isEmulatorLogsToolResultClean(
        JSON.stringify({
          ok: true,
          lines: [{ source: "stderr", text: "ModuleNotFoundError: No module named 'foo'" }],
          emulator: { running: false, status: "Error", lastError: null }
        })
      )
    ).toBe(false);

    expect(
      isEmulatorLogsToolResultClean(
        JSON.stringify({
          ok: true,
          lines: [],
          emulator: { running: false, status: "Error", lastError: "widget crashed" }
        })
      )
    ).toBe(false);
  });
});

describe("parseEmulatorLogsToolResult", () => {
  it("returns null for invalid JSON", () => {
    expect(parseEmulatorLogsToolResult("not-json")).toBeNull();
  });

  it("flags ok:false payloads as errors via payload helper", () => {
    const payload = parseEmulatorLogsToolResult(JSON.stringify({ ok: false, error: "no bridge" }));
    expect(payload).not.toBeNull();
    expect(emulatorLogsPayloadHasRuntimeErrors(payload!)).toBe(true);
  });
});

describe("assessEmulatorVerifyBatch", () => {
  const cleanLogs = JSON.stringify({
    ok: true,
    lines: [{ source: "stdout", text: "ready" }],
    emulator: { running: true, status: "Running", lastError: null }
  });

  it("detects clean verify when reload and logs run in one batch", () => {
    const state = { reloadPending: false };
    const result = assessEmulatorVerifyBatch(
      [
        { toolCall: { name: "reload_emulator" }, result: '{"ok":true}' },
        { toolCall: { name: "get_emulator_logs" }, result: cleanLogs }
      ],
      state
    );
    expect(result.cleanVerifyAfterReload).toBe(true);
    expect(result.reloadPending).toBe(false);
  });

  it("detects clean verify when logs follow a prior reload", () => {
    const state = { reloadPending: true };
    const result = assessEmulatorVerifyBatch(
      [{ toolCall: { name: "get_emulator_logs" }, result: cleanLogs }],
      state
    );
    expect(result.cleanVerifyAfterReload).toBe(true);
  });

  it("does not verify when logs are read without a preceding reload", () => {
    const state = { reloadPending: false };
    const result = assessEmulatorVerifyBatch(
      [{ toolCall: { name: "get_emulator_logs" }, result: cleanLogs }],
      state
    );
    expect(result.cleanVerifyAfterReload).toBe(false);
  });

  it("does not verify clean when stderr contains runtime errors", () => {
    const state = { reloadPending: false };
    const result = assessEmulatorVerifyBatch(
      [
        { toolCall: { name: "reload_emulator" }, result: '{"ok":true}' },
        {
          toolCall: { name: "get_emulator_logs" },
          result: JSON.stringify({
            ok: true,
            lines: [{ source: "stderr", text: "SyntaxError: invalid syntax" }],
            emulator: { running: false, status: "Error", lastError: null }
          })
        }
      ],
      state
    );
    expect(result.cleanVerifyAfterReload).toBe(false);
  });
});
