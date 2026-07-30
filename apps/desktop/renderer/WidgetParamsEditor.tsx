import type {
  WidgetConfigSnapshot,
  WidgetFieldDefinition,
  WidgetFieldOptionValue,
  WidgetFieldValues,
  WidgetImageValue,
  WidgetLocationValue,
} from "@dartsnut/shared-ipc";
import { createDefaultWidgetFieldValues } from "@dartsnut/shared-ipc";
import type { ReactNode } from "react";
import { resolveWidgetParams, valuesForWidgetConfig, type WidgetValueStore } from "./widgetParams";

const emuToolbarBtn = "ui-toolbar-btn";

export type WidgetParamsEditorProps = {
  bridgeReady: boolean;
  config: WidgetConfigSnapshot;
  store: WidgetValueStore;
  onValuesChange: (configKey: string, values: WidgetFieldValues) => void;
  onApplyReload: () => void | Promise<void>;
};

function optionKey(value: WidgetFieldOptionValue): string {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function inputNumber(value: unknown): string | number {
  return typeof value === "number" || typeof value === "string" ? value : "";
}

const compactInput = "ui-input widget-param-input w-full";

function FieldControl({
  field,
  value,
  error,
  onChange,
}: {
  field: WidgetFieldDefinition;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  let control: ReactNode;
  if (field.type === "text") {
    control = (
      <input
        className={compactInput}
        type="text"
        value={typeof value === "string" ? value : ""}
        maxLength={field.max}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else if (field.type === "number") {
    control = (
      <input
        className={compactInput}
        type="number"
        value={inputNumber(value)}
        min={field.min}
        max={field.max}
        step={field.step ?? "any"}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else if (field.type === "slider") {
    const sliderValue = typeof value === "number" ? value : field.defaultValue;
    control = (
      <div className="flex items-center gap-2">
        <input
          className="min-w-0 flex-1 accent-[var(--color-accent)]"
          type="range"
          value={sliderValue}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output className="min-w-9 text-right font-mono text-[11px] text-fg-muted">{sliderValue}</output>
      </div>
    );
  } else if (field.type === "toggle") {
    control = (
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          checked={value === true}
          className="h-4 w-4 accent-[var(--color-accent)]"
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{value === true ? "On" : "Off"}</span>
      </label>
    );
  } else if (field.type === "dropdown") {
    const selectedIndex = field.options.findIndex((option) => option.value === value);
    control = (
      <select
        className={compactInput}
        value={selectedIndex < 0 ? "" : String(selectedIndex)}
        onChange={(event) => onChange(event.target.value === "" ? undefined : field.options[Number(event.target.value)].value)}
      >
        <option value="">Select…</option>
        {field.options.map((option, index) => (
          <option key={optionKey(option.value)} value={index}>{option.display}</option>
        ))}
      </select>
    );
  } else if (field.type === "checkbox") {
    const selected = Array.isArray(value) ? value : [];
    control = (
      <div className="flex flex-wrap gap-1.5">
        {field.options.map((option) => {
          const checked = selected.some((entry) => entry === option.value);
          return (
            <label
              key={optionKey(option.value)}
              className="inline-flex cursor-pointer items-center gap-1 rounded border border-edge bg-[var(--color-surface-elevated)] px-1.5 py-1 text-[11px]"
            >
              <input
                type="checkbox"
                checked={checked}
                className="accent-[var(--color-accent)]"
                onChange={(event) => onChange(event.target.checked
                  ? [...selected, option.value]
                  : selected.filter((entry) => entry !== option.value))}
              />
              {option.display}
            </label>
          );
        })}
      </div>
    );
  } else if (field.type === "color") {
    const text = typeof value === "string" ? value : "";
    control = (
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(text) ? text : "#FFFFFF"}
          className="h-8 w-10 cursor-pointer rounded border border-edge bg-transparent p-1"
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
        <input
          className="ui-input widget-param-input min-w-0 flex-1 font-mono"
          type="text"
          value={text}
          placeholder="#RRGGBB"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  } else if (field.type === "location") {
    const location = (value && typeof value === "object" ? value : field.defaultValue) as WidgetLocationValue;
    const update = (key: keyof WidgetLocationValue, next: string) => onChange({ ...location, [key]: next });
    control = (
      <div className="grid grid-cols-2 gap-1.5">
        <input className={compactInput} value={location.name} placeholder="Location" onChange={(event) => update("name", event.target.value)} />
        <input className={compactInput} value={location.timezone} placeholder="Timezone" onChange={(event) => update("timezone", event.target.value)} />
        <input className={compactInput} value={location.lat} placeholder="Latitude" inputMode="decimal" onChange={(event) => update("lat", event.target.value)} />
        <input className={compactInput} value={location.lng} placeholder="Longitude" inputMode="decimal" onChange={(event) => update("lng", event.target.value)} />
      </div>
    );
  } else {
    const image = (value && typeof value === "object" ? value : field.defaultValue) as WidgetImageValue;
    const update = (next: Partial<WidgetImageValue>) => onChange({ ...image, ...next });
    const updateCrop = (index: number, next: string) => {
      const cropbox = [...image.cropbox] as WidgetImageValue["cropbox"];
      cropbox[index] = Number(next);
      update({ cropbox });
    };
    control = (
      <div className="flex flex-col gap-1.5">
        <input className={compactInput} value={image.image} placeholder="Image URL or file path" onChange={(event) => update({ image: event.target.value })} />
        <div className="grid grid-cols-4 gap-1.5">
          {image.cropbox.map((entry, index) => (
            <input key={index} className="ui-input widget-param-input min-w-0" type="number" value={entry} aria-label={`Crop ${index + 1}`} onChange={(event) => updateCrop(index, event.target.value)} />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <input className={compactInput} type="number" min="1" value={image.image_width ?? ""} placeholder="Source width" onChange={(event) => update({ image_width: event.target.value ? Number(event.target.value) : undefined })} />
          <input className={compactInput} type="number" min="1" value={image.image_height ?? ""} placeholder="Source height" onChange={(event) => update({ image_height: event.target.value ? Number(event.target.value) : undefined })} />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(96px,0.75fr)_minmax(0,1.7fr)] items-center gap-x-2.5 gap-y-1 border-b border-edge px-0.5 py-1.5 last:border-b-0">
      <div className="min-w-0 self-center">
        <label className="block truncate text-xs font-semibold text-fg-strong" title={field.name}>
          {field.name}{field.required ? <span className="text-[var(--color-error-text)]"> *</span> : null}
        </label>
        {field.desc ? (
          <div className="truncate text-[10px] leading-4 text-fg-muted" title={field.desc}>{field.desc}</div>
        ) : null}
      </div>
      <div className="min-w-0">{control}</div>
      {error ? <div className="col-start-2 text-[10px] text-[var(--color-error-text)]">{error}</div> : null}
    </div>
  );
}

export function WidgetParamsEditor({
  bridgeReady,
  config,
  store,
  onValuesChange,
  onApplyReload,
}: WidgetParamsEditorProps) {
  const resolved = resolveWidgetParams(config, store);
  const values = valuesForWidgetConfig(config, store);
  const fields = config.status === "ready" ? config.fields : [];

  function setFieldValue(id: string, value: unknown) {
    if (config.status === "ready") {
      onValuesChange(config.configKey, { ...values, [id]: value });
    }
  }

  function restoreDefaults() {
    if (config.status === "ready") {
      onValuesChange(config.configKey, createDefaultWidgetFieldValues(config.fields));
    }
  }

  return (
    <div className="box-border flex w-auto shrink-0 flex-col gap-1.5 self-stretch rounded-[var(--radius-lg)] border border-[var(--color-params-border)] bg-[var(--color-params-bg)] px-2.5 py-2 shadow-[var(--shadow-sm)]">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <div className="ui-panel-title text-xs">Widget params</div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={`${emuToolbarBtn} [padding:5px_9px] !text-xs`}
            disabled={config.status !== "ready"}
            onClick={restoreDefaults}
          >
            Defaults
          </button>
          <button
            type="button"
            className={`${emuToolbarBtn} [padding:5px_9px] !text-xs`}
            disabled={!bridgeReady || !resolved.ok}
            onClick={() => void onApplyReload()}
          >
            Apply
          </button>
        </div>
      </div>
      {config.status !== "ready" ? (
        <div className="rounded-md border border-[var(--color-params-error-border)] bg-[var(--color-params-error-bg)] px-2 py-1.5 text-xs text-[var(--color-params-error-text)]">
          {config.message}
        </div>
      ) : config.errors.length > 0 ? (
        <div className="rounded-md border border-[var(--color-params-error-border)] bg-[var(--color-params-error-bg)] px-2 py-1.5 text-xs text-[var(--color-params-error-text)]">
          {config.errors.map((error) => <div key={error}>{error}</div>)}
        </div>
      ) : fields.length === 0 ? (
        <div className="text-xs text-fg-muted">No configurable fields.</div>
      ) : (
        <div className="widget-param-fields flex flex-col overflow-auto pr-1">
          {fields.map((field) => (
            <FieldControl
              key={field.id}
              field={field}
              value={values[field.id]}
              error={!resolved.ok ? resolved.fieldErrors[field.id] : undefined}
              onChange={(value) => setFieldValue(field.id, value)}
            />
          ))}
        </div>
      )}
      {!resolved.ok && config.status === "ready" && config.errors.length === 0 ? (
        <div className="text-xs text-[var(--color-error-text)]">{resolved.message}</div>
      ) : null}
    </div>
  );
}
