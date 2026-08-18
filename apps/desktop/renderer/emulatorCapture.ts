export type CaptureZoom = 1 | 2 | 4;
export type CaptureMode = "screenshot" | "gif";

export type CaptureOutputSize = {
  label: string;
  width: number;
  height: number;
};

export const CAPTURE_ZOOMS: readonly CaptureZoom[] = [1, 2, 4];

export function captureOutputSizes(
  mode: CaptureMode,
  width: number,
  height: number,
  zoom: CaptureZoom,
): CaptureOutputSize[] {
  if (mode === "screenshot") {
    return [
      { label: "Hardware", width: 588, height: 800 },
      { label: "Surface", width: width * zoom, height: height * zoom },
    ];
  }
  if (width === 128 && height === 160) {
    return [
      { label: "Main GIF", width: 128 * zoom, height: 128 * zoom },
      { label: "Bottom GIF", width: 64 * zoom, height: 32 * zoom },
    ];
  }
  return [{ label: "GIF", width: width * zoom, height: height * zoom }];
}

export function formatRecordingElapsed(elapsedMs: number): string {
  const seconds = Math.min(30, Math.max(0, Math.floor(elapsedMs / 1000)));
  return `00:${String(seconds).padStart(2, "0")}`;
}
