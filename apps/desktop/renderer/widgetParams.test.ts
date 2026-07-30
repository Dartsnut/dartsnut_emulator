import { describe, expect, it } from "vitest";
import { parseWidgetFieldDefinitions, type WidgetConfigSnapshot } from "@dartsnut/shared-ipc";
import { resolveWidgetParams, valuesForWidgetConfig } from "./widgetParams";

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
});
