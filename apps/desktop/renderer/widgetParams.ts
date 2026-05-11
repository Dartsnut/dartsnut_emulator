/**
 * Shared widget JSON params parsing and pushing to the emulator bridge (same commands as Emulator toolbar).
 */

export function parseWidgetParamsJson(rawText: string): { params: Record<string, unknown>; pretty: string } {
  const parsed = JSON.parse(rawText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Params must be a JSON object.");
  }
  return {
    params: parsed as Record<string, unknown>,
    pretty: JSON.stringify(parsed, null, 2),
  };
}

export function formatWidgetParamsJson(
  widgetParamsText: string,
  setWidgetParamsText: (s: string) => void,
  setWidgetParamsError: (e: string | null) => void,
): void {
  try {
    const { pretty } = parseWidgetParamsJson(widgetParamsText);
    setWidgetParamsText(pretty);
    setWidgetParamsError(null);
  } catch (error) {
    setWidgetParamsError(error instanceof Error ? error.message : "Invalid JSON.");
  }
}

export async function applyWidgetParamsAndReload(options: {
  widgetParamsText: string;
  setWidgetParamsText: (s: string) => void;
  setWidgetParamsError: (e: string | null) => void;
  onAfterApply?: () => void;
}): Promise<string | undefined> {
  const api = window.dartsnutApi;
  if (!api?.sendEmulatorCommand) {
    return undefined;
  }
  const response = await api.getLastWidgetPath();
  const path = response?.path?.trim() ?? "";
  if (!path) {
    options.setWidgetParamsError("Select a widget folder first.");
    return undefined;
  }
  let params: Record<string, unknown>;
  let pretty: string;
  try {
    const parsed = parseWidgetParamsJson(options.widgetParamsText);
    params = parsed.params;
    pretty = parsed.pretty;
  } catch (error) {
    options.setWidgetParamsError(error instanceof Error ? error.message : "Invalid JSON.");
    return undefined;
  }
  options.setWidgetParamsText(pretty);
  options.setWidgetParamsError(null);
  await api.sendEmulatorCommand({ type: "set_params", params });
  await api.sendEmulatorCommand({ type: "reload_widget" });
  options.onAfterApply?.();
  return pretty;
}
