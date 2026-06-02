export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DisplayWorkArea = {
  workArea: WindowRect;
};

export type PersistedWindowState = WindowRect & {
  isMaximized: boolean;
  isFullScreen: boolean;
};

export const DEFAULT_WINDOW_WIDTH = 1560;
export const DEFAULT_WINDOW_HEIGHT = 980;
export const MIN_WINDOW_WIDTH = 1320;
export const MIN_WINDOW_HEIGHT = 860;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasDisplayIntersection(bounds: WindowRect, displays: ReadonlyArray<DisplayWorkArea>): boolean {
  return displays.some((display) => {
    const area = display.workArea;
    const intersectsX = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x;
    const intersectsY = bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    return intersectsX && intersectsY;
  });
}

export function normalizeWindowBounds(input: unknown, displays: ReadonlyArray<DisplayWorkArea>): WindowRect | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<WindowRect>;
  if (
    !isFiniteNumber(candidate.x) ||
    !isFiniteNumber(candidate.y) ||
    !isFiniteNumber(candidate.width) ||
    !isFiniteNumber(candidate.height)
  ) {
    return null;
  }
  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(candidate.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(candidate.height));
  const bounds: WindowRect = {
    x: Math.round(candidate.x),
    y: Math.round(candidate.y),
    width,
    height
  };
  return hasDisplayIntersection(bounds, displays) ? bounds : null;
}

