import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { EmulatorFrame, EmulatorLogEntry, EmulatorStateSnapshot } from "@dartsnut/emulator-protocol";

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
  const [canvasDisplaySize, setCanvasDisplaySize] = useState({
    width: CANVAS_BASE_WIDTH,
    height: CANVAS_BASE_HEIGHT,
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const logsBodyRef = useRef<HTMLDivElement | null>(null);
  const emulatorCanvasRef = useRef<HTMLDivElement | null>(null);
  const dartLegendRef = useRef<HTMLDivElement | null>(null);
  const stateLineRef = useRef<HTMLDivElement | null>(null);
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
  const showParamsPanel = normalizedWidgetType !== "game";
  const showDartLegend = normalizedWidgetType !== "widget";
  const runningTypeStatus =
    state.running && normalizedWidgetType === "widget"
      ? "Widget running (python)"
      : state.running && normalizedWidgetType === "game"
        ? "Game running (python)"
        : null;

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

  function drawBackgroundOnly(canvas: HTMLCanvasElement | null) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (backgroundRef.current) {
      ctx.drawImage(backgroundRef.current, 0, 0, canvas.width, canvas.height);
    }
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
          drawBackgroundOnly(canvasRef.current);
          if (zoomOpenRef.current) {
            drawBackgroundOnly(zoomCanvasRef.current);
          }
        };
      } else {
        drawBackgroundOnly(canvasRef.current);
      }
    })();

    const stopState = window.dartsnutApi.onEmulatorState((nextState) => {
      setState(nextState);
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
    }
  }, [zoomOpen]);

  useEffect(() => {
    const container = emulatorCanvasRef.current;
    if (!container) return;
    const updateDisplaySize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const legendH = dartLegendRef.current?.getBoundingClientRect().height ?? 0;
      const stateH = stateLineRef.current?.getBoundingClientRect().height ?? 0;
      const verticalGap = 20;
      const maxW = container.clientWidth;
      const maxH = Math.max(1, container.clientHeight - legendH - stateH - verticalGap);
      const maxScale = Math.min(maxW / CANVAS_BASE_WIDTH, maxH / CANVAS_BASE_HEIGHT);
      const maxDeviceScale = Math.max(1, Math.floor(maxScale * dpr));
      const quantizedScale = maxDeviceScale / dpr;
      const width = CANVAS_BASE_WIDTH * quantizedScale;
      const height = CANVAS_BASE_HEIGHT * quantizedScale;
      setCanvasDisplaySize((prev) =>
        Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5 ? prev : { width, height },
      );
    };
    updateDisplaySize();
    const observer = new ResizeObserver(() => updateDisplaySize());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

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
    <section className="emulator-panel">
      {!bridgeReady ? (
        <header className="emulator-panel-header">
          <div className="warning">Desktop bridge is unavailable.</div>
        </header>
      ) : null}
      <div className="emulator-canvas" ref={emulatorCanvasRef}>
        <canvas
          ref={canvasRef}
          className="screen-canvas"
          width={CANVAS_BASE_WIDTH}
          height={CANVAS_BASE_HEIGHT}
          style={{ width: `${canvasDisplaySize.width}px`, height: `${canvasDisplaySize.height}px` }}
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
        {showParamsPanel ? (
          <div className="params-panel">
            <div className="params-panel-header">
              <strong>Widget Params (JSON)</strong>
            </div>
            <textarea
              className="params-textarea"
              value={widgetParamsText}
              onChange={(e) => {
                setWidgetParamsText(e.target.value);
                if (widgetParamsError) setWidgetParamsError(null);
              }}
              spellCheck={false}
              placeholder='{"city":"tokyo"}'
            />
            {widgetParamsError ? <div className="params-error">{widgetParamsError}</div> : null}
            <div className="params-actions">
              <button type="button" disabled={!bridgeReady} onClick={() => formatParamsJsonInEditor()}>
                Format JSON
              </button>
              <button type="button" disabled={!bridgeReady} onClick={() => void applyParamsAndReload()}>
                Apply Params + Reload
              </button>
            </div>
          </div>
        ) : null}
        {showDartLegend ? (
          <div className="dart-legend" aria-label="Dart indexes" ref={dartLegendRef}>
            {DART_COLORS.map((color, idx) => {
              const isSelected = idx === selectedDartIndex;
              const isPlaced = dartCoords[idx] !== null;
              const useLightText = idx % 4 === 0 || idx % 4 === 1;
              return (
                <button
                  type="button"
                  key={`dart-${idx + 1}`}
                  className={`dart-dot${useLightText ? " light-text" : ""}${isSelected ? " selected" : ""}${isPlaced ? " placed" : ""}`}
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
        <div className="state-line" ref={stateLineRef}>
          <span>{state.running ? "Running" : "Stopped"}</span>
          <span>
            {runningTypeStatus ??
              (state.status.startsWith("Screenshot captured: ") ? "Screenshot captured" : state.status)}
          </span>
          <span>FPS C{captureFps} / R{renderFps}</span>
        </div>
        {captureToast ? <div className="capture-toast">{captureToast}</div> : null}
      </div>
      <div className="emulator-toolbar emulator-controls">
        <button disabled={!bridgeReady || !widgetPath.trim()} onClick={() => void applyWidgetPathAndReload(widgetPath)}>
          Start / Reload
        </button>
        <button disabled={!bridgeReady} onClick={() => void window.dartsnutApi.sendEmulatorCommand({ type: "capture_screenshot" })}>
          Capture
        </button>
        <button type="button" onClick={() => setZoomOpen(true)}>
          Zoom 2x
        </button>
        <button type="button" onClick={() => setLogsOpen((prev) => !prev)}>
          {logsOpen ? "Hide Logs" : "Logs"}
        </button>
      </div>
      {zoomOpen ? (
        <div className="zoom-popover-backdrop" onClick={() => setZoomOpen(false)} role="presentation">
          <div className="zoom-popover" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Zoomed emulator">
            <div className="zoom-popover-header">
              <strong>Emulator Zoom 2x</strong>
              <button onClick={() => setZoomOpen(false)}>Close</button>
            </div>
            <canvas ref={zoomCanvasRef} className="zoom-canvas" width={CANVAS_BASE_WIDTH * 2} height={CANVAS_BASE_HEIGHT * 2} />
          </div>
        </div>
      ) : null}
      <div className={`logs-drawer${logsOpen ? " open" : ""}`} aria-hidden={!logsOpen}>
        <div className="logs-drawer-header">
          <strong>Python Logs</strong>
          <div className="logs-drawer-actions">
            <button type="button" onClick={() => setLogsPaused((prev) => !prev)}>
              {logsPaused ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={() => setEmulatorLogs([])}>
              Clear
            </button>
            <button type="button" onClick={() => setLogsOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <div className="logs-drawer-body" ref={logsBodyRef}>
          {emulatorLogs.length === 0 ? (
            <div className="logs-empty">No logs yet.</div>
          ) : (
            emulatorLogs.map((entry) => (
              <div className={`log-line ${entry.source}`} key={entry.id}>
                <span className="log-source">{entry.source}</span>
                <span className="log-text">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
