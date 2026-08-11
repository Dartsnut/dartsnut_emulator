export const DART_LEGEND_INDEXES = [0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11] as const;

export function resolveDartShortcut(eventKey: string, widgetType?: string | null): number | null {
  if (widgetType?.toLowerCase() !== "game") {
    return null;
  }

  const match = /^f([1-9]|1[0-2])$/i.exec(eventKey);
  return match ? DART_LEGEND_INDEXES[Number(match[1]) - 1] : null;
}
