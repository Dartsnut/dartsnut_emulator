export type WidgetFieldType =
  | "text"
  | "number"
  | "slider"
  | "toggle"
  | "dropdown"
  | "checkbox"
  | "color"
  | "location"
  | "image";

export type WidgetFieldOptionValue = string | number | boolean | null;

export type WidgetFieldOption = {
  display: string;
  value: WidgetFieldOptionValue;
};

export type WidgetLocationValue = {
  name: string;
  lat: string | number;
  lng: string | number;
  timezone: string;
};

export type WidgetImageValue = {
  image: string;
  cropbox: [number, number, number, number];
  image_width?: number;
  image_height?: number;
};

type WidgetFieldBase<T extends WidgetFieldType, D> = {
  id: string;
  name: string;
  type: T;
  desc?: string;
  required: boolean;
  defaultValue: D;
};

export type WidgetTextField = WidgetFieldBase<"text", string> & { max?: number };
export type WidgetNumberField = WidgetFieldBase<"number", number | null> & {
  min?: number;
  max?: number;
  step?: number;
};
export type WidgetSliderField = WidgetFieldBase<"slider", number> & {
  min: number;
  max: number;
  step?: number;
};
export type WidgetToggleField = WidgetFieldBase<"toggle", boolean>;
export type WidgetDropdownField = WidgetFieldBase<"dropdown", WidgetFieldOptionValue | undefined> & {
  options: WidgetFieldOption[];
};
export type WidgetCheckboxField = WidgetFieldBase<"checkbox", WidgetFieldOptionValue[]> & {
  options: WidgetFieldOption[];
};
export type WidgetColorField = WidgetFieldBase<"color", string>;
export type WidgetLocationField = WidgetFieldBase<"location", WidgetLocationValue>;
export type WidgetImageField = WidgetFieldBase<"image", WidgetImageValue> & { accept?: string[] };

export type WidgetFieldDefinition =
  | WidgetTextField
  | WidgetNumberField
  | WidgetSliderField
  | WidgetToggleField
  | WidgetDropdownField
  | WidgetCheckboxField
  | WidgetColorField
  | WidgetLocationField
  | WidgetImageField;

export type WidgetFieldValues = Record<string, unknown>;

export type WidgetFieldParseResult = {
  fields: WidgetFieldDefinition[];
  errors: string[];
};

export type WidgetFieldValidationResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

export type WidgetConfigScope = "workspace" | "emulator";

export type WidgetConfigSnapshot =
  | {
      scope: WidgetConfigScope;
      status: "ready";
      configKey: string;
      confPath: string;
      fields: WidgetFieldDefinition[];
      errors: string[];
    }
  | {
      scope: WidgetConfigScope;
      status: "missing" | "invalid" | "not_widget" | "unavailable";
      configKey: string | null;
      confPath: string | null;
      message: string;
    };

const FIELD_TYPES = new Set<WidgetFieldType>([
  "text",
  "number",
  "slider",
  "toggle",
  "dropdown",
  "checkbox",
  "color",
  "location",
  "image",
]);

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isOptionValue(value: unknown): value is WidgetFieldOptionValue {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function optionValueEquals(left: unknown, right: unknown): boolean {
  return left === right;
}

function parseOptions(raw: unknown, label: string, errors: string[]): WidgetFieldOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${label}: options must be a non-empty array.`);
    return [];
  }
  const options: WidgetFieldOption[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry) || !isOptionValue(entry.value)) {
      errors.push(`${label}: option ${index + 1} must have a JSON scalar value.`);
      return;
    }
    const display = entry.display?.toString().trim() ?? "";
    if (!display) {
      errors.push(`${label}: option ${index + 1} must have a display label.`);
      return;
    }
    if (options.some((option) => optionValueEquals(option.value, entry.value))) {
      errors.push(`${label}: option values must be unique.`);
      return;
    }
    options.push({ display, value: entry.value });
  });
  return options;
}

function parseLocation(value: unknown): WidgetLocationValue | null {
  if (!isRecord(value)) {
    return null;
  }
  const lat = value.lat;
  const lng = value.lng;
  if (lat !== undefined && typeof lat !== "string" && typeof lat !== "number") {
    return null;
  }
  if (lng !== undefined && typeof lng !== "string" && typeof lng !== "number") {
    return null;
  }
  return {
    name: value.name?.toString() ?? "",
    lat: lat ?? "",
    lng: lng ?? "",
    timezone: value.timezone?.toString() ?? "",
  };
}

function parseImage(value: unknown): WidgetImageValue | null {
  if (!isRecord(value)) {
    return null;
  }
  const cropbox = value.cropbox;
  if (!Array.isArray(cropbox) || cropbox.length !== 4) {
    return null;
  }
  const cropValues = cropbox.map(finiteNumber);
  if (cropValues.some((entry) => entry === undefined)) {
    return null;
  }
  const imageWidth = finiteNumber(value.image_width);
  const imageHeight = finiteNumber(value.image_height);
  if ((value.image_width !== undefined && imageWidth === undefined) ||
      (value.image_height !== undefined && imageHeight === undefined)) {
    return null;
  }
  return {
    image: value.image?.toString() ?? "",
    cropbox: cropValues as [number, number, number, number],
    ...(imageWidth === undefined ? {} : { image_width: imageWidth }),
    ...(imageHeight === undefined ? {} : { image_height: imageHeight }),
  };
}

function fieldLabel(raw: Record<string, unknown>, index: number): string {
  const id = raw.id?.toString() ?? raw.field_key?.toString();
  return id?.trim() ? `Field "${id.trim()}"` : `Field ${index + 1}`;
}

export function parseWidgetFieldDefinitions(rawFields: unknown): WidgetFieldParseResult {
  if (!Array.isArray(rawFields)) {
    return { fields: [], errors: ["conf.json fields must be an array."] };
  }

  const fields: WidgetFieldDefinition[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();

  rawFields.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`Field ${index + 1}: definition must be an object.`);
      return;
    }
    const label = fieldLabel(raw, index);
    const id = (raw.id?.toString() ?? raw.field_key?.toString() ?? "").trim();
    const name = (raw.name?.toString() ?? raw.field_name?.toString() ?? id).trim();
    const typeText = (raw.type?.toString() ?? raw.field_type?.toString() ?? "text").trim().toLowerCase();
    if (!id) {
      errors.push(`${label}: id is required.`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`${label}: duplicate id.`);
      return;
    }
    ids.add(id);
    if (!name) {
      errors.push(`${label}: name is required.`);
      return;
    }
    if (!FIELD_TYPES.has(typeText as WidgetFieldType)) {
      errors.push(`${label}: unsupported type "${typeText}".`);
      return;
    }

    const type = typeText as WidgetFieldType;
    const base = {
      id,
      name,
      type,
      ...(raw.desc ?? raw.description
        ? { desc: (raw.desc ?? raw.description)?.toString() }
        : {}),
      required: raw.required === true,
    };

    if (type === "text") {
      const max = raw.max === undefined ? undefined : nonNegativeInteger(raw.max);
      if (raw.max !== undefined && max === undefined) {
        errors.push(`${label}: max must be a non-negative integer.`);
      }
      fields.push({ ...base, type, defaultValue: raw.default?.toString() ?? "", ...(max === undefined ? {} : { max }) });
      return;
    }

    if (type === "number") {
      const min = finiteNumber(raw.min);
      const max = finiteNumber(raw.max);
      const step = finiteNumber(raw.step);
      const defaultValue = raw.default === undefined ? null : finiteNumber(raw.default);
      if (raw.min !== undefined && min === undefined) errors.push(`${label}: min must be numeric.`);
      if (raw.max !== undefined && max === undefined) errors.push(`${label}: max must be numeric.`);
      if (raw.step !== undefined && (step === undefined || step <= 0)) errors.push(`${label}: step must be positive.`);
      if (min !== undefined && max !== undefined && min > max) errors.push(`${label}: min cannot exceed max.`);
      if (raw.default !== undefined && defaultValue === undefined) errors.push(`${label}: default must be numeric.`);
      fields.push({
        ...base,
        type,
        defaultValue: defaultValue ?? null,
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(step === undefined || step <= 0 ? {} : { step }),
      });
      return;
    }

    if (type === "slider") {
      const min = finiteNumber(raw.min) ?? 0;
      const max = finiteNumber(raw.max) ?? 100;
      const step = finiteNumber(raw.step);
      if (raw.min !== undefined && finiteNumber(raw.min) === undefined) errors.push(`${label}: min must be numeric.`);
      if (raw.max !== undefined && finiteNumber(raw.max) === undefined) errors.push(`${label}: max must be numeric.`);
      if (min > max) errors.push(`${label}: min cannot exceed max.`);
      if (raw.step !== undefined && (step === undefined || step <= 0)) errors.push(`${label}: step must be positive.`);
      const parsedDefault = finiteNumber(raw.default);
      if (raw.default !== undefined && parsedDefault === undefined) errors.push(`${label}: default must be numeric.`);
      fields.push({
        ...base,
        type,
        min,
        max,
        defaultValue: Math.min(max, Math.max(min, parsedDefault ?? min)),
        ...(step === undefined || step <= 0 ? {} : { step }),
      });
      return;
    }

    if (type === "toggle") {
      if (raw.default !== undefined && typeof raw.default !== "boolean") {
        errors.push(`${label}: default must be boolean.`);
      }
      fields.push({ ...base, type, defaultValue: raw.default === true });
      return;
    }

    if (type === "dropdown" || type === "checkbox") {
      const options = parseOptions(raw.options, label, errors);
      if (type === "dropdown") {
        const defaultValue = raw.default as unknown;
        if (defaultValue !== undefined && !options.some((option) => optionValueEquals(option.value, defaultValue))) {
          errors.push(`${label}: default must match an option value.`);
        }
        fields.push({
          ...base,
          type,
          options,
          defaultValue: isOptionValue(defaultValue) ? defaultValue : undefined,
        });
      } else {
        const defaultValue = Array.isArray(raw.default) ? raw.default.filter(isOptionValue) : [];
        if (raw.default !== undefined && !Array.isArray(raw.default)) {
          errors.push(`${label}: default must be an array.`);
        }
        if (defaultValue.some((value) => !options.some((option) => optionValueEquals(option.value, value)))) {
          errors.push(`${label}: default values must match option values.`);
        }
        fields.push({ ...base, type, options, defaultValue });
      }
      return;
    }

    if (type === "color") {
      const defaultValue = raw.default?.toString() ?? "#FFFFFF";
      if (!COLOR_PATTERN.test(defaultValue)) {
        errors.push(`${label}: default must use #RRGGBB.`);
      }
      fields.push({ ...base, type, defaultValue });
      return;
    }

    if (type === "location") {
      const defaultValue = parseLocation(raw.default) ?? { name: "", lat: "", lng: "", timezone: "" };
      if (raw.default !== undefined && parseLocation(raw.default) === null) {
        errors.push(`${label}: default must be a location object.`);
      }
      fields.push({ ...base, type, defaultValue });
      return;
    }

    const defaultValue = parseImage(raw.default) ?? { image: "", cropbox: [0, 0, 0, 0] };
    if (raw.default !== undefined && parseImage(raw.default) === null) {
      errors.push(`${label}: default must contain image and a four-number cropbox.`);
    }
    const accept = Array.isArray(raw.accept) ? raw.accept.map(String) : undefined;
    fields.push({ ...base, type: "image", defaultValue, ...(accept ? { accept } : {}) });
  });

  return { fields, errors };
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createDefaultWidgetFieldValues(fields: readonly WidgetFieldDefinition[]): WidgetFieldValues {
  return Object.fromEntries(fields.map((field) => [field.id, cloneValue(field.defaultValue)]));
}

function normalizedNumber(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  return finiteNumber(value) ?? null;
}

function validateFieldValue(field: WidgetFieldDefinition, value: unknown): string | null {
  if (field.type === "text") {
    if (typeof value !== "string") return "Value must be text.";
    if (field.required && !value.trim()) return "This field is required.";
    if (field.max !== undefined && value.length > field.max) return `Maximum length is ${field.max}.`;
    return null;
  }
  if (field.type === "number" || field.type === "slider") {
    const number = normalizedNumber(value);
    if (number === null) return field.required || field.type === "slider" ? "A number is required." : null;
    if (field.min !== undefined && number < field.min) return `Minimum value is ${field.min}.`;
    if (field.max !== undefined && number > field.max) return `Maximum value is ${field.max}.`;
    return null;
  }
  if (field.type === "toggle") {
    return typeof value === "boolean" ? null : "Value must be true or false.";
  }
  if (field.type === "dropdown") {
    if (value === undefined) {
      return field.required ? "Select an option." : null;
    }
    return field.options.some((option) => optionValueEquals(option.value, value))
      ? null
      : "Select a valid option.";
  }
  if (field.type === "checkbox") {
    if (!Array.isArray(value)) return "Value must be a list.";
    if (field.required && value.length === 0) return "Select at least one option.";
    return value.every((entry) => field.options.some((option) => optionValueEquals(option.value, entry)))
      ? null
      : "Select only valid options.";
  }
  if (field.type === "color") {
    if (typeof value !== "string" || !COLOR_PATTERN.test(value)) return "Use a color in #RRGGBB format.";
    return null;
  }
  if (field.type === "location") {
    const location = parseLocation(value);
    if (!location) return "Value must be a location object.";
    if (field.required && !location.name.trim()) return "Location name is required.";
    if (location.lat !== "" && finiteNumber(location.lat) === undefined) return "Latitude must be numeric.";
    if (location.lng !== "" && finiteNumber(location.lng) === undefined) return "Longitude must be numeric.";
    return null;
  }
  const image = parseImage(value);
  if (!image) return "Value must contain an image source and four-number cropbox.";
  if (field.required && !image.image.trim()) return "Image source is required.";
  if ((image.image_width !== undefined && image.image_width <= 0) ||
      (image.image_height !== undefined && image.image_height <= 0)) {
    return "Image dimensions must be positive.";
  }
  return null;
}

function normalizeOutputValue(field: WidgetFieldDefinition, value: unknown): unknown {
  if (field.type === "number" || field.type === "slider") {
    return normalizedNumber(value);
  }
  if (field.type === "location") {
    const location = parseLocation(value)!;
    return {
      ...location,
      lat: location.lat === "" ? "" : finiteNumber(location.lat) ?? location.lat,
      lng: location.lng === "" ? "" : finiteNumber(location.lng) ?? location.lng,
    };
  }
  if (field.type === "image") {
    return parseImage(value)!;
  }
  return cloneValue(value);
}

export function validateAndSerializeWidgetFieldValues(
  fields: readonly WidgetFieldDefinition[],
  values: WidgetFieldValues,
): WidgetFieldValidationResult {
  const errors: Record<string, string> = {};
  const params: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.id];
    const error = validateFieldValue(field, value);
    if (error) {
      errors[field.id] = error;
    } else {
      params[field.id] = normalizeOutputValue(field, value);
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, params };
}

export function reconcileWidgetFieldValues(
  previousFields: readonly WidgetFieldDefinition[],
  previousValues: WidgetFieldValues,
  nextFields: readonly WidgetFieldDefinition[],
): WidgetFieldValues {
  const previousById = new Map(previousFields.map((field) => [field.id, field]));
  const nextValues: WidgetFieldValues = {};
  for (const field of nextFields) {
    const previousField = previousById.get(field.id);
    const previousValue = previousValues[field.id];
    const mergedValue = isRecord(field.defaultValue) && isRecord(previousValue)
      ? { ...field.defaultValue, ...previousValue }
      : previousValue;
    if (previousField?.type !== field.type || previousValue === undefined) {
      nextValues[field.id] = cloneValue(field.defaultValue);
    } else if (validateFieldValue(field, mergedValue) === null) {
      nextValues[field.id] = cloneValue(mergedValue);
    } else {
      nextValues[field.id] = cloneValue(field.defaultValue);
    }
  }
  return nextValues;
}
