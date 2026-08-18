import type { EmulatorStateSnapshot } from "@dartsnut/emulator-protocol";

export function copyEmulatorStateSnapshot(
  target: EmulatorStateSnapshot,
  nextState: EmulatorStateSnapshot,
): void {
  target.widgetPath = nextState.widgetPath;
  target.widgetId = nextState.widgetId;
  target.widgetType = nextState.widgetType;
  target.running = nextState.running;
  target.fps = nextState.fps;
  target.status = nextState.status;
  target.audioMuted = nextState.audioMuted;
  target.lastError = nextState.lastError;
  target.lastCapturePath = nextState.lastCapturePath;
  target.gifRecording = nextState.gifRecording ?? false;
  target.gifSaving = nextState.gifSaving ?? false;
  target.gifElapsedMs = nextState.gifElapsedMs ?? 0;
}
