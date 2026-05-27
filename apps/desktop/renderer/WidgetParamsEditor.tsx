import type { Dispatch, SetStateAction } from "react";

const emuToolbarBtn = "ui-toolbar-btn";

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
    <div className="box-border flex w-auto shrink-0 flex-col gap-2.5 self-stretch rounded-[var(--radius-lg)] border border-[var(--color-params-border)] bg-[var(--color-params-bg)] px-4 py-3 shadow-[var(--shadow-sm)]">
      <div className="ui-panel-title text-[13px]">Widget params</div>
      <textarea
        className="ui-input box-border max-h-[200px] min-h-[100px] w-full resize-y font-mono text-xs leading-snug"
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
