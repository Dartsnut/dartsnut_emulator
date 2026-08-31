import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// Upload source/package inputs only. Local environments and build/test caches can
// contain thousands of files and are recreated on-device by the sideload runner.
const UPLOAD_EXCLUDED_NAMES = new Set([
  ".git",
  ".dartsnut",
  ".DS_Store",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  "build",
]);

export type SideloadCapabilities = {
  protocolVersion: number;
  supportedSizes: string[];
  heartbeatIntervalSeconds: number;
  heartbeatExpirySeconds: number;
};

export type SideloadFrameEvent = {
  sessionId: string;
  width: number;
  height: number;
  encoding: "png";
  frame: string;
};

export type SideloadLogEvent = {
  sessionId: string;
  timestamp: number;
  stream: "stdout" | "stderr";
  text: string;
};

export type SideloadExitEvent = {
  sessionId: string;
  appId: string;
  exitCode: number | null;
  reason: string;
};

export type SideloadClientHandlers = {
  onLog: (entry: SideloadLogEvent) => void;
  onFrame: (frame: SideloadFrameEvent) => void;
  onExit: (event: SideloadExitEvent) => void;
  onStatus: (message: string) => void;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WebSocketLike = {
  readonly readyState: number;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: Event | MessageEvent) => void): void;
  send(data: string): void;
  close(): void;
};

type WebSocketFactory = (url: string) => WebSocketLike;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeTimestamp(value: unknown): number {
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return Date.now();
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function responseError(message: Record<string, unknown>): string | null {
  const error = message.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  const errorObject = asRecord(error);
  if (errorObject && typeof errorObject.message === "string") return errorObject.message;
  if (message.status === "error" && typeof message.message === "string") return message.message;
  return null;
}

export function parseSideloadCapabilities(message: Record<string, unknown>): SideloadCapabilities | null {
  const protocolVersion = Number(message.protocol_version);
  const supportedSizes = Array.isArray(message.supported_sizes)
    ? message.supported_sizes.flatMap((size) => {
      if (typeof size === "string") return [size];
      if (
        Array.isArray(size)
        && size.length === 2
        && Number.isFinite(Number(size[0]))
        && Number.isFinite(Number(size[1]))
      ) {
        return [`${Number(size[0])}x${Number(size[1])}`];
      }
      return [];
    })
    : [];
  if (protocolVersion !== 1 || supportedSizes.length === 0) return null;
  return {
    protocolVersion,
    supportedSizes,
    heartbeatIntervalSeconds: Number(message.heartbeat_interval_seconds) || 10,
    heartbeatExpirySeconds: Number(message.heartbeat_expiry_seconds) || 30,
  };
}

export async function listSideloadWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(workspaceRoot, relativeDir);
    const entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (UPLOAD_EXCLUDED_NAMES.has(entry.name)) continue;
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath.split(path.sep).join("/"));
      }
    }
  }
  await visit("");
  return files;
}

export class SideloadWebSocketClient {
  private readonly handlers: SideloadClientHandlers;
  private readonly createSocket: WebSocketFactory;
  private socket: WebSocketLike | null = null;
  private requestSequence = 0;
  private pending = new Map<number, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSessionId: string | null = null;
  private capabilitiesValue: SideloadCapabilities | null = null;
  private hostValue: string | null = null;
  private reconnectEnabled = false;

  constructor(
    handlers: SideloadClientHandlers,
    createSocket: WebSocketFactory = (url) => new WebSocket(url),
  ) {
    this.handlers = handlers;
    this.createSocket = createSocket;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get active(): boolean {
    return this.activeSessionId !== null;
  }

  get capabilities(): SideloadCapabilities | null {
    return this.capabilitiesValue;
  }

  async connectAndProbe(host: string, timeoutMs = 3_000): Promise<SideloadCapabilities | null> {
    await this.close(false);
    this.hostValue = host;
    try {
      await this.openSocket(host, timeoutMs);
      const response = await this.request({ action: "sideload_capabilities" }, timeoutMs);
      const capabilities = parseSideloadCapabilities(response);
      if (!capabilities) throw new Error("unsupported sideload capability response");
      this.capabilitiesValue = capabilities;
      this.reconnectEnabled = true;
      return capabilities;
    } catch {
      await this.close(false);
      return null;
    }
  }

  private async openSocket(host: string, timeoutMs: number): Promise<void> {
    const socket = this.createSocket(`ws://${host}:9251/ws`);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event as MessageEvent));
    socket.addEventListener("close", () => this.handleClose(socket, "connection closed"));
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.handlers.onStatus("WebSocket error");
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sideload WebSocket timed out")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error("sideload WebSocket closed while connecting"));
      });
    });
  }

  async start(
    workspaceRoot: string,
    appId: string,
    size: readonly [number, number],
    params: Record<string, unknown>,
  ): Promise<string> {
    if (!this.capabilitiesValue || !this.connected) throw new Error("Safe sideload connection is unavailable.");
    if (this.activeSessionId) await this.stop();
    const sessionId = randomUUID();
    const files = await listSideloadWorkspaceFiles(workspaceRoot);
    this.handlers.onStatus(`Uploading ${files.length} sideload file${files.length === 1 ? "" : "s"}…`);
    for (const relativePath of files) {
      const bytes = await fsp.readFile(path.join(workspaceRoot, ...relativePath.split("/")));
      await this.request({
        action: "sideload_upload",
        session_id: sessionId,
        app_id: appId,
        relative_path: relativePath,
        file_data: bytes.toString("base64"),
      }, 30_000);
    }
    await this.request({
      action: "sideload_start",
      session_id: sessionId,
      app_id: appId,
      size: [...size],
      params,
    }, 60_000);
    this.activeSessionId = sessionId;
    this.startHeartbeat();
    await this.requestLogs().catch(() => { });
    return sessionId;
  }

  async requestLogs(): Promise<boolean> {
    if (!this.activeSessionId || !this.connected) return false;
    const sessionId = this.activeSessionId;
    const response = await this.request({ action: "sideload_logs", session_id: sessionId });
    const logs = Array.isArray(response.logs) ? response.logs : [];
    for (const item of logs) {
      const log = asRecord(item);
      if (log) this.emitLog(log, sessionId);
    }
    if (response.running === false) {
      this.activeSessionId = null;
      this.stopHeartbeat();
      this.handlers.onExit({ sessionId, appId: "", exitCode: null, reason: "not_running" });
      return false;
    }
    return true;
  }

  async updateParams(params: Record<string, unknown>): Promise<void> {
    if (!this.activeSessionId || !this.connected) {
      throw new Error("No active safe sideload session. Run widget first.");
    }
    await this.request({
      action: "sideload_update_params",
      session_id: this.activeSessionId,
      params,
    }, 30_000);
  }

  async stop(): Promise<void> {
    const sessionId = this.activeSessionId;
    this.stopHeartbeat();
    this.activeSessionId = null;
    if (!sessionId || !this.connected) return;
    await this.request({ action: "sideload_stop", session_id: sessionId });
  }

  async close(stopSession = true): Promise<void> {
    this.reconnectEnabled = false;
    this.hostValue = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (stopSession) await this.stop().catch(() => { });
    this.stopHeartbeat();
    this.activeSessionId = null;
    this.capabilitiesValue = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    this.rejectPending(new Error("sideload connection closed"));
  }

  private request(payload: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (!this.socket || !this.connected) return Promise.reject(new Error("Safe sideload WebSocket is not connected."));
    const reqId = ++this.requestSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`${String(payload.action)} timed out`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  private handleMessage(event: MessageEvent): void {
    let message: Record<string, unknown> | null = null;
    try {
      message = asRecord(JSON.parse(String(event.data)));
    } catch {
      return;
    }
    if (!message) return;
    const reqId = Number(message.req_id);
    if (Number.isInteger(reqId) && this.pending.has(reqId)) {
      const pending = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      clearTimeout(pending.timer);
      const error = responseError(message);
      if (error) pending.reject(new Error(error));
      else pending.resolve(message);
      return;
    }
    const action = message.action;
    const sessionId = typeof message.session_id === "string" ? message.session_id : "";
    if (!sessionId || (this.activeSessionId && sessionId !== this.activeSessionId)) return;
    if (action === "sideload_log") {
      this.emitLog(message, sessionId);
    } else if (action === "sideload_frame" && message.encoding === "png" && typeof message.frame === "string") {
      this.handlers.onFrame({
        sessionId,
        width: Number(message.width) || 128,
        height: Number(message.height) || 160,
        encoding: "png",
        frame: message.frame,
      });
    } else if (action === "sideload_exit") {
      this.stopHeartbeat();
      this.activeSessionId = null;
      this.handlers.onExit({
        sessionId,
        appId: String(message.app_id ?? ""),
        exitCode: typeof message.exit_code === "number" ? message.exit_code : null,
        reason: String(message.reason ?? "unknown"),
      });
    }
  }

  private emitLog(message: Record<string, unknown>, sessionId: string): void {
    if (typeof message.text !== "string") return;
    this.handlers.onLog({
      sessionId,
      timestamp: normalizeTimestamp(message.timestamp),
      stream: message.stream === "stderr" ? "stderr" : "stdout",
      text: message.text,
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const seconds = this.capabilitiesValue?.heartbeatIntervalSeconds || 10;
    this.heartbeatTimer = setInterval(() => {
      const sessionId = this.activeSessionId;
      if (!sessionId || !this.connected) return;
      void this.request({ action: "sideload_heartbeat", session_id: sessionId })
        .catch((error) => this.handlers.onStatus(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`));
    }, seconds * 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleClose(socket: WebSocketLike, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopHeartbeat();
    this.rejectPending(new Error(reason));
    if (this.activeSessionId) {
      this.handlers.onStatus("Safe sideload connection lost; reconnecting before firmware lease expires…");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || !this.hostValue || !this.activeSessionId || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, 2_000);
  }

  private async reconnect(): Promise<void> {
    if (!this.reconnectEnabled || !this.hostValue || !this.activeSessionId) return;
    try {
      await this.openSocket(this.hostValue, 3_000);
      const response = await this.request({ action: "sideload_capabilities" }, 3_000);
      const capabilities = parseSideloadCapabilities(response);
      if (!capabilities) throw new Error("unsupported sideload capability response");
      this.capabilitiesValue = capabilities;
      if (await this.requestLogs()) this.startHeartbeat();
      this.handlers.onStatus("Safe sideload connection restored; retained logs synchronized.");
    } catch {
      const socket = this.socket;
      this.socket = null;
      if (socket) socket.close();
      this.scheduleReconnect();
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
