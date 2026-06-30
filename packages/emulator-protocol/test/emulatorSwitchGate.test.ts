import { describe, expect, it } from "vitest";
import {
  beginEmulatorSwitch,
  handleEmulatorSwitchFrame,
  handleEmulatorSwitchState,
  nextFrameRenderGeneration,
  shouldRenderFrameGeneration,
  type EmulatorFrame,
  type EmulatorStateSnapshot,
} from "../src";

const frame: EmulatorFrame = {
  width: 128,
  height: 160,
  rgbBase64: "abc",
  timestampMs: 1,
};

const oldState: EmulatorStateSnapshot = {
  widgetPath: "/workspace/old-game",
  widgetId: "old",
  widgetType: "game",
  running: true,
  fps: 60,
  status: "",
};

const targetState: EmulatorStateSnapshot = {
  widgetPath: "/workspace/new-game",
  widgetId: "new",
  widgetType: "game",
  running: true,
  fps: 60,
  status: "",
};

describe("emulator switch gate", () => {
  it("starts with a reset loading state for the renderer", () => {
    const pending = beginEmulatorSwitch("/workspace/new-game", oldState);

    expect(pending.stateForRenderer).toMatchObject({
      widgetPath: null,
      widgetId: null,
      widgetType: null,
      running: false,
      status: "venv:Preparing workspace environment…",
    });
    expect(pending.stateForRenderer.lastError).toBeUndefined();
  });

  it("suppresses frames while a switch is pending", () => {
    const pending = beginEmulatorSwitch("/workspace/new-game", oldState);

    expect(handleEmulatorSwitchFrame(pending.gate, frame)).toEqual({
      gate: pending.gate,
      frame: null,
      state: null,
    });
  });

  it("ignores old workspace states while preserving the loading hint", () => {
    const pending = beginEmulatorSwitch("/workspace/new-game", oldState);
    const result = handleEmulatorSwitchState(pending.gate, oldState, pending.stateForRenderer);

    expect(result.state).toEqual(pending.stateForRenderer);
    expect(result.gate).not.toBeNull();
  });

  it("does not release when set_path reports the target while the previous process is still running", () => {
    const pending = beginEmulatorSwitch("/workspace/new-game", oldState);
    const result = handleEmulatorSwitchState(pending.gate, targetState, pending.stateForRenderer);

    expect(result.state).toEqual(pending.stateForRenderer);
    expect(result.gate).not.toBeNull();
  });

  it("keeps the hint visible after the target process starts until the first frame", () => {
    const pending = beginEmulatorSwitch("/workspace/new-game", oldState);
    const preparingState: EmulatorStateSnapshot = {
      ...targetState,
      running: false,
      status: "venv:Preparing workspace environment…",
    };

    const preparing = handleEmulatorSwitchState(pending.gate, preparingState, pending.stateForRenderer);
    const starting = handleEmulatorSwitchState(preparing.gate, targetState, preparing.state);
    const framed = handleEmulatorSwitchFrame(starting.gate, frame);

    expect(preparing.state).toEqual(pending.stateForRenderer);
    expect(starting.state).toMatchObject({
      widgetPath: null,
      running: false,
      status: "venv:Starting game…",
    });
    expect(starting.gate).not.toBeNull();
    expect(framed.frame).toEqual(frame);
    expect(framed.state).toEqual(targetState);
    expect(framed.gate).toBeNull();
  });

  it("keeps the hint visible on the second target running state when the target venv was already ready", () => {
    const pending = beginEmulatorSwitch("/workspace/new-game", oldState);

    const firstRunning = handleEmulatorSwitchState(pending.gate, targetState, pending.stateForRenderer);
    const secondRunning = handleEmulatorSwitchState(firstRunning.gate, targetState, firstRunning.state);

    expect(firstRunning.state).toEqual(pending.stateForRenderer);
    expect(firstRunning.gate).not.toBeNull();
    expect(secondRunning.state).toMatchObject({
      widgetPath: null,
      running: false,
      status: "venv:Starting game…",
    });
    expect(secondRunning.gate).not.toBeNull();
  });

  it("releases when the target workspace reports command failure", () => {
    const pending = beginEmulatorSwitch("/workspace/new-game", oldState);
    const failedState: EmulatorStateSnapshot = {
      ...targetState,
      running: false,
      status: "Command failed",
      lastError: "uv sync failed",
    };
    const result = handleEmulatorSwitchState(pending.gate, failedState, pending.stateForRenderer);

    expect(result.state).toEqual(failedState);
    expect(result.gate).toBeNull();
  });

  it("releases when a command failure has no target path", () => {
    const pending = beginEmulatorSwitch("/workspace/new-game", oldState);
    const failedState: EmulatorStateSnapshot = {
      widgetPath: null,
      widgetId: null,
      widgetType: null,
      running: false,
      fps: 60,
      status: "Command failed",
      lastError: "No widget path is configured",
    };

    const result = handleEmulatorSwitchState(pending.gate, failedState, pending.stateForRenderer);

    expect(result.state).toEqual(failedState);
    expect(result.gate).toBeNull();
  });

  it("rejects decoded renderer frames that started before a reset", () => {
    const generationBeforeReset = 7;
    const resetGeneration = nextFrameRenderGeneration(generationBeforeReset);

    expect(shouldRenderFrameGeneration(generationBeforeReset, resetGeneration)).toBe(false);
    expect(shouldRenderFrameGeneration(resetGeneration, resetGeneration)).toBe(true);
  });
});
