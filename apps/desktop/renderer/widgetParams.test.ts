import { describe, expect, it } from "vitest";
import { parseWidgetFieldDefinitions, reconcileWidgetFieldValues, type WidgetConfigSnapshot } from "@dartsnut/shared-ipc";
import { editorLocationValue, normalizeWidgetConfigSnapshot, resolveWidgetParams, valuesForWidgetConfig } from "./widgetParams";

function readyConfig(fields: unknown, errors: string[] = []): WidgetConfigSnapshot {
  const parsed = parseWidgetFieldDefinitions(fields);
  return {
    scope: "workspace",
    status: "ready",
    configKey: "/workspace/conf.json",
    confPath: "/workspace/conf.json",
    fields: parsed.fields,
    errors: [...parsed.errors, ...errors],
  };
}

describe("widget params resolver", () => {
  it("uses defaults and serializes an empty field list to an empty object", () => {
    const config = readyConfig([]);
    expect(valuesForWidgetConfig(config, {})).toEqual({});
    expect(resolveWidgetParams(config, {})).toMatchObject({ ok: true, params: {}, json: "{}" });
  });

  it("serializes typed values for the active config key", () => {
    const config = readyConfig([
      { id: "count", name: "Count", type: "number", min: 1, max: 10, default: 2 },
      { id: "enabled", name: "Enabled", type: "toggle", default: false },
    ]);
    expect(resolveWidgetParams(config, {
      "/workspace/conf.json": { fields: config.status === "ready" ? config.fields : [], values: { count: "5", enabled: true } },
    })).toMatchObject({ ok: true, params: { count: 5, enabled: true } });
  });

  it("hydrates missing or invalid stored values from field defaults", () => {
    const config = readyConfig([
      { id: "title", name: "Title", type: "text", default: "Hello" },
      { id: "city", name: "City", type: "location", default: { name: "Tokyo", timezone: "Asia/Tokyo", lat: 35.6, lng: 139.7 } },
    ]);
    const values = reconcileWidgetFieldValues(config.fields, { city: { name: "Tokyo", lat: 35.6, lng: 139.7, timezone: "UTC" } }, config.fields);
    expect(values).toEqual({ title: "Hello", city: { name: "Tokyo", timezone: "UTC", lat: 35.6, lng: 139.7 } });
  });

  it("loads config defaults when no values have been stored", () => {
    const config = readyConfig([
      { id: "title", name: "Title", type: "text", default: "Hello" },
      { id: "enabled", name: "Enabled", type: "toggle", default: true },
    ]);
    expect(valuesForWidgetConfig(config, {})).toEqual({ title: "Hello", enabled: true });
  });

  it("normalizes native snapshots that still use raw default keys", () => {
    const snapshot = {
      scope: "workspace" as const,
      status: "ready" as const,
      configKey: "/workspace/conf.json",
      confPath: "/workspace/conf.json",
      fields: [{ id: "location", name: "Location", type: "location", default: { name: "Hongkong", lat: 22.3, lng: 114.1, timezone: "Asia/Hong_Kong" } }],
      errors: [],
    } as unknown as WidgetConfigSnapshot;
    const normalized = normalizeWidgetConfigSnapshot(snapshot);
    expect(normalized.fields[0]).toMatchObject({ defaultValue: { name: "Hongkong", timezone: "Asia/Hong_Kong" } });
  });

  it("blocks unavailable configs, schema errors, and invalid field values", () => {
    const unavailable: WidgetConfigSnapshot = {
      scope: "emulator",
      status: "unavailable",
      configKey: null,
      confPath: null,
      message: "No widget selected.",
    };
    expect(resolveWidgetParams(unavailable, {})).toMatchObject({ ok: false, message: "No widget selected." });

    const schemaError = readyConfig([{ id: "title", name: "Title", type: "text" }], ["broken"]);
    expect(resolveWidgetParams(schemaError, {})).toMatchObject({ ok: false, message: expect.stringContaining("conf.json") });

    const invalid = readyConfig([{ id: "color", name: "Color", type: "color", default: "#FFFFFF" }]);
    const result = resolveWidgetParams(invalid, {
      "/workspace/conf.json": { fields: invalid.status === "ready" ? invalid.fields : [], values: { color: "red" } },
    });
    expect(result).toMatchObject({ ok: false, fieldErrors: { color: expect.stringContaining("#RRGGBB") } });
  });

  it("normalizes malformed location values before editor rendering", () => {
    expect(editorLocationValue(undefined, undefined)).toEqual({ name: "", timezone: "", lat: "", lng: "" });
    expect(editorLocationValue(null, { name: "Fallback", timezone: "UTC", lat: 1, lng: 2 })).toEqual({
      name: "Fallback", timezone: "UTC", lat: 1, lng: 2,
    });
    expect(editorLocationValue({ name: undefined, timezone: null, lat: "x", lng: false }, {})).toEqual({
      name: "", timezone: "", lat: "x", lng: "",
    });
  });
});
