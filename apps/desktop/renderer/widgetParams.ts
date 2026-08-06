import {
  createDefaultWidgetFieldValues,
  validateAndSerializeWidgetFieldValues,
  type WidgetConfigSnapshot,
  type WidgetFieldDefinition,
  type WidgetFieldValues,
} from "@dartsnut/shared-ipc";

export type WidgetValueStore = Record<string, { fields: WidgetFieldDefinition[]; values: WidgetFieldValues }>;

export type ResolvedWidgetParams =
  | { ok: true; params: Record<string, unknown>; json: string; values: WidgetFieldValues }
  | { ok: false; message: string; fieldErrors: Record<string, string> };

export function valuesForWidgetConfig(
  config: WidgetConfigSnapshot,
  store: WidgetValueStore,
): WidgetFieldValues {
  if (config.status !== "ready") {
    return {};
  }
  return store[config.configKey]?.values ?? createDefaultWidgetFieldValues(config.fields);
}

export function resolveWidgetParams(
  config: WidgetConfigSnapshot,
  store: WidgetValueStore,
): ResolvedWidgetParams {
  if (config.status !== "ready") {
    return { ok: false, message: config.message, fieldErrors: {} };
  }
  if (config.errors.length > 0) {
    return { ok: false, message: "Fix the field definitions in conf.json before applying params.", fieldErrors: {} };
  }
  const values = valuesForWidgetConfig(config, store);
  const validation = validateAndSerializeWidgetFieldValues(config.fields, values);
  if (!validation.ok) {
    return { ok: false, message: "Fix the highlighted field values before applying params.", fieldErrors: validation.errors };
  }
  return {
    ok: true,
    params: validation.params,
    json: JSON.stringify(validation.params),
    values,
  };
}

export async function applyWidgetParamsAndReload(options: {
  config: WidgetConfigSnapshot;
  store: WidgetValueStore;
  onAfterApply?: () => void;
}): Promise<string | undefined> {
  const api = window.dartsnutApi;
  if (!api?.sendEmulatorCommand) {
    return undefined;
  }
  const resolved = resolveWidgetParams(options.config, options.store);
  if (!resolved.ok) {
    return undefined;
  }
  await api.sendEmulatorCommand({ type: "set_params", params: resolved.params });
  await api.sendEmulatorCommand({ type: "reload_widget" });
  options.onAfterApply?.();
  return resolved.json;
}
