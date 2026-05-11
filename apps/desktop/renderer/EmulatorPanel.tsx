import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { EmulatorFrame, EmulatorLogEntry, EmulatorStateSnapshot } from "@dartsnut/emulator-protocol";
import { cn } from "./cn";

type DartCoord = { x: number; y: number } | null;
type UiEmulatorLogEntry = EmulatorLogEntry & { id: string };

const defaultState: EmulatorStateSnapshot = {
  widgetPath: null,
  running: false,
  fps: 0,
  status: "Idle",
};

const DART_COLORS = Array.from({ length: 12 }, (_, idx) => {
  const cycle = idx % 4;
  if (cycle === 0) return "#003cff";
  if (cycle === 1) return "#ff0000";
  if (cycle === 2) return "#00ff00";
  return "#ffd800";
});

const emuToolbarBtn =
  "box-border inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[var(--color-emulator-toolbar-border)] bg-[var(--color-emulator-toolbar-bg)] px-3 py-2 text-sm text-[var(--color-emulator-toolbar-label)]";

const emuToolbarIconBtn = cn(emuToolbarBtn, "size-7 p-0");

export function EmulatorPanel() {
  const CANVAS_BASE_WIDTH = 588;
  const CANVAS_BASE_HEIGHT = 800;
  const bridgeReady = Boolean(window.dartsnutApi?.sendEmulatorCommand);
  const [state, setState] = useState<EmulatorStateSnapshot>(defaultState);
  const [widgetPath, setWidgetPath] = useState("");
  const [widgetParamsText, setWidgetParamsText] = useState("{}");
  const [widgetParamsError, setWidgetParamsError] = useState<string | null>(null);
  const [selectedDartIndex, setSelectedDartIndex] = useState(0);
  const [dartCoords, setDartCoords] = useState<DartCoord[]>(Array.from({ length: 12 }, () => null));
  const [captureFps, setCaptureFps] = useState(0);
  const [renderFps, setRenderFps] = useState(0);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsPaused, setLogsPaused] = useState(false);
  const [emulatorLogs, setEmulatorLogs] = useState<UiEmulatorLogEntry[]>([]);
  const [captureToast, setCaptureToast] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const logsBodyRef = useRef<HTMLDivElement | null>(null);
  const frameWorkerRef = useRef<Worker | null>(null);
  const workerBusyRef = useRef(false);
  const pendingFrameRef = useRef<EmulatorFrame | null>(null);
  const latestFrameMetaRef = useRef<{ width: number; height: number } | null>(null);
  const gridOverlayCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const captureTimesRef = useRef<number[]>([]);
  const renderTimesRef = useRef<number[]>([]);
  const lastMetricsUpdateMsRef = useRef(0);
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const currentDartIndexRef = useRef<number>(0);
  const lastRightClickMsRef = useRef<number>(0);
  const zoomOpenRef = useRef(false);
  const captureToastTimerRef = useRef<number | null>(null);
  const normalizedWidgetType = state.widgetType?.toLowerCase() ?? null;
  const hasResolvedWorkspaceType = Boolean(state.widgetPath && normalizedWidgetType);
  const showParamsPanel = hasResolvedWorkspaceType && normalizedWidgetType === "widget";
  const showDartLegend = hasResolvedWorkspaceType && normalizedWidgetType === "game";
  const projectKindLabel =
    normalizedWidgetType === "widget" ? "Widget" : normalizedWidgetType === "game" ? "Game" : "Unknown";

  useEffect(() => {
    zoomOpenRef.current = zoomOpen;
  }, [zoomOpen]);

  useEffect(() => {
    const body = logsBodyRef.current;
    if (!logsOpen || logsPaused || !body) {
      return;
    }
    body.scrollTop = body.scrollHeight;
  }, [emulatorLogs, logsOpen, logsPaused]);

  useEffect(() => {
    return () => {
      if (captureToastTimerRef.current !== null) {
        window.clearTimeout(captureToastTimerRef.current);
      }
    };
  }, []);

  /** Pixels match `drawFrameToCanvas` placement so the LCD area is black after reset. */
  function fillEmulatorScreenBlack(
    ctx: CanvasRenderingContext2D,
    frame: { width: number; height: number } | null,
    scaleMultiplier: number,
  ) {
    const sx = scaleMultiplier;
    ctx.fillStyle = "#000000";
    if (!frame) {
      ctx.fillRect(38 * sx, 38 * sx, 512 * sx, 512 * sx);
      ctx.fillRect(123 * sx, 601 * sx, 342 * sx, 176 * sx);
      return;
    }
    if (frame.width === 128 && frame.height === 160) {
      ctx.fillRect(38 * sx, 38 * sx, 512 * sx, 512 * sx);
      ctx.fillRect(123 * sx, 601 * sx, 342 * sx, 176 * sx);
    } else if (frame.width === 64 && frame.height === 32) {
      ctx.fillRect(123 * sx, 601 * sx, 342 * sx, 176 * sx);
    } else if (frame.width === 128 && frame.height === 128) {
      ctx.fillRect(38 * sx, 38 * sx, 512 * sx, 512 * sx);
    } else {
      ctx.fillRect(38 * sx, 38 * sx, 512 * sx, 512 * sx);
    }
  }

  function drawBackgroundOnly(
    canvas: HTMLCanvasElement | null,
    frameMeta: { width: number; height: number } | null = null,
    scaleMultiplier = 1,
  ) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (backgroundRef.current) {
      ctx.drawImage(backgroundRef.current, 0, 0, canvas.width, canvas.height);
    }
    fillEmulatorScreenBlack(ctx, frameMeta, scaleMultiplier);
  }

  /** Clear last frame and pending work so the preview does not show a stale capture after stop. */
  function wipePreviewCanvas() {
    const meta = latestFrameMetaRef.current;
    pendingFrameRef.current = null;
    latestFrameMetaRef.current = null;
    workerBusyRef.current = false;
    setDartCoords(Array.from({ length: 12 }, () => null));
    drawBackgroundOnly(canvasRef.current, meta, 1);
    drawBackgroundOnly(zoomCanvasRef.current, meta, 2);
  }

  function getGridOverlay(frameWidth: number, frameHeight: number, scaleMultiplier: number) {
    const key = `${frameWidth}x${frameHeight}@${scaleMultiplier}`;
    const cached = gridOverlayCacheRef.current.get(key);
    if (cached) return cached;

    const overlay = document.createElement("canvas");
    overlay.width = CANVAS_BASE_WIDTH * scaleMultiplier;
    overlay.height = CANVAS_BASE_HEIGHT * scaleMultiplier;
    const g = overlay.getContext("2d");
    if (!g) return null;
    g.clearRect(0, 0, overlay.width, overlay.height);
    g.fillStyle = "rgba(0, 0, 0, 0.20)";

    const mainX = 38 * scaleMultiplier;
    const mainY = 38 * scaleMultiplier;
    const mainStep = 4 * scaleMultiplier;
    const mainSize = 512 * scaleMultiplier;
    for (let i = 0; i <= 128; i += 1) {
      const x = mainX + i * mainStep;
      const y = mainY + i * mainStep;
      g.fillRect(x, mainY, 1, mainSize);
      g.fillRect(mainX, y, mainSize, 1);
    }

    if ((frameWidth === 128 && frameHeight === 160) || (frameWidth === 64 && frameHeight === 32)) {
      const secX = 123 * scaleMultiplier;
      const secY = 601 * scaleMultiplier;
      const secW = 342 * scaleMultiplier;
      const secH = 176 * scaleMultiplier;
      const stepX = secW / 64;
      const stepY = secH / 32;
      for (let i = 0; i <= 64; i += 1) {
        const x = Math.round(secX + i * stepX);
        g.fillRect(x, secY, 1, secH);
      }
      for (let i = 0; i <= 32; i += 1) {
        const y = Math.round(secY + i * stepY);
        g.fillRect(secX, y, secW, 1);
      }
    }
    gridOverlayCacheRef.current.set(key, overlay);
    return overlay;
  }

  function drawFrameToCanvas(
    canvas: HTMLCanvasElement | null,
    bitmap: ImageBitmap,
    frame: { width: number; height: number },
    scaleMultiplier = 1,
  ) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sx = scaleMultiplier;
    if (frame.width === 128 && frame.height === 160) {
      ctx.drawImage(bitmap, 0, 0, 128, 128, 38 * sx, 38 * sx, 512 * sx, 512 * sx);
      ctx.drawImage(bitmap, 0, 128, 64, 32, 123 * sx, 601 * sx, 342 * sx, 176 * sx);
    } else if (frame.width === 64 && frame.height === 32) {
      ctx.drawImage(bitmap, 0, 0, 64, 32, 123 * sx, 601 * sx, 342 * sx, 176 * sx);
    } else if (frame.width === 128 && frame.height === 128) {
      ctx.drawImage(bitmap, 0, 0, 128, 128, 38 * sx, 38 * sx, 512 * sx, 512 * sx);
    } else {
      ctx.drawImage(bitmap, 0, 0, frame.width, frame.height, 38 * sx, 38 * sx, 512 * sx, 512 * sx);
    }
    const overlay = getGridOverlay(frame.width, frame.height, scaleMultiplier);
    if (overlay) {
      ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    }
    if (backgroundRef.current) {
      ctx.drawImage(backgroundRef.current, 0, 0, canvas.width, canvas.height);
    }
  }

  function updateNormalizedFps(nowMs: number) {
    const floor = nowMs - 1000;
    captureTimesRef.current = captureTimesRef.current.filter((ts) => ts >= floor);
    renderTimesRef.current = renderTimesRef.current.filter((ts) => ts >= floor);
    if (nowMs - lastMetricsUpdateMsRef.current >= 250) {
      setCaptureFps(captureTimesRef.current.length);
      setRenderFps(renderTimesRef.current.length);
      lastMetricsUpdateMsRef.current = nowMs;
    }
  }

  useEffect(() => {
    frameWorkerRef.current = new Worker(new URL("./frameWorker.ts", import.meta.url), { type: "module" });
    frameWorkerRef.current.onmessage = (event: MessageEvent) => {
      const payload = event.data as { bitmap: ImageBitmap; width: number; height: number };
      latestFrameMetaRef.current = { width: payload.width, height: payload.height };
      drawFrameToCanvas(canvasRef.current, payload.bitmap, { width: payload.width, height: payload.height }, 1);
      if (zoomOpenRef.current) {
        drawFrameToCanvas(
          zoomCanvasRef.current,
          payload.bitmap,
          { width: payload.width, height: payload.height },
          2,
        );
      }
      payload.bitmap.close();
      const now = performance.now();
      renderTimesRef.current.push(now);
      updateNormalizedFps(now);
      workerBusyRef.current = false;
      const pending = pendingFrameRef.current;
      if (pending && frameWorkerRef.current) {
        pendingFrameRef.current = null;
        workerBusyRef.current = true;
        frameWorkerRef.current.postMessage(pending);
      }
    };

    void (async () => {
      const bg = await window.dartsnutApi.getEmulatorBackground();
      if (bg?.url) {
        const img = new Image();
        img.src = bg.url;
        img.onload = () => {
          backgroundRef.current = img;
          const meta = latestFrameMetaRef.current;
          drawBackgroundOnly(canvasRef.current, meta, 1);
          if (zoomOpenRef.current) {
            drawBackgroundOnly(zoomCanvasRef.current, meta, 2);
          }
        };
      } else {
        drawBackgroundOnly(canvasRef.current, latestFrameMetaRef.current, 1);
      }
    })();

    const stopState = window.dartsnutApi.onEmulatorState((nextState) => {
      setState(nextState);
      if (!nextState.running && nextState.widgetPath == null) {
        wipePreviewCanvas();
      }
      if (typeof nextState.status === "string" && nextState.status.startsWith("Screenshot captured: ")) {
        setCaptureToast(nextState.status);
        if (captureToastTimerRef.current !== null) {
          window.clearTimeout(captureToastTimerRef.current);
        }
        captureToastTimerRef.current = window.setTimeout(() => {
          setCaptureToast(null);
          captureToastTimerRef.current = null;
        }, 3500);
      }
    });

    const stopFrame = window.dartsnutApi.onEmulatorFrame((frame: EmulatorFrame) => {
      const now = performance.now();
      captureTimesRef.current.push(now);
      updateNormalizedFps(now);
      if (!frameWorkerRef.current) return;
      if (workerBusyRef.current) {
        pendingFrameRef.current = frame;
        return;
      }
      workerBusyRef.current = true;
      frameWorkerRef.current.postMessage(frame);
    });

    const stopLog = window.dartsnutApi.onEmulatorLog((entry: EmulatorLogEntry) => {
      if (logsPaused) return;
      const logEntry: UiEmulatorLogEntry = {
        ...entry,
        id: `${entry.timestampMs}-${Math.random().toString(16).slice(2, 8)}`,
      };
      setEmulatorLogs((prev) => {
        const next = [...prev, logEntry];
        return next.length > 800 ? next.slice(next.length - 800) : next;
      });
    });

    return () => {
      stopState();
      stopFrame();
      stopLog();
      frameWorkerRef.current?.terminate();
      frameWorkerRef.current = null;
    };
  }, [logsPaused]);

  useEffect(() => {
    return window.dartsnutApi.onSessionReset(() => {
      setEmulatorLogs([]);
      wipePreviewCanvas();
    });
  }, []);

  useEffect(() => {
    if (!zoomOpen) return;
    const latest = latestFrameMetaRef.current;
    if (latest) {
      const canvas = zoomCanvasRef.current;
      if (canvas && canvasRef.current) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(canvasRef.current, 0, 0, canvas.width, canvas.height);
          const overlay = getGridOverlay(latest.width, latest.height, 2);
          if (overlay) {
            ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
          }
        }
      }
    } else {
      drawBackgroundOnly(zoomCanvasRef.current, null, 2);
    }
  }, [zoomOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      const buttonMap: Record<string, "A" | "B" | "UP" | "DOWN" | "LEFT" | "RIGHT"> = {
        k: "A",
        l: "B",
        w: "UP",
        s: "DOWN",
        a: "LEFT",
        d: "RIGHT",
      };
      if (buttonMap[key]) {
        void window.dartsnutApi.sendEmulatorCommand({
          type: "set_button",
          button: buttonMap[key],
          pressed: true,
        });
      }
      if (/^f([1-9]|1[0-2])$/i.test(event.key)) {
        const idx = Number(event.key.slice(1)) - 1;
        if (idx >= 0 && idx < 12) {
          currentDartIndexRef.current = idx;
          setSelectedDartIndex(idx);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const key = event.key.toLowerCase();
      const buttonMap: Record<string, "A" | "B" | "UP" | "DOWN" | "LEFT" | "RIGHT"> = {
        k: "A",
        l: "B",
        w: "UP",
        s: "DOWN",
        a: "LEFT",
        d: "RIGHT",
      };
      if (buttonMap[key]) {
        void window.dartsnutApi.sendEmulatorCommand({
          type: "set_button",
          button: buttonMap[key],
          pressed: false,
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await window.dartsnutApi.getLastWidgetPath();
      if (response?.path) {
        setWidgetPath(response.path);
      }
    })();
  }, []);

  async function applyWidgetPathAndReload(nextPath: string) {
    setEmulatorLogs([]);
    await window.dartsnutApi.sendEmulatorCommand({ type: "set_path", path: nextPath });
    await window.dartsnutApi.sendEmulatorCommand({ type: "reload_widget" });
    setDartCoords(Array.from({ length: 12 }, () => null));
  }

  function parseAndFormatParamsJson(rawText: string): { params: Record<string, unknown>; pretty: string } {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Params must be a JSON object.");
    }
    return {
      params: parsed as Record<string, unknown>,
      pretty: JSON.stringify(parsed, null, 2),
    };
  }

  function formatParamsJsonInEditor() {
    try {
      const { pretty } = parseAndFormatParamsJson(widgetParamsText);
      setWidgetParamsText(pretty);
      setWidgetParamsError(null);
    } catch (error) {
      setWidgetParamsError(error instanceof Error ? error.message : "Invalid JSON.");
    }
  }

  async function applyParamsAndReload() {
    if (!widgetPath.trim()) {
      setWidgetParamsError("Select a widget folder first.");
      return;
    }
    let params: Record<string, unknown>;
    let pretty: string;
    try {
      const parsed = parseAndFormatParamsJson(widgetParamsText);
      params = parsed.params;
      pretty = parsed.pretty;
    } catch (error) {
      setWidgetParamsError(error instanceof Error ? error.message : "Invalid JSON.");
      return;
    }
    setWidgetParamsText(pretty);
    setWidgetParamsError(null);
    setEmulatorLogs([]);
    await window.dartsnutApi.sendEmulatorCommand({ type: "set_params", params });
    await window.dartsnutApi.sendEmulatorCommand({ type: "reload_widget" });
    setDartCoords(Array.from({ length: 12 }, () => null));
  }

  function toCanvasCoord(event: MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor((event.clientX - rect.left) * scaleX);
    const y = Math.floor((event.clientY - rect.top) * scaleY);
    return { x, y };
  }

  function toDartCoord(x: number, y: number) {
    const DART_OFFSET_X = 38;
    const DART_OFFSET_Y = 38;
    const SCALE_FACTOR = 4;
    const DART_COORD_SCALE = 299;
    const DART_COORD_OFFSET = 1800;
    if (x < DART_OFFSET_X || x > DART_OFFSET_X + 512 || y < DART_OFFSET_Y || y > DART_OFFSET_Y + 512) {
      return null;
    }
    const boardX = Math.floor((x - DART_OFFSET_X) / SCALE_FACTOR);
    const boardY = Math.floor((y - DART_OFFSET_Y) / SCALE_FACTOR);
    return {
      x: boardX * DART_COORD_SCALE + DART_COORD_OFFSET,
      y: boardY * DART_COORD_SCALE + DART_COORD_OFFSET,
    };
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--color-emulator-bg)] text-[var(--color-emulator-text)]">
      {!bridgeReady ? (
        <header className="border-b border-[var(--color-emulator-border)] p-4">
          <div className="m-0 text-xs text-[var(--color-warning-text)]">Desktop bridge is unavailable.</div>
        </header>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col items-stretch justify-start gap-0 overflow-hidden p-0 text-[var(--color-emulator-canvas-hint)]">
        <div className="box-border flex min-h-0 min-w-0 w-full flex-1 flex-row items-center justify-center gap-2 overflow-hidden p-0">
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <canvas
              ref={canvasRef}
              className="block h-[400px] w-[294px] shrink-0 border-0 bg-transparent [image-rendering:pixelated]"
              width={CANVAS_BASE_WIDTH}
              height={CANVAS_BASE_HEIGHT}
              onContextMenu={(e) => e.preventDefault()}
              onMouseDown={(event) => {
                if (!bridgeReady) return;
                const coord = toCanvasCoord(event);
                if (!coord) return;
                const dartCoord = toDartCoord(coord.x, coord.y);
                if (!dartCoord) return;
                if (event.button === 0) {
                  const index = currentDartIndexRef.current;
                  void window.dartsnutApi.sendEmulatorCommand({
                    type: "throw_dart",
                    index,
                    x: dartCoord.x,
                    y: dartCoord.y,
                  });
                  setDartCoords((prev) => {
                    const next = [...prev];
                    next[index] = { x: dartCoord.x, y: dartCoord.y };
                    return next;
                  });
                } else if (event.button === 2) {
                  const now = Date.now();
                  if (now - lastRightClickMsRef.current < 500) {
                    void window.dartsnutApi.sendEmulatorCommand({ type: "clear_darts" });
                    setDartCoords(Array.from({ length: 12 }, () => null));
                    lastRightClickMsRef.current = now;
                    return;
                  }
                  const selectedIndex = currentDartIndexRef.current;
                  setDartCoords((prev) => {
                    const selected = prev[selectedIndex];
                    if (!selected) return prev;
                    void window.dartsnutApi.sendEmulatorCommand({
                      type: "remove_dart_at",
                      x: selected.x,
                      y: selected.y,
                    });
                    const next = [...prev];
                    next[selectedIndex] = null;
                    return next;
                  });
                  lastRightClickMsRef.current = now;
                }
              }}
            />
            <div className="box-border m-0 flex w-full max-w-[294px] shrink-0 flex-row items-center justify-center gap-2.5 self-stretch px-2 pb-2 pt-1.5 text-center text-xs text-[var(--color-state-line)]">
              <span>{state.running ? "Running" : "Stopped"}</span>
              <span>{projectKindLabel}</span>
              <span>FPS C{captureFps} / R{renderFps}</span>
            </div>
          </div>
          <div
            className="flex shrink-0 flex-col flex-nowrap items-center justify-start gap-1.5 border-t-0 p-0 [app-region:no-drag] [-webkit-app-region:no-drag]"
            role="toolbar"
            aria-label="Emulator actions"
          >
            <button
              type="button"
              className={emuToolbarIconBtn}
              disabled={!bridgeReady || !widgetPath.trim()}
              onClick={() => void applyWidgetPathAndReload(widgetPath)}
              aria-label="Start or reload"
              title="Start / Reload"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36M20.49 15a9 9 0 01-14.85 3.36"
                />
              </svg>
            </button>
            <button
              type="button"
              className={emuToolbarIconBtn}
              disabled={!bridgeReady}
              onClick={() => void window.dartsnutApi.sendEmulatorCommand({ type: "capture_screenshot" })}
              aria-label="Capture screenshot"
              title="Capture screenshot"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
                />
                <circle cx="12" cy="13" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            </button>
            <button
              type="button"
              className={emuToolbarIconBtn}
              onClick={() => setZoomOpen(true)}
              aria-label="Zoom 2x"
              title="Zoom 2x"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
                <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-4.35-4.35M11 8v6M8 11h6"
                />
              </svg>
            </button>
            <button
              type="button"
              className={emuToolbarIconBtn}
              onClick={() => setLogsOpen((prev) => !prev)}
              aria-label={logsOpen ? "Hide Python logs" : "Show Python logs"}
              title={logsOpen ? "Hide logs" : "Logs"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
                />
              </svg>
            </button>
          </div>
        </div>
        {showParamsPanel ? (
          <div className="mx-3.5 mb-0 mt-0 box-border flex w-auto shrink-0 flex-col gap-2 self-stretch rounded-lg border border-[var(--color-params-border)] bg-[var(--color-params-bg)] px-4 py-3">
            <div className="text-xs text-[var(--color-params-header)]">
              <strong>Widget Params (JSON)</strong>
            </div>
            <textarea
              className="box-border max-h-[200px] min-h-[100px] w-full resize-y rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-2.5 py-2.5 font-mono text-xs leading-snug text-[var(--color-input-text)] [font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] outline-none focus:border-[var(--color-input-focus-border)] focus:shadow-[0_0_0_1px_var(--color-input-focus-border)]"
              value={widgetParamsText}
              onChange={(e) => {
                setWidgetParamsText(e.target.value);
                if (widgetParamsError) setWidgetParamsError(null);
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
              <button type="button" className={emuToolbarBtn} disabled={!bridgeReady} onClick={() => formatParamsJsonInEditor()}>
                Format JSON
              </button>
              <button type="button" className={emuToolbarBtn} disabled={!bridgeReady} onClick={() => void applyParamsAndReload()}>
                Apply Params + Reload
              </button>
            </div>
          </div>
        ) : null}
        {showDartLegend ? (
          <div
            className="box-border grid w-full shrink-0 grid-cols-6 justify-items-center gap-2 px-2 pb-2"
            aria-label="Dart indexes"
          >
            {DART_COLORS.map((color, idx) => {
              const isSelected = idx === selectedDartIndex;
              const isPlaced = dartCoords[idx] !== null;
              const useLightText = idx % 4 === 0 || idx % 4 === 1;
              return (
                <button
                  type="button"
                  key={`dart-${idx + 1}`}
                  className={cn(
                    "box-border inline-flex size-[30px] cursor-pointer items-center justify-center justify-self-center rounded-full border border-[var(--color-dart-dot-border)] p-0 text-[11px] font-semibold opacity-35 [image-rendering:pixelated]",
                    useLightText ? "text-[var(--color-dart-dot-fg-light)]" : "text-[var(--color-dart-dot-fg)]",
                    isPlaced && "opacity-100",
                    isSelected && "outline outline-2 outline-offset-2 outline-[var(--color-text-strong)]"
                  )}
                  style={{ backgroundColor: color }}
                  title={`F${idx + 1}${isPlaced ? " • placed" : " • not placed"}${isSelected ? " • selected" : ""}`}
                  onClick={() => {
                    currentDartIndexRef.current = idx;
                    setSelectedDartIndex(idx);
                  }}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
        ) : null}
        {captureToast ? (
          <div className="absolute bottom-4 left-1/2 z-10 max-w-[calc(100%-24px)] -translate-x-1/2 rounded-lg border border-[var(--color-toast-border)] bg-[var(--color-toast-backdrop)] px-3 py-2 text-xs text-[var(--color-toast-text)]">
            {captureToast}
          </div>
        ) : null}
      </div>
      {zoomOpen ? (
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center bg-[var(--color-zoom-overlay)]"
          onClick={() => setZoomOpen(false)}
          role="presentation"
        >
          <div
            className="flex max-h-[94vh] w-[min(96vw,1260px)] max-w-[96vw] flex-col overflow-hidden rounded-[10px] border border-[var(--color-zoom-popover-border)] bg-[var(--color-zoom-popover-bg)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Zoomed emulator"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-zoom-popover-border)] px-3 py-2.5">
              <strong>Emulator Zoom 2x</strong>
              <button type="button" className={emuToolbarBtn} onClick={() => setZoomOpen(false)}>
                Close
              </button>
            </div>
            <canvas
              ref={zoomCanvasRef}
              className="mx-auto block max-h-[calc(94vh-52px)] max-w-full object-contain [image-rendering:pixelated]"
              width={CANVAS_BASE_WIDTH * 2}
              height={CANVAS_BASE_HEIGHT * 2}
            />
          </div>
        </div>
      ) : null}
      <div
        className={cn(
          "fixed left-0 top-0 z-[2200] flex h-screen w-[min(540px,90vw)] -translate-x-full flex-col border-r border-[var(--color-zoom-popover-border)] bg-[var(--color-input-bg)] transition-transform duration-[180ms] ease-out",
          logsOpen && "translate-x-0"
        )}
        aria-hidden={!logsOpen}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-zoom-popover-border)] px-3 pb-2.5 pt-6">
          <strong>Python Logs</strong>
          <div className="flex gap-2">
            <button type="button" className={emuToolbarBtn} onClick={() => setLogsPaused((prev) => !prev)}>
              {logsPaused ? "Resume" : "Pause"}
            </button>
            <button type="button" className={emuToolbarBtn} onClick={() => setEmulatorLogs([])}>
              Clear
            </button>
            <button type="button" className={emuToolbarBtn} onClick={() => setLogsOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <div
          className="flex-1 overflow-auto px-2.5 py-2 font-mono text-xs leading-snug [font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace]"
          ref={logsBodyRef}
        >
          {emulatorLogs.length === 0 ? (
            <div className="px-0.5 py-1.5 text-[var(--color-state-line)]">No logs yet.</div>
          ) : (
            emulatorLogs.map((entry) => (
              <div
                className="flex gap-2 break-words border-b border-[var(--color-log-line-border)] px-0.5 py-1"
                key={entry.id}
              >
                <span
                  className={cn(
                    "shrink-0 text-[10px] font-bold uppercase tracking-wide",
                    entry.source === "stderr" && "text-[var(--color-log-stderr)]",
                    entry.source === "stdout" && "text-[var(--color-log-stdout)]",
                    entry.source !== "stderr" && entry.source !== "stdout" && "text-[var(--color-params-header)]"
                  )}
                >
                  {entry.source}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-[var(--color-log-text)]">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
