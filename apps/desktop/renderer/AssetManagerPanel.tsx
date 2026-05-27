import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "./cn";
import { getMissingPreviewReads, getPreviewCacheKey } from "./assetPreviewCache";
import type {
  AssetBindError,
  AssetBindErrorCode,
  AssetManifest,
  AssetSlot
} from "@dartsnut/shared-ipc";

interface AssetManagerPanelProps {
  workspacePath: string;
  manifest: AssetManifest | null;
  pendingChangeSlotIds: string[];
  /** Call before invoking apply-assets agent so streamed events are accepted after session reset. */
  onAllowAgentIngress?: () => void;
}

interface InFlightState {
  slotId: string | null;
  applying: boolean;
}

interface SlotErrorState {
  slotId: string;
  code: AssetBindErrorCode;
  message: string;
}

const ERROR_COPY: Record<AssetBindErrorCode, string> = {
  manifest_missing: "Manifest is missing for this workspace.",
  slot_not_found: "Slot is not declared in the manifest. Has it been removed?",
  unreadable_image: "That file isn't a readable image. PNGs and GIFs only.",
  dimension_mismatch: "Image dimensions don't match the slot.",
  frame_count_mismatch: "Frame count in the source doesn't match the slot.",
  pillow_unavailable: "Pillow (Python imaging library) isn't available — bind failed.",
  io_error: "I/O failure while writing assets.",
  preprocessor_crashed: "The preprocessor crashed. Check logs for details."
};

function describeError(error: AssetBindError): string {
  const base = ERROR_COPY[error.code] ?? "Unknown error.";
  if (error.message && error.message !== base) {
    return `${base} (${error.message})`;
  }
  return base;
}

function rgbCss(color: [number, number, number] | undefined): string {
  if (!color) {
    return "rgb(80, 80, 80)";
  }
  const [r, g, b] = color;
  return `rgb(${r}, ${g}, ${b})`;
}

function formatSize(slot: AssetSlot): string {
  return `${slot.size[0]}×${slot.size[1]}`;
}

function formatKindLabel(kind: AssetSlot["kind"]): string {
  if (kind === "static") return "static";
  if (kind === "gif") return "gif";
  return "spritesheet";
}

export function AssetManagerPanel({
  workspacePath,
  manifest,
  pendingChangeSlotIds,
  onAllowAgentIngress
}: AssetManagerPanelProps) {
  const api = window.dartsnutApi;
  const [inFlight, setInFlight] = useState<InFlightState>({ slotId: null, applying: false });
  const [errors, setErrors] = useState<Record<string, SlotErrorState>>({});
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);
  const [previewDataUrls, setPreviewDataUrls] = useState<Record<string, string | null>>({});
  const fileInputsRef = useRef<Record<string, HTMLInputElement | null>>({});

  // Reload preview thumbnails as data URLs whenever a slot's first frame changes.
  // file:// URLs are blocked by Electron's renderer security model, so the main
  // process reads the bytes and returns a base64 data URL via IPC.
  useEffect(() => {
    if (!manifest || !workspacePath || !api?.assets?.readPreview) {
      return;
    }
    const readPlan = getMissingPreviewReads(manifest, previewDataUrls);
    if (readPlan.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const updates: Record<string, string | null> = {};
      for (const { cacheKey, framePath } of readPlan) {
        const result = await api.assets.readPreview({ workspacePath, framePath });
        if (cancelled) {
          return;
        }
        updates[cacheKey] = result.ok ? result.dataUrl : null;
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setPreviewDataUrls((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manifest, workspacePath, api, previewDataUrls]);

  const pendingSet = useMemo(() => new Set(pendingChangeSlotIds), [pendingChangeSlotIds]);
  const hasPendingChanges = pendingChangeSlotIds.length > 0;

  if (!manifest) {
    return null;
  }

  async function handleBindFromPath(slotId: string, sourcePath: string) {
    if (!api?.assets || !workspacePath) {
      return;
    }
    setErrors((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
    setInFlight({ slotId, applying: false });
    try {
      const result = await api.assets.bindSlot({ workspacePath, slotId, sourcePath });
      if (!result.ok) {
        setErrors((prev) => ({
          ...prev,
          [slotId]: { slotId, code: result.error.code, message: result.error.message }
        }));
      }
    } finally {
      setInFlight({ slotId: null, applying: false });
    }
  }

  async function handleUnbind(slotId: string) {
    if (!api?.assets || !workspacePath) {
      return;
    }
    setErrors((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
    const result = await api.assets.unbindSlot({ workspacePath, slotId, removeOutputs: true });
    if (!result.ok) {
      setErrors((prev) => ({
        ...prev,
        [slotId]: { slotId, code: result.error.code, message: result.error.message }
      }));
    }
  }

  async function handleApplyAssets() {
    if (!api?.assets || !workspacePath || !hasPendingChanges) {
      return;
    }
    onAllowAgentIngress?.();
    setInFlight((prev) => ({ ...prev, applying: true }));
    try {
      const result = await api.assets.applyAssets({ workspacePath });
      if (!result.ok && result.message) {
        setErrors((prev) => ({
          ...prev,
          __apply__: {
            slotId: "__apply__",
            code: "preprocessor_crashed",
            message: result.message ?? "apply failed"
          }
        }));
      }
    } finally {
      setInFlight((prev) => ({ ...prev, applying: false }));
    }
  }

  function pickFileForSlot(slotId: string) {
    const input = fileInputsRef.current[slotId];
    if (input) {
      input.value = "";
      input.click();
    }
  }

  function resolveFilePath(file: File): string | null {
    if (!api?.assets?.getPathForFile) {
      return null;
    }
    try {
      const filePath = api.assets.getPathForFile(file);
      return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
    } catch {
      return null;
    }
  }

  function getDroppedFilePath(dataTransfer: DataTransfer): string | null {
    const file = dataTransfer.files[0];
    if (!file) {
      return null;
    }
    return resolveFilePath(file);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-semibold tracking-wide text-[var(--color-tab-active-text)]">Assets</h2>
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-[var(--color-accent-purple)] bg-[var(--color-accent-purple)] px-3.5 py-2 text-xs font-semibold tracking-wide text-[var(--color-badge-text)] [font:inherit] hover:enabled:brightness-110 disabled:cursor-not-allowed disabled:border-[var(--color-border-dashed)] disabled:bg-[var(--color-accent-btn-disabled-bg)] disabled:text-[var(--color-text-subtle)] disabled:opacity-100"
          onClick={() => void handleApplyAssets()}
          disabled={!hasPendingChanges || inFlight.applying}
          title={
            hasPendingChanges
              ? "Run the agent to wire bound assets into the project"
              : "Bind or unbind a slot first to enable Apply"
          }
        >
          {inFlight.applying ? "Applying…" : `Apply Assets${hasPendingChanges ? ` (${pendingChangeSlotIds.length})` : ""}`}
        </button>
      </header>

      {errors.__apply__ ? (
        <div
          className="rounded-lg border border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-3 py-2 text-xs text-[var(--color-error-text)]"
          role="alert"
        >
          {describeError({
            slotId: "__apply__",
            code: errors.__apply__.code,
            message: errors.__apply__.message
          })}
        </div>
      ) : null}

      {manifest.slots.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-[var(--color-border-dashed)] p-3.5 text-[13px] text-[var(--color-text-subtle)]">
          This workspace declares <code>dartsnut.assets.json</code> but has no slots yet.
        </div>
      ) : null}

      <ul className="m-0 flex min-h-0 list-none flex-col gap-2.5 overflow-y-auto p-0">
        {manifest.slots.map((slot) => {
          const error = errors[slot.id];
          const busy = inFlight.slotId === slot.id;
          const pending = pendingSet.has(slot.id);
          const cacheKey = getPreviewCacheKey(slot.id, slot.binding?.frames[0]);
          const previewSrc = slot.binding ? previewDataUrls[cacheKey] ?? null : null;
          return (
            <li
              key={slot.id}
              className={cn(
                "grid grid-cols-[60px_1fr_auto] items-center gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2.5 transition-[border-color,background] duration-100 ease-out",
                busy && "opacity-70",
                pending && "border-[var(--color-border-accent-soft)]",
                dragOverSlot === slot.id && "border-[var(--color-border-accent)] bg-[var(--color-surface-elevated-hover)]"
              )}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDragOverSlot(slot.id);
              }}
              onDragLeave={() => {
                setDragOverSlot((current) => (current === slot.id ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragOverSlot(null);
                const filePath = getDroppedFilePath(event.dataTransfer);
                if (filePath) {
                  void handleBindFromPath(slot.id, filePath);
                }
              }}
            >
              <div
                className="flex size-[60px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] [image-rendering:pixelated]"
                style={
                  slot.binding
                    ? { backgroundColor: "transparent" }
                    : { backgroundColor: rgbCss(slot.placeholder.color) }
                }
              >
                {previewSrc ? (
                  <img
                    src={previewSrc}
                    alt={`${slot.id} preview`}
                    className="max-h-full max-w-full [image-rendering:pixelated]"
                    draggable={false}
                  />
                ) : null}
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--color-tab-active-text)]">
                  {slot.id}
                  {pending ? (
                    <span
                      className="inline-block size-2 rounded-full bg-[var(--color-accent-purple)]"
                      title="Pending Apply"
                      aria-hidden
                    />
                  ) : null}
                </div>
                <div className="truncate text-xs text-[var(--color-text-subtle)]">{slot.description}</div>
                <div className="text-[11.5px] uppercase tracking-wide text-[var(--color-text-hint)]">
                  {formatKindLabel(slot.kind)} · {formatSize(slot)} · {slot.frames} frame{slot.frames === 1 ? "" : "s"}
                </div>
                {error ? (
                  <div
                    className="mt-1 rounded-md bg-[var(--color-error-soft-bg)] px-2 py-1.5 text-xs text-[var(--color-error-text)]"
                    role="alert"
                  >
                    {describeError({ slotId: slot.id, code: error.code, message: error.message })}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-col items-stretch gap-1.5">
                <button
                  type="button"
                  className="cursor-pointer whitespace-nowrap rounded-md border border-[var(--color-border-dashed)] bg-[var(--color-slot-action-bg)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-slot-action-text)] [font:inherit] hover:enabled:bg-[var(--color-slot-action-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => pickFileForSlot(slot.id)}
                  disabled={busy}
                >
                  {slot.binding ? "Replace" : "Choose File"}
                </button>
                {slot.binding ? (
                  <button
                    type="button"
                    className="cursor-pointer whitespace-nowrap rounded-md border border-[var(--color-border-dashed)] bg-transparent px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-subtle)] [font:inherit] hover:enabled:bg-[var(--color-slot-action-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleUnbind(slot.id)}
                    disabled={busy}
                  >
                    Unbind
                  </button>
                ) : null}
                <input
                  ref={(node) => {
                    fileInputsRef.current[slot.id] = node;
                  }}
                  type="file"
                  accept={slot.kind === "gif" ? "image/gif" : "image/png"}
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) {
                      return;
                    }
                    const filePath = resolveFilePath(file);
                    if (filePath) {
                      void handleBindFromPath(slot.id, filePath);
                      return;
                    }
                    setErrors((prev) => ({
                      ...prev,
                      [slot.id]: {
                        slotId: slot.id,
                        code: "io_error",
                        message: "Could not resolve the absolute path of the chosen file."
                      }
                    }));
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
