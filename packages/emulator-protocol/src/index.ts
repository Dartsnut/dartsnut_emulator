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

export type EmulatorPanelId = "surface" | "main" | "secondary";

export type EmulatorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type EmulatorDominantColor = {
  hex: string;
  count: number;
};

export type EmulatorPanelStats = {
  pixelCount: number;
  nonBlackPixelCount: number;
  nonBlackPixelRatio: number;
  nonBlackBounds: EmulatorRect | null;
  dominantColors: EmulatorDominantColor[];
  hash: string;
};

export type EmulatorDisplayPanel = {
  id: EmulatorPanelId;
  label: string;
  sourceRect: EmulatorRect;
  hardwareRect: EmulatorRect | null;
  stats: EmulatorPanelStats;
  pngBase64?: string;
};

export type EmulatorFrameObservation = {
  width: number;
  height: number;
  timestampMs: number;
  surfaceHash: string;
  changedSincePrevious: boolean;
  surfacePngBase64?: string;
  mainSurfacePngBase64?: string;
  bottomSurfacePngBase64?: string;
  hardwarePngBase64?: string;
};

export type EmulatorObservation = {
  ok: boolean;
  error?: string;
  frame?: EmulatorFrameObservation;
  emulator: EmulatorStateSnapshot;
  logs: EmulatorLogEntry[];
  display: {
    size: { width: number; height: number };
    mapping: "128x160" | "128x128" | "128x64" | "64x32" | "surface";
    panels: EmulatorDisplayPanel[];
  };
};

export type EmulatorInputAction =
  | { type: "throw_dart"; index: number | "next"; x: number; y: number }
  | { type: "remove_dart"; x: number; y: number }
  | { type: "clear_darts" }
  | { type: "set_button"; button: "A" | "B" | "UP" | "DOWN" | "LEFT" | "RIGHT"; pressed: boolean }
  | { type: "tap_button"; button: "A" | "B" | "UP" | "DOWN" | "LEFT" | "RIGHT"; duration_ms?: number }
  | { type: "sequence"; actions: EmulatorInputAction[] };

export type EmulatorScenarioStep =
  | { type: "reload"; params?: Record<string, unknown>; clear_inputs?: boolean; wait_for_frame_ms?: number }
  | { type: "wait_frame"; timeout_ms?: number }
  | { type: "observe"; include_png?: boolean; max_log_lines?: number }
  | { type: "input"; action: EmulatorInputAction }
  | { type: "delay"; ms: number }
  | { type: "logs"; max_lines?: number };

export type EmulatorScenario = {
  steps: EmulatorScenarioStep[];
  timeout_ms?: number;
};

export const MAX_EMULATOR_SCENARIO_STEPS = 30;
export const MAX_EMULATOR_SCENARIO_TOTAL_MS = 30_000;
export const MAX_EMULATOR_SCENARIO_OBSERVATIONS = 4;

export type EmulatorScenarioSummary = {
  steps: EmulatorScenarioStep[];
  stepCount: number;
  timeoutMs: number;
  observationLimit: number;
  truncatedSteps: boolean;
};

export type BuildEmulatorObservationInput = {
  frame: EmulatorFrame;
  state: EmulatorStateSnapshot;
  logs: EmulatorLogEntry[];
  previousSurfaceHash?: string | null;
  includePngBase64?: boolean;
  surfacePngBase64?: string;
  panelPngBase64?: Partial<Record<EmulatorPanelId, string>>;
  hardwarePngBase64?: string;
};

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function sha256Hex(bytes: Uint8Array): string {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  const w = new Array<number>(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}

function decodeRgbBase64(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesForRect(frameBytes: Uint8Array, frameWidth: number, rect: EmulatorRect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height * 3);
  let dest = 0;
  for (let y = 0; y < rect.height; y += 1) {
    const src = ((rect.y + y) * frameWidth + rect.x) * 3;
    out.set(frameBytes.slice(src, src + rect.width * 3), dest);
    dest += rect.width * 3;
  }
  return out;
}

function summarizeRect(frameBytes: Uint8Array, frameWidth: number, rect: EmulatorRect): EmulatorPanelStats {
  let nonBlackPixelCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  const colors = new Map<string, number>();
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const offset = ((rect.y + y) * frameWidth + rect.x + x) * 3;
      const r = frameBytes[offset] ?? 0;
      const g = frameBytes[offset + 1] ?? 0;
      const b = frameBytes[offset + 2] ?? 0;
      const hex = rgbToHex(r, g, b);
      colors.set(hex, (colors.get(hex) ?? 0) + 1);
      if (r !== 0 || g !== 0 || b !== 0) {
        nonBlackPixelCount += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const pixelCount = rect.width * rect.height;
  return {
    pixelCount,
    nonBlackPixelCount,
    nonBlackPixelRatio: pixelCount === 0 ? 0 : nonBlackPixelCount / pixelCount,
    nonBlackBounds:
      maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    dominantColors: [...colors.entries()]
      .map(([hex, count]) => ({ hex, count }))
      .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex))
      .slice(0, 8),
    hash: sha256Hex(bytesForRect(frameBytes, frameWidth, rect)),
  };
}

function displayPanelsForFrame(width: number, height: number): Array<Omit<EmulatorDisplayPanel, "stats">> {
  if (width === 128 && height === 160) {
    return [
      {
        id: "main",
        label: "Main 128x128 panel",
        sourceRect: { x: 0, y: 0, width: 128, height: 128 },
        hardwareRect: { x: 38, y: 38, width: 512, height: 512 },
      },
      {
        id: "secondary",
        label: "Secondary 64x32 panel",
        sourceRect: { x: 0, y: 128, width: 64, height: 32 },
        hardwareRect: { x: 123, y: 601, width: 342, height: 176 },
      },
    ];
  }
  if (width === 128 && height === 128) {
    return [
      {
        id: "main",
        label: "Main 128x128 panel",
        sourceRect: { x: 0, y: 0, width: 128, height: 128 },
        hardwareRect: { x: 38, y: 38, width: 512, height: 512 },
      },
    ];
  }
  if (width === 128 && height === 64) {
    return [
      {
        id: "main",
        label: "Main 128x64 surface on 128x128 panel",
        sourceRect: { x: 0, y: 0, width: 128, height: 64 },
        hardwareRect: { x: 38, y: 38, width: 512, height: 512 },
      },
    ];
  }
  if (width === 64 && height === 32) {
    return [
      {
        id: "secondary",
        label: "Secondary 64x32 panel",
        sourceRect: { x: 0, y: 0, width: 64, height: 32 },
        hardwareRect: { x: 123, y: 601, width: 342, height: 176 },
      },
    ];
  }
  return [
    {
      id: "surface",
      label: "Logical framebuffer surface",
      sourceRect: { x: 0, y: 0, width, height },
      hardwareRect: null,
    },
  ];
}

function mappingForSize(width: number, height: number): EmulatorObservation["display"]["mapping"] {
  if (width === 128 && height === 160) return "128x160";
  if (width === 128 && height === 128) return "128x128";
  if (width === 128 && height === 64) return "128x64";
  if (width === 64 && height === 32) return "64x32";
  return "surface";
}

export function buildEmulatorObservationFromFrame(input: BuildEmulatorObservationInput): EmulatorObservation {
  const bytes = decodeRgbBase64(input.frame.rgbBase64);
  const expectedBytes = input.frame.width * input.frame.height * 3;
  if (bytes.length < expectedBytes) {
    return {
      ok: false,
      error: `Frame has ${bytes.length} RGB bytes, expected ${expectedBytes}.`,
      emulator: input.state,
      logs: input.logs,
      display: {
        size: { width: input.frame.width, height: input.frame.height },
        mapping: mappingForSize(input.frame.width, input.frame.height),
        panels: [],
      },
    };
  }
  const surfaceRect = { x: 0, y: 0, width: input.frame.width, height: input.frame.height };
  const surfaceHash = sha256Hex(bytes.slice(0, expectedBytes));
  const panels = displayPanelsForFrame(input.frame.width, input.frame.height).map((panel) => {
    const pngBase64 = input.includePngBase64 ? input.panelPngBase64?.[panel.id] : undefined;
    return {
      ...panel,
      stats: summarizeRect(bytes, input.frame.width, panel.sourceRect),
      ...(pngBase64 ? { pngBase64 } : {}),
    };
  });
  if (panels.length === 0 || panels[0].id !== "surface") {
    panels.unshift({
      id: "surface",
      label: "Logical framebuffer surface",
      sourceRect: surfaceRect,
      hardwareRect: null,
      stats: summarizeRect(bytes, input.frame.width, surfaceRect),
    });
  }
  return {
    ok: true,
    emulator: input.state,
    logs: input.logs,
    frame: {
      width: input.frame.width,
      height: input.frame.height,
      timestampMs: input.frame.timestampMs,
      surfaceHash,
      changedSincePrevious: input.previousSurfaceHash == null || input.previousSurfaceHash !== surfaceHash,
      ...(input.includePngBase64 && input.surfacePngBase64 ? { surfacePngBase64: input.surfacePngBase64 } : {}),
      ...(input.includePngBase64 && input.panelPngBase64?.main
        ? { mainSurfacePngBase64: input.panelPngBase64.main }
        : {}),
      ...(input.includePngBase64 && input.panelPngBase64?.secondary
        ? { bottomSurfacePngBase64: input.panelPngBase64.secondary }
        : {}),
      ...(input.includePngBase64 && input.hardwarePngBase64 ? { hardwarePngBase64: input.hardwarePngBase64 } : {}),
    },
    display: {
      size: { width: input.frame.width, height: input.frame.height },
      mapping: mappingForSize(input.frame.width, input.frame.height),
      panels,
    },
  };
}

export function summarizeEmulatorScenario(input: {
  steps: EmulatorScenarioStep[];
  requestedTimeoutMs?: number;
  requestedObservations?: number;
}): EmulatorScenarioSummary {
  const steps = input.steps.slice(0, MAX_EMULATOR_SCENARIO_STEPS);
  return {
    steps,
    stepCount: steps.length,
    timeoutMs: Math.min(
      MAX_EMULATOR_SCENARIO_TOTAL_MS,
      Math.max(1, Math.floor(input.requestedTimeoutMs ?? MAX_EMULATOR_SCENARIO_TOTAL_MS)),
    ),
    observationLimit: Math.min(
      MAX_EMULATOR_SCENARIO_OBSERVATIONS,
      Math.max(1, Math.floor(input.requestedObservations ?? MAX_EMULATOR_SCENARIO_OBSERVATIONS)),
    ),
    truncatedSteps: input.steps.length > MAX_EMULATOR_SCENARIO_STEPS,
  };
}
