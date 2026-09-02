import {
  createDefaultWidgetFieldValues,
  parseWidgetFieldDefinitions,
  validateAndSerializeWidgetFieldValues,
  type WidgetConfigSnapshot,
  type WidgetFieldDefinition,
  type WidgetFieldValues,
  type WidgetLocationValue,
} from "@dartsnut/shared-ipc";

export type WidgetValueStore = Record<string, { fields: WidgetFieldDefinition[]; values: WidgetFieldValues }>;

/** Normalize snapshots from native IPC, including legacy raw `default` fields. */
export function normalizeWidgetConfigSnapshot(snapshot: WidgetConfigSnapshot): WidgetConfigSnapshot {
  if (snapshot.status !== "ready") {
    return snapshot;
  }
  const rawFields = snapshot.fields.map((field) => {
    const raw = field as WidgetFieldDefinition & { default?: unknown };
    return {
      ...raw,
      default: "defaultValue" in raw ? raw.defaultValue : raw.default,
    };
  });
  const parsed = parseWidgetFieldDefinitions(rawFields);
  return {
    ...snapshot,
    fields: parsed.fields,
    errors: [...(snapshot.errors ?? []), ...parsed.errors],
  };
}

export function editorLocationValue(value: unknown, fallback: unknown): WidgetLocationValue {
  const candidate = value && typeof value === "object" ? value : fallback;
  const raw = candidate && typeof candidate === "object"
    ? candidate as Partial<WidgetLocationValue>
    : undefined;
  return {
    name: typeof raw?.name === "string" ? raw.name : typeof raw?.name === "number" ? String(raw.name) : "",
    timezone: typeof raw?.timezone === "string" ? raw.timezone : typeof raw?.timezone === "number" ? String(raw.timezone) : "",
    lat: typeof raw?.lat === "string" || typeof raw?.lat === "number" ? raw.lat : "",
    lng: typeof raw?.lng === "string" || typeof raw?.lng === "number" ? raw.lng : "",
  };
}

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
