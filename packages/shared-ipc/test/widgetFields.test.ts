import { describe, expect, it } from "vitest";
import {
  createDefaultWidgetFieldValues,
  parseWidgetFieldDefinitions,
  reconcileWidgetFieldValues,
  validateAndSerializeWidgetFieldValues,
} from "../src/widgetFields";

const ALL_FIELDS = [
  { id: "title", name: "Title", type: "text", max: 8, default: "hello" },
  { id: "count", name: "Count", type: "number", min: 1, max: 10, step: 1, default: 3 },
  { id: "speed", name: "Speed", type: "slider", min: 0, max: 5, step: 0.5, default: 2 },
  { id: "enabled", name: "Enabled", type: "toggle", default: true },
  {
    id: "mode",
    name: "Mode",
    type: "dropdown",
    options: [
      { display: "Automatic", value: "auto" },
      { display: "Manual", value: 2 },
    ],
    default: "auto",
  },
  {
    id: "days",
    name: "Days",
    type: "checkbox",
    options: [
      { display: "Monday", value: "mon" },
      { display: "Tuesday", value: "tue" },
    ],
    default: ["mon"],
  },
  { id: "accent", name: "Accent", type: "color", default: "#12ABEF" },
  {
    id: "city",
    name: "City",
    type: "location",
    required: true,
    default: { name: "Shanghai", lat: 31.23, lng: 121.47, timezone: "Asia/Shanghai" },
  },
  {
    id: "picture",
    name: "Picture",
    type: "image",
    default: { image: "https://example.test/a.png", cropbox: [0, 0, 128, 64] },
  },
];

describe("parseWidgetFieldDefinitions", () => {
  it("parses every supported field type and compatibility aliases", () => {
    const result = parseWidgetFieldDefinitions([
      ...ALL_FIELDS,
      { field_key: "alias", field_name: "Alias", field_type: "text", description: "Compatible", default: "ok" },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.fields.map((field) => field.type)).toEqual([
      "text",
      "number",
      "slider",
      "toggle",
      "dropdown",
      "checkbox",
      "color",
      "location",
      "image",
      "text",
    ]);
    expect(result.fields.at(-1)).toMatchObject({ id: "alias", name: "Alias", desc: "Compatible" });
  });

  it("reports malformed, duplicate, and unsupported fields", () => {
    const result = parseWidgetFieldDefinitions([
      { id: "same", name: "Same", type: "text" },
      { id: "same", name: "Duplicate", type: "text" },
      { id: "mystery", name: "Mystery", type: "date" },
      { id: "choice", name: "Choice", type: "dropdown", options: [] },
      { id: "bad-color", name: "Bad color", type: "color", default: "red" },
      null,
    ]);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicate id"),
      expect.stringContaining("unsupported type"),
      expect.stringContaining("non-empty array"),
      expect.stringContaining("#RRGGBB"),
      expect.stringContaining("definition must be an object"),
    ]));
  });
});

describe("widget field values", () => {
  it("initializes defaults and serializes typed values", () => {
    const parsed = parseWidgetFieldDefinitions(ALL_FIELDS);
    const values = createDefaultWidgetFieldValues(parsed.fields);
    values.count = "4";
    values.city = { name: "Tokyo", lat: "35.6", lng: "139.7", timezone: "Asia/Tokyo" };
    values.picture = {
      image: "file:///tmp/picture.png",
      cropbox: [1, 2, 10, 20],
      image_width: 100,
      image_height: 200,
    };

    const result = validateAndSerializeWidgetFieldValues(parsed.fields, values);
    expect(result).toEqual({
      ok: true,
      params: expect.objectContaining({
        count: 4,
        mode: "auto",
        days: ["mon"],
        city: { name: "Tokyo", lat: 35.6, lng: 139.7, timezone: "Asia/Tokyo" },
        picture: {
          image: "file:///tmp/picture.png",
          cropbox: [1, 2, 10, 20],
          image_width: 100,
          image_height: 200,
        },
      }),
    });
  });

  it("validates required values, bounds, options, colors, locations, and images", () => {
    const parsed = parseWidgetFieldDefinitions(ALL_FIELDS);
    const values = createDefaultWidgetFieldValues(parsed.fields);
    Object.assign(values, {
      title: "too long a title",
      count: 99,
      mode: "invalid",
      days: ["wed"],
      accent: "blue",
      city: { name: "", lat: "north", lng: 1, timezone: "" },
      picture: { image: "x", cropbox: [0, 0, 1] },
    });

    const result = validateAndSerializeWidgetFieldValues(parsed.fields, values);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual(expect.arrayContaining([
        "title",
        "count",
        "mode",
        "days",
        "accent",
        "city",
        "picture",
      ]));
    }
  });

  it("preserves typed dropdown option values including empty strings and null", () => {
    const parsed = parseWidgetFieldDefinitions([
      {
        id: "value",
        name: "Value",
        type: "dropdown",
        required: true,
        options: [
          { display: "Empty", value: "" },
          { display: "None", value: null },
        ],
        default: "",
      },
    ]);
    expect(parsed.errors).toEqual([]);
    expect(validateAndSerializeWidgetFieldValues(parsed.fields, { value: "" })).toMatchObject({
      ok: true,
      params: { value: "" },
    });
    expect(validateAndSerializeWidgetFieldValues(parsed.fields, { value: null })).toMatchObject({
      ok: true,
      params: { value: null },
    });
  });

  it("preserves compatible values and resets changed, removed, or invalid values", () => {
    const previous = parseWidgetFieldDefinitions([
      { id: "keep", name: "Keep", type: "text", default: "old" },
      { id: "changed", name: "Changed", type: "number", default: 4 },
      { id: "removed", name: "Removed", type: "toggle", default: true },
      {
        id: "option",
        name: "Option",
        type: "dropdown",
        options: [{ display: "A", value: "a" }],
        default: "a",
      },
    ]).fields;
    const next = parseWidgetFieldDefinitions([
      { id: "keep", name: "Keep", type: "text", default: "new" },
      { id: "changed", name: "Changed", type: "toggle", default: false },
      {
        id: "option",
        name: "Option",
        type: "dropdown",
        options: [{ display: "B", value: "b" }],
        default: "b",
      },
      { id: "added", name: "Added", type: "number", default: 7 },
    ]).fields;

    expect(reconcileWidgetFieldValues(previous, {
      keep: "user",
      changed: 9,
      removed: false,
      option: "a",
    }, next)).toEqual({
      keep: "user",
      changed: false,
      option: "b",
      added: 7,
    });
  });
});
