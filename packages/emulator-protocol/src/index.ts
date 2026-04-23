export const EMULATOR_IPC_CHANNELS = {
  emulatorCommand: "emulator:command",
  emulatorPickPath: "emulator:pickPath",
  emulatorGetLastPath: "emulator:getLastPath",
  emulatorGetBackground: "emulator:getBackground",
  emulatorState: "emulator:state",
  emulatorFrame: "emulator:frame",
  emulatorLog: "emulator:log",
} as const;

export type EmulatorCommand =
  | { type: "set_path"; path: string }
  | { type: "set_params"; params: Record<string, unknown> }
  | { type: "reload_widget" }
  | { type: "set_button"; button: "A" | "B" | "UP" | "DOWN" | "LEFT" | "RIGHT"; pressed: boolean }
  | { type: "throw_dart"; index: number; x: number; y: number }
  | { type: "remove_dart_at"; x: number; y: number }
  | { type: "clear_darts" }
  | { type: "capture_screenshot" };

export type EmulatorStateSnapshot = {
  widgetPath: string | null;
  widgetId?: string | null;
  widgetType?: string | null;
  running: boolean;
  fps: number;
  status: string;
  lastError?: string;
};

export type EmulatorFrame = {
  width: number;
  height: number;
  rgbBase64: string;
  timestampMs: number;
};

export type EmulatorLogEntry = {
  source: "stdout" | "stderr";
  text: string;
  timestampMs: number;
};
