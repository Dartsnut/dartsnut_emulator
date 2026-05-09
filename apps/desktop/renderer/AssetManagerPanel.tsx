import { useEffect, useMemo, useRef, useState } from "react";
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
    let cancelled = false;
    void (async () => {
      const updates: Record<string, string | null> = {};
      for (const slot of manifest.slots) {
        const framePath = slot.binding?.frames[0];
        const cacheKey = `${slot.id}:${framePath ?? "none"}`;
        if (!framePath) {
          updates[cacheKey] = null;
          continue;
        }
        if (previewDataUrls[cacheKey] !== undefined) {
          continue;
        }
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
    <div className="asset-manager">
      <header className="asset-manager-header">
        <h2 className="asset-manager-title">Assets</h2>
        <button
          type="button"
          className="asset-manager-apply"
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
        <div className="asset-manager-error" role="alert">
          {describeError({
            slotId: "__apply__",
            code: errors.__apply__.code,
            message: errors.__apply__.message
          })}
        </div>
      ) : null}

      {manifest.slots.length === 0 ? (
        <div className="asset-manager-empty">
          This workspace declares <code>dartsnut.assets.json</code> but has no slots yet.
        </div>
      ) : null}

      <ul className="asset-slot-list">
        {manifest.slots.map((slot) => {
          const error = errors[slot.id];
          const busy = inFlight.slotId === slot.id;
          const pending = pendingSet.has(slot.id);
          const cacheKey = `${slot.id}:${slot.binding?.frames[0] ?? "none"}`;
          const previewSrc = slot.binding ? previewDataUrls[cacheKey] ?? null : null;
          return (
            <li
              key={slot.id}
              className={`asset-slot${busy ? " asset-slot--busy" : ""}${pending ? " asset-slot--pending" : ""}${
                dragOverSlot === slot.id ? " asset-slot--drag-over" : ""
              }`}
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
                className="asset-slot-preview"
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
                    className="asset-slot-preview-img"
                    draggable={false}
                  />
                ) : null}
              </div>
              <div className="asset-slot-meta">
                <div className="asset-slot-id">
                  {slot.id}
                  {pending ? <span className="asset-slot-pending-dot" title="Pending Apply" aria-hidden /> : null}
                </div>
                <div className="asset-slot-description">{slot.description}</div>
                <div className="asset-slot-specs">
                  {formatKindLabel(slot.kind)} · {formatSize(slot)} · {slot.frames} frame{slot.frames === 1 ? "" : "s"}
                </div>
                {error ? (
                  <div className="asset-slot-error" role="alert">
                    {describeError({ slotId: slot.id, code: error.code, message: error.message })}
                  </div>
                ) : null}
              </div>
              <div className="asset-slot-actions">
                <button
                  type="button"
                  className="asset-slot-action"
                  onClick={() => pickFileForSlot(slot.id)}
                  disabled={busy}
                >
                  {slot.binding ? "Replace" : "Choose File"}
                </button>
                {slot.binding ? (
                  <button
                    type="button"
                    className="asset-slot-action asset-slot-action--ghost"
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
                  className="asset-slot-file-input"
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
