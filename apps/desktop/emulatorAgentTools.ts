import zlib from "node:zlib";
import {
  type EmulatorPanelId,
  type EmulatorRect,
  summarizeEmulatorScenario,
  type EmulatorFrame,
  type EmulatorInputAction,
  type EmulatorScenarioStep,
} from "@dartsnut/emulator-protocol";

type BridgeInputCommand =
  | { type: "throw_dart"; index: number; x: number; y: number }
  | { type: "remove_dart_at"; x: number; y: number }
  | { type: "clear_darts" }
  | { type: "set_button"; button: ButtonName; pressed: boolean }
  | { type: "delay"; ms: number };

type ButtonName = "A" | "B" | "UP" | "DOWN" | "LEFT" | "RIGHT";

const BUTTONS = new Set<ButtonName>(["A", "B", "UP", "DOWN", "LEFT", "RIGHT"]);

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function encodeRgbPngBase64(frame: Pick<EmulatorFrame, "width" | "height" | "rgbBase64">): string {
  const rgb = Buffer.from(frame.rgbBase64, "base64");
  const expected = frame.width * frame.height * 3;
  if (rgb.length < expected) {
    throw new Error(`Frame has ${rgb.length} RGB bytes, expected ${expected}.`);
  }

  const raw = Buffer.alloc(frame.height * (frame.width * 3 + 1));
  for (let y = 0; y < frame.height; y += 1) {
    const rawRow = y * (frame.width * 3 + 1);
    raw[rawRow] = 0;
    rgb.copy(raw, rawRow + 1, y * frame.width * 3, (y + 1) * frame.width * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(frame.width, 0);
  ihdr.writeUInt32BE(frame.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

export function encodeRgbRectPngBase64(
  frame: Pick<EmulatorFrame, "width" | "height" | "rgbBase64">,
  rect: EmulatorRect,
): string {
  const rgb = Buffer.from(frame.rgbBase64, "base64");
  const expected = frame.width * frame.height * 3;
  if (rgb.length < expected) {
    throw new Error(`Frame has ${rgb.length} RGB bytes, expected ${expected}.`);
  }
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > frame.width ||
    rect.y + rect.height > frame.height
  ) {
    throw new Error("Crop rectangle is outside the frame.");
  }

  const cropped = Buffer.alloc(rect.width * rect.height * 3);
  for (let y = 0; y < rect.height; y += 1) {
    rgb.copy(
      cropped,
      y * rect.width * 3,
      ((rect.y + y) * frame.width + rect.x) * 3,
      ((rect.y + y) * frame.width + rect.x + rect.width) * 3,
    );
  }
  return encodeRgbPngBase64({
    width: rect.width,
    height: rect.height,
    rgbBase64: cropped.toString("base64"),
  });
}

export function encodePanelPngsBase64(
  frame: Pick<EmulatorFrame, "width" | "height" | "rgbBase64">,
): Partial<Record<EmulatorPanelId, string>> {
  if (frame.width === 128 && frame.height === 160) {
    return {
      main: encodeRgbRectPngBase64(frame, { x: 0, y: 0, width: 128, height: 128 }),
      secondary: encodeRgbRectPngBase64(frame, { x: 0, y: 128, width: 64, height: 32 }),
    };
  }
  if (frame.width === 128 && frame.height === 128) {
    return {
      main: encodeRgbRectPngBase64(frame, { x: 0, y: 0, width: 128, height: 128 }),
    };
  }
  if (frame.width === 128 && frame.height === 64) {
    return {
      main: encodeRgbRectPngBase64(frame, { x: 0, y: 0, width: 128, height: 64 }),
    };
  }
  if (frame.width === 64 && frame.height === 32) {
    return {
      secondary: encodeRgbRectPngBase64(frame, { x: 0, y: 0, width: 64, height: 32 }),
    };
  }
  return {};
}

function encodeRgbaPngBase64(width: number, height: number, rgba: Buffer): string {
  const expected = width * height * 4;
  if (rgba.length < expected) {
    throw new Error(`Image has ${rgba.length} RGBA bytes, expected ${expected}.`);
  }

  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rawRow = y * (width * 4 + 1);
    raw[rawRow] = 0;
    rgba.copy(raw, rawRow + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function blitNearest(
  canvas: Buffer,
  canvasWidth: number,
  sourceRgb: Buffer,
  sourceWidth: number,
  sourceX: number,
  sourceY: number,
  sourceWidthRect: number,
  sourceHeightRect: number,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
): void {
  for (let y = 0; y < destHeight; y += 1) {
    const sy = sourceY + Math.min(sourceHeightRect - 1, Math.floor((y * sourceHeightRect) / destHeight));
    for (let x = 0; x < destWidth; x += 1) {
      const sx = sourceX + Math.min(sourceWidthRect - 1, Math.floor((x * sourceWidthRect) / destWidth));
      const sourceOffset = (sy * sourceWidth + sx) * 3;
      const destOffset = ((destY + y) * canvasWidth + destX + x) * 4;
      canvas[destOffset] = sourceRgb[sourceOffset] ?? 0;
      canvas[destOffset + 1] = sourceRgb[sourceOffset + 1] ?? 0;
      canvas[destOffset + 2] = sourceRgb[sourceOffset + 2] ?? 0;
      canvas[destOffset + 3] = 255;
    }
  }
}

function drawGridLine(canvas: Buffer, canvasWidth: number, x: number, y: number, width: number, height: number): void {
  const alpha = 0.2;
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      const offset = (yy * canvasWidth + xx) * 4;
      canvas[offset] = Math.round(canvas[offset] * (1 - alpha));
      canvas[offset + 1] = Math.round(canvas[offset + 1] * (1 - alpha));
      canvas[offset + 2] = Math.round(canvas[offset + 2] * (1 - alpha));
      canvas[offset + 3] = 255;
    }
  }
}

function drawCaptureGridOverlay(canvas: Buffer, canvasWidth: number, frameWidth: number, frameHeight: number): void {
  const mainX = 38;
  const mainY = 38;
  const mainStep = 4;
  const mainSize = 512;
  for (let i = 0; i <= 128; i += 1) {
    const x = mainX + i * mainStep;
    const y = mainY + i * mainStep;
    drawGridLine(canvas, canvasWidth, x, mainY, 1, mainSize);
    drawGridLine(canvas, canvasWidth, mainX, y, mainSize, 1);
  }

  if ((frameWidth === 128 && frameHeight === 160) || (frameWidth === 64 && frameHeight === 32)) {
    const secX = 123;
    const secY = 601;
    const secWidth = 342;
    const secHeight = 176;
    for (let i = 0; i <= 64; i += 1) {
      drawGridLine(canvas, canvasWidth, Math.round(secX + i * (secWidth / 64)), secY, 1, secHeight);
    }
    for (let i = 0; i <= 32; i += 1) {
      drawGridLine(canvas, canvasWidth, secX, Math.round(secY + i * (secHeight / 32)), secWidth, 1);
    }
  }
}

export function encodeHardwareMockupPngBase64(frame: Pick<EmulatorFrame, "width" | "height" | "rgbBase64">): string {
  const rgb = Buffer.from(frame.rgbBase64, "base64");
  const expected = frame.width * frame.height * 3;
  if (rgb.length < expected) {
    throw new Error(`Frame has ${rgb.length} RGB bytes, expected ${expected}.`);
  }

  const canvasWidth = 588;
  const canvasHeight = 800;
  const canvas = Buffer.alloc(canvasWidth * canvasHeight * 4);
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i + 3] = 255;
  }

  if (frame.width === 128 && frame.height === 160) {
    blitNearest(canvas, canvasWidth, rgb, frame.width, 0, 0, 128, 128, 38, 38, 512, 512);
    blitNearest(canvas, canvasWidth, rgb, frame.width, 0, 128, 64, 32, 123, 601, 342, 176);
  } else if (frame.width === 64 && frame.height === 32) {
    blitNearest(canvas, canvasWidth, rgb, frame.width, 0, 0, 64, 32, 123, 601, 342, 176);
  } else if (frame.width === 128 && frame.height === 128) {
    blitNearest(canvas, canvasWidth, rgb, frame.width, 0, 0, 128, 128, 38, 38, 512, 512);
  } else {
    blitNearest(canvas, canvasWidth, rgb, frame.width, 0, 0, frame.width, frame.height, 38, 38, 512, 512);
  }

  drawCaptureGridOverlay(canvas, canvasWidth, frame.width, frame.height);
  return encodeRgbaPngBase64(canvasWidth, canvasHeight, canvas);
}

function asButton(value: unknown): ButtonName {
  const button = String(value ?? "").toUpperCase();
  if (!BUTTONS.has(button as ButtonName)) {
    throw new Error(`Unknown button: ${String(value)}`);
  }
  return button as ButtonName;
}

function asInt(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer.`);
  }
  return n;
}

function firstEmptyDartIndex(darts: readonly [number, number][]): number {
  const index = darts.findIndex(([x, y]) => x < 0 || y < 0);
  if (index < 0 || index >= 12) {
    throw new Error("No empty dart slot is available.");
  }
  return index;
}

export function normalizeEmulatorInputAction(
  rawAction: unknown,
  darts: readonly [number, number][] = [],
): { commands: BridgeInputCommand[] } {
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    throw new Error("Input action must be an object.");
  }
  const action = rawAction as EmulatorInputAction;
  switch (action.type) {
    case "throw_dart": {
      const index = action.index === "next" ? firstEmptyDartIndex(darts) : asInt(action.index, "index");
      if (index < 0 || index >= 12) {
        throw new Error("Dart index out of range.");
      }
      return {
        commands: [
          {
            type: "throw_dart",
            index,
            x: asInt(action.x, "x"),
            y: asInt(action.y, "y"),
          },
        ],
      };
    }
    case "remove_dart":
      return { commands: [{ type: "remove_dart_at", x: asInt(action.x, "x"), y: asInt(action.y, "y") }] };
    case "clear_darts":
      return { commands: [{ type: "clear_darts" }] };
    case "set_button":
      return { commands: [{ type: "set_button", button: asButton(action.button), pressed: action.pressed === true }] };
    case "tap_button": {
      const ms = Math.min(1000, Math.max(1, asInt(action.duration_ms ?? 80, "duration_ms")));
      const button = asButton(action.button);
      return {
        commands: [
          { type: "set_button", button, pressed: true },
          { type: "delay", ms },
          { type: "set_button", button, pressed: false },
        ],
      };
    }
    case "sequence": {
      if (!Array.isArray(action.actions) || action.actions.length < 1 || action.actions.length > 30) {
        throw new Error("sequence.actions must contain 1 to 30 actions.");
      }
      return {
        commands: action.actions.flatMap((child) => normalizeEmulatorInputAction(child, darts).commands),
      };
    }
    default:
      throw new Error(`Unsupported input action: ${(action as { type?: unknown }).type}`);
  }
}

export function summarizeScenarioRequest(raw: {
  steps?: EmulatorScenarioStep[];
  timeout_ms?: number;
  requestedObservations?: number;
}) {
  return summarizeEmulatorScenario({
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    requestedTimeoutMs: raw.timeout_ms,
    requestedObservations: raw.requestedObservations,
  });
}
