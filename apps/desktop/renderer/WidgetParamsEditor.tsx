import type { Dispatch, SetStateAction } from "react";

const emuToolbarBtn =
  "box-border inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[var(--color-emulator-toolbar-border)] bg-[var(--color-emulator-toolbar-bg)] px-3 py-2 text-sm text-[var(--color-emulator-toolbar-label)] enabled:hover:bg-[var(--color-emulator-toolbar-bg-hover)] disabled:cursor-not-allowed disabled:opacity-45";

export type WidgetParamsEditorProps = {
  bridgeReady: boolean;
  widgetParamsText: string;
  setWidgetParamsText: Dispatch<SetStateAction<string>>;
  widgetParamsError: string | null;
  setWidgetParamsError: Dispatch<SetStateAction<string | null>>;
  onFormat: () => void;
  onApplyReload: () => void | Promise<void>;
};

export function WidgetParamsEditor(props: WidgetParamsEditorProps) {
  const {
    bridgeReady,
    widgetParamsText,
    setWidgetParamsText,
    widgetParamsError,
    setWidgetParamsError,
    onFormat,
    onApplyReload,
  } = props;

  return (
    <div className="box-border flex w-auto shrink-0 flex-col gap-2 self-stretch rounded-lg border border-[var(--color-params-border)] bg-[var(--color-params-bg)] px-4 py-3">
      <div className="text-xs text-[var(--color-params-header)]">
        <strong>Widget Params (JSON)</strong>
      </div>
      <textarea
        className="box-border max-h-[200px] min-h-[100px] w-full resize-y rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-2.5 py-2.5 font-mono text-xs leading-snug text-[var(--color-input-text)] [font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] outline-none focus:border-[var(--color-input-focus-border)] focus:shadow-[0_0_0_1px_var(--color-input-focus-border)]"
        value={widgetParamsText}
        onChange={(e) => {
          setWidgetParamsText(e.target.value);
          if (widgetParamsError) {
            setWidgetParamsError(null);
          }
        }}
        spellCheck={false}
        placeholder='{"city":"tokyo"}'
      />
      {widgetParamsError ? (
        <div className="rounded-md border border-[var(--color-params-error-border)] bg-[var(--color-params-error-bg)] px-2 py-1.5 text-xs text-[var(--color-params-error-text)]">
          {widgetParamsError}
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={emuToolbarBtn} disabled={!bridgeReady} onClick={() => onFormat()}>
          Format JSON
        </button>
        <button type="button" className={emuToolbarBtn} disabled={!bridgeReady} onClick={() => void onApplyReload()}>
          Apply Params + Reload
        </button>
      </div>
    </div>
  );
}
