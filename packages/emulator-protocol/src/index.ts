export const EMULATOR_IPC_CHANNELS = {
  emulatorCommand: "emulator:command",
  emulatorPickPath: "emulator:pickPath",
  emulatorGetLastPath: "emulator:getLastPath",
  emulatorGetBackground: "emulator:getBackground",
  emulatorState: "emulator:state",
  emulatorFrame: "emulator:frame",
  emulatorLog: "emulator:log",
  /** Main → renderer: clear buffered log UI before a widget reload. */
  emulatorLogsClear: "emulator:logs-clear",
  emulatorOpenCaptureFolder: "emulator:openCaptureFolder",
} as const;

export type EmulatorCommand =
  | { type: "set_path"; path: string }
  | { type: "set_params"; params: Record<string, unknown> }
  | { type: "stop_widget" }
  | { type: "shutdown" }
  | { type: "reload_widget" }
  | { type: "set_button"; button: "A" | "B" | "UP" | "DOWN" | "LEFT" | "RIGHT"; pressed: boolean }
  | { type: "throw_dart"; index: number; x: number; y: number }
  | { type: "remove_dart_at"; x: number; y: number }
  | { type: "clear_darts" }
  | { type: "capture_screenshot" };

/** Bridge sets `status` to `venv:<message>` while `uv sync` prepares the workspace `.venv`. */
export const VENV_PREP_STATUS_PREFIX = "venv:";
export const VENV_PREP_STATUS_HOLD_MS = 750;

export function isVenvPrepStatus(status: string): boolean {
  return status.startsWith(VENV_PREP_STATUS_PREFIX);
}

export function venvPrepStatusMessage(status: string): string {
  if (!isVenvPrepStatus(status)) {
    return status;
  }
  const message = status.slice(VENV_PREP_STATUS_PREFIX.length).trim();
  return message || "Preparing workspace environment…";
}

export function createVenvPrepStatus(message = "Preparing workspace environment…"): string {
  return `${VENV_PREP_STATUS_PREFIX}${message}`;
}

export type VenvPrepDisplay = {
  visible: boolean;
  message: string;
  observedAtMs: number | null;
};

export function createHiddenVenvPrepDisplay(): VenvPrepDisplay {
  return {
    visible: false,
    message: "",
    observedAtMs: null,
  };
}

export function nextVenvPrepDisplay(
  current: VenvPrepDisplay,
  status: string,
  nowMs: number,
  holdMs = VENV_PREP_STATUS_HOLD_MS,
): VenvPrepDisplay {
  if (isVenvPrepStatus(status)) {
    return {
      visible: true,
      message: venvPrepStatusMessage(status),
      observedAtMs: nowMs,
    };
  }
  if (current.visible && current.observedAtMs !== null && nowMs - current.observedAtMs < holdMs) {
    return current;
  }
  return createHiddenVenvPrepDisplay();
}

export type EmulatorStateSnapshot = {
  widgetPath: string | null;
  widgetId?: string | null;
  widgetType?: string | null;
  running: boolean;
  fps: number;
  status: string;
  lastError?: string;
  lastCapturePath?: string | null;
};

export type EmulatorFrame = {
  width: number;
  height: number;
  rgbBase64: string;
  timestampMs: number;
};

export type EmulatorSwitchGate = {
  targetWidgetPath: string;
  observedTargetNotRunning: boolean;
  targetRunningStateCount: number;
  targetRunningState: EmulatorStateSnapshot | null;
};

export function beginEmulatorSwitch(
  targetWidgetPath: string,
  currentState: EmulatorStateSnapshot,
): { gate: EmulatorSwitchGate; stateForRenderer: EmulatorStateSnapshot } {
  return {
    gate: {
      targetWidgetPath,
      observedTargetNotRunning: false,
      targetRunningStateCount: 0,
      targetRunningState: null,
    },
    stateForRenderer: {
      widgetPath: null,
      widgetId: null,
      widgetType: null,
      running: false,
      fps: currentState.fps,
      status: createVenvPrepStatus(),
      lastError: undefined,
      lastCapturePath: currentState.lastCapturePath ?? null,
    },
  };
}

export function handleEmulatorSwitchFrame(
  gate: EmulatorSwitchGate | null,
  frame: EmulatorFrame,
): { gate: EmulatorSwitchGate | null; frame: EmulatorFrame | null; state: EmulatorStateSnapshot | null } {
  if (gate) {
    if (gate.targetRunningState) {
      return { gate: null, frame, state: gate.targetRunningState };
    }
    return { gate, frame: null, state: null };
  }
  return { gate, frame, state: null };
}

function isEmulatorFailureState(state: EmulatorStateSnapshot): boolean {
  return Boolean(state.lastError?.trim()) || state.status === "Command failed" || state.status === "Bridge error";
}

export function handleEmulatorSwitchState(
  gate: EmulatorSwitchGate | null,
  incomingState: EmulatorStateSnapshot,
  currentState: EmulatorStateSnapshot,
): { gate: EmulatorSwitchGate | null; state: EmulatorStateSnapshot } {
  if (!gate) {
    return { gate: null, state: incomingState };
  }
  const isTarget = incomingState.widgetPath === gate.targetWidgetPath;
  if (isEmulatorFailureState(incomingState)) {
    return { gate: null, state: incomingState };
  }
  const stateForRenderer: EmulatorStateSnapshot = {
    ...currentState,
    widgetPath: null,
    widgetId: null,
    widgetType: null,
    running: false,
    status: createVenvPrepStatus("Starting game…"),
    lastError: undefined,
  };
  const nextGate: EmulatorSwitchGate = !isTarget
    ? gate
    : {
        ...gate,
        observedTargetNotRunning: gate.observedTargetNotRunning || !incomingState.running,
        targetRunningStateCount: incomingState.running
          ? gate.targetRunningStateCount + 1
          : gate.targetRunningStateCount,
        targetRunningState: incomingState.running ? incomingState : gate.targetRunningState,
      };
  if (isTarget && incomingState.running && gate.observedTargetNotRunning) {
    return { gate: nextGate, state: stateForRenderer };
  }
  if (isTarget && incomingState.running && nextGate.targetRunningStateCount >= 2) {
    return { gate: nextGate, state: stateForRenderer };
  }
  return { gate: nextGate, state: currentState };
}

export function nextFrameRenderGeneration(currentGeneration: number): number {
  return Number.isSafeInteger(currentGeneration) ? currentGeneration + 1 : 1;
}

export function shouldRenderFrameGeneration(frameGeneration: number, currentGeneration: number): boolean {
  return frameGeneration === currentGeneration;
}

export type EmulatorLogEntry = {
  source: "stdout" | "stderr";
  text: string;
  timestampMs: number;
};
