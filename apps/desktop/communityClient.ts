/**
 * Dartsnut community API + Supabase device state (mirrors dartsnut-community-pc server routes).
 */

import { withDartsnutSourceHeader } from "./dartsnutSourceHeader";

export const DEFAULT_BASE_API = "https://api.dartsnut.com";
export const DEFAULT_SUPABASE_URL = "https://base.dartsnut.com";
export const DEFAULT_SUPABASE_DEVICE_TABLE = "remote_devices";

export const SESSION_EXPIRED_API_CODES = new Set([1026, 1006, 1038]);

export type CommunityConfig = {
  baseApi: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseDeviceTable: string;
  googleClientId: string;
  googleDesktopClientId: string;
  googleDesktopClientSecret: string;
  hasSupabase: boolean;
};

export type CommunityAuthErrorCode =
  | "invalid_credentials"
  | "session_expired"
  | "config_missing"
  | "network_error"
  | "api_error";

export type BoundDeviceRow = {
  deviceId: string;
  name: string;
  model: string;
};

export type DeployDeviceRow = {
  deviceId: string;
  name: string;
  model: string;
  ipAddress: string;
  ssid: string;
  updatedAt: string | null;
};

export type CommunityGameRow = {
  id: number | string;
  gameId: string;
  gameName: string;
  mainCover: string;
  description: string;
  status: string;
  createdAt: string | null;
};

export type CommunityAppRow = {
  id: number | string;
  appId: string;
  appName: string;
  projectType: "game" | "widget";
  mainCover: string;
  description: string;
  status: string;
  createdAt: string | null;
};

export type CommunityCategoryRow = {
  id: number | string;
  name: string;
};

export type CommunityControlRow = {
  value: string;
  label: string;
};

export type CommunitySizeRow = {
  value: string;
  label: string;
};

export type CommunityVersionRow = {
  id: number | string;
  appSystemId: number | string;
  projectType: "game" | "widget";
  version: string;
  description: string;
  status: string;
  createdAt: string | null;
};

export type CommunityCreateAppInput = {
  projectType: "game" | "widget";
  mainCover: string;
  appName: string;
  appId: string;
  categoryId: number | string;
  minPersonal?: number | null;
  maxPersonal?: number | null;
  control: string[];
  widgetSize?: string;
};

export type CommunitySubmitAppVersionInput = {
  projectType: "game" | "widget";
  appSystemId: number | string;
  version: string;
  downloadUrl: string;
  downloadMd5: string;
  description: string;
  fields?: string;
  preview: string[];
};

export type CommunitySubmitGameVersionInput = {
  gameSystemId: number | string;
  version: string;
  gameDownloadUrl: string;
  gameDownloadMd5: string;
  description: string;
  fields?: string;
  preview: string[];
};

export type CommunityVersionSubmitResult = {
  versionId: number | string | null;
  status: string;
};

export type CommunityWithdrawAppVersionInput = {
  projectType: "game" | "widget";
  versionId: number | string;
  appSystemId: number | string;
};

export type CommunityUploadZipResult = {
  url: string;
  md5: string;
};

export type ApiEnvelope = {
  code?: number;
  desc?: string;
  msg?: string;
  data?: unknown;
};

export type CommunityApiError = {
  ok: false;
  code: CommunityAuthErrorCode;
  message: string;
  serverMessage?: string;
};

export function readCommunityConfig(env: NodeJS.ProcessEnv = process.env): CommunityConfig {
  const baseApi = String(env.DARTSNUT_BASE_API || DEFAULT_BASE_API).trim().replace(/\/$/, "");
  const supabaseUrl = String(env.DARTSNUT_SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/$/, "");
  const supabaseAnonKey = String(env.DARTSNUT_SUPABASE_ANON_KEY || "").trim();
  const supabaseDeviceTable =
    String(env.DARTSNUT_SUPABASE_DEVICE_TABLE || DEFAULT_SUPABASE_DEVICE_TABLE).trim() ||
    DEFAULT_SUPABASE_DEVICE_TABLE;
  const googleClientId = String(env.DARTSNUT_GOOGLE_CLIENT_ID || "").trim();
  const googleDesktopClientId = String(env.DARTSNUT_GOOGLE_DESKTOP_CLIENT_ID || "").trim();
  const googleDesktopClientSecret = String(env.DARTSNUT_GOOGLE_DESKTOP_CLIENT_SECRET || "").trim();
  return {
    baseApi,
    supabaseUrl,
    supabaseAnonKey,
    supabaseDeviceTable,
    googleClientId,
    googleDesktopClientId,
    googleDesktopClientSecret,
    hasSupabase: Boolean(supabaseUrl && supabaseAnonKey)
  };
}

export function normalizeApiJson(raw: unknown): ApiEnvelope | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ApiEnvelope;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object") {
    return raw as ApiEnvelope;
  }
  return null;
}

export function isApiSuccess(code: number): boolean {
  return code === 1001 || code === 200;
}

export function isSessionExpiredCode(code: number): boolean {
  return SESSION_EXPIRED_API_CODES.has(code);
}

export function mapApiErrorCode(code: number): CommunityAuthErrorCode {
  if (isSessionExpiredCode(code)) {
    return "session_expired";
  }
  return "api_error";
}

export function apiServerMessage(parsed: ApiEnvelope): string | undefined {
  const value = parsed.desc || parsed.msg;
  return value ? String(value) : undefined;
}

export function buildInFilter(deviceIds: string[]): string {
  const parts = deviceIds.map((id) => `"${String(id).replace(/"/g, "")}"`);
  return `in.(${parts.join(",")})`;
}

export function normalizeBoundDevices(list: unknown[]): BoundDeviceRow[] {
  return list
    .map((row) => {
      const r = row as Record<string, unknown>;
      const deviceId = String(r.device_id || r.deviceId || "").trim();
      if (!deviceId) {
        return null;
      }
      return {
        deviceId,
        name: String(r.name || "").trim(),
        model: String(r.model || "").trim()
      };
    })
    .filter((row): row is BoundDeviceRow => row !== null);
}

export function mergeDeployDevices(
  bindings: BoundDeviceRow[],
  states: Record<string, { state?: unknown; updated_at?: string | null }>
): DeployDeviceRow[] {
  return bindings.map((binding) => {
    const live = states[binding.deviceId];
    const st =
      live?.state && typeof live.state === "object" ? (live.state as Record<string, unknown>) : null;
    const infoName =
      st?.device_info && typeof st.device_info === "object"
        ? String((st.device_info as Record<string, unknown>).name || "").trim()
        : "";
    const displayName = binding.name || infoName || binding.deviceId;
    return {
      deviceId: binding.deviceId,
      name: displayName,
      model: binding.model,
      ipAddress: String(st?.ip_address || "").trim(),
      ssid: String(st?.ssid || "").trim(),
      updatedAt: live?.updated_at != null ? String(live.updated_at) : null
    };
  });
}

export function filterAllowedDeviceIds(
  allowed: string[],
  requested: string[] | null | undefined
): string[] {
  if (!requested?.length) {
    return allowed;
  }
  const set = new Set(allowed);
  return requested.map((id) => String(id).trim()).filter((id) => id && set.has(id));
}

export function normalizeCommunityGames(list: unknown[]): CommunityGameRow[] {
  return list
    .map((row) => {
      const r = row as Record<string, unknown>;
      const id = r.id ?? r.game_system_id ?? r.gameSystemId ?? r.game_id ?? "";
      const gameId = String(r.game_id || r.gameId || "").trim();
      const gameName = String(r.game_name || r.gameName || "").trim();
      if (!id && !gameId && !gameName) {
        return null;
      }
      return {
        id: typeof id === "number" ? id : String(id).trim(),
        gameId,
        gameName,
        mainCover: String(r.main_cover || r.mainCover || "").trim(),
        description: String(r.description || r.desc || "").trim(),
        status: String(r.status || "").trim(),
        createdAt: r.created_at != null ? String(r.created_at) : r.createdAt != null ? String(r.createdAt) : null
      };
    })
    .filter((row): row is CommunityGameRow => row !== null);
}

export function normalizeCommunityApps(list: unknown[], projectType: "game" | "widget"): CommunityAppRow[] {
  return list
    .map((row) => {
      const r = row as Record<string, unknown>;
      const systemKey = projectType === "game" ? "game_system_id" : "widget_system_id";
      const idKey = projectType === "game" ? "game_id" : "widget_id";
      const nameKey = projectType === "game" ? "game_name" : "widget_name";
      const id = r.id ?? r[systemKey] ?? r[idKey] ?? "";
      const appId = String(r[idKey] || r.appId || "").trim();
      const appName = String(r[nameKey] || r.appName || "").trim();
      if (!id && !appId && !appName) {
        return null;
      }
      return {
        id: typeof id === "number" ? id : String(id).trim(),
        appId,
        appName,
        projectType,
        mainCover: String(r.main_cover || r.mainCover || "").trim(),
        description: String(r.description || r.desc || "").trim(),
        status: String(r.status || "").trim(),
        createdAt: r.created_at != null ? String(r.created_at) : r.createdAt != null ? String(r.createdAt) : null
      };
    })
    .filter((row): row is CommunityAppRow => row !== null);
}

export function normalizeCommunityCategories(list: unknown[], projectType: "game" | "widget"): CommunityCategoryRow[] {
  return list
    .map((row) => {
      const r = row as Record<string, unknown>;
      const id = r.id ?? (projectType === "game" ? r.game_cate_id : r.widget_cate_id) ?? "";
      const name = String(
        (projectType === "game" ? r.game_cate_name : r.widget_cate_name) || r.name || r.label || ""
      ).trim();
      if (!id || !name) {
        return null;
      }
      return {
        id: typeof id === "number" ? id : String(id).trim(),
        name
      };
    })
    .filter((row): row is CommunityCategoryRow => row !== null);
}

export function normalizeCommunityControls(list: unknown[]): CommunityControlRow[] {
  return list
    .map((row) => {
      const r = row as Record<string, unknown>;
      const value = String(r.value || r.id || r.key || "").trim();
      const label = String(r.label || r.name || value).trim();
      if (!value) {
        return null;
      }
      return { value, label: label || value };
    })
    .filter((row): row is CommunityControlRow => row !== null);
}

export function normalizeCommunitySizes(list: unknown[]): CommunitySizeRow[] {
  return list
    .map((row) => {
      const r = row as Record<string, unknown>;
      const value = String(r.value || r.id || r.key || "").trim();
      const label = String(r.label || r.name || value).trim();
      if (!value) {
        return null;
      }
      return { value, label: label || value };
    })
    .filter((row): row is CommunitySizeRow => row !== null);
}

export function normalizeCommunityVersions(list: unknown[], projectType: "game" | "widget"): CommunityVersionRow[] {
  return list
    .map((row) => {
      const r = row as Record<string, unknown>;
      const systemKey = projectType === "game" ? "game_system_id" : "widget_system_id";
      const id = r.id ?? r.version_id ?? "";
      const appSystemId = r[systemKey] ?? r.appSystemId ?? "";
      const version = String(r.version || "").trim();
      if (!id && !version) {
        return null;
      }
      return {
        id: typeof id === "number" ? id : String(id).trim(),
        appSystemId: typeof appSystemId === "number" ? appSystemId : String(appSystemId).trim(),
        projectType,
        version,
        description: String(r.description || r.desc || "").trim(),
        status: String(r.status ?? "").trim(),
        createdAt: r.created_at != null ? String(r.created_at) : r.createdAt != null ? String(r.createdAt) : null
      };
    })
    .filter((row): row is CommunityVersionRow => row !== null);
}

export const normalizeCommunityGameCategories = (list: unknown[]): CommunityCategoryRow[] =>
  normalizeCommunityCategories(list, "game");

export const normalizeCommunityGameControls = normalizeCommunityControls;

export function toCommunityAppRow(game: CommunityGameRow): CommunityAppRow {
  return {
    id: game.id,
    appId: game.gameId,
    appName: game.gameName,
    projectType: "game",
    mainCover: game.mainCover,
    description: game.description,
    status: game.status,
    createdAt: game.createdAt
  };
}

export function pickUploadUrl(data: unknown): string {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return String(d.url || d.path || d.file_url || d.fileUrl || d.game_download_url || d.widget_download_url || "").trim();
}

export function pickUploadMd5(data: unknown): string {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return String(d.md5 || d.file_md5 || d.fileMd5 || d.game_download_md5 || d.widget_download_md5 || "").trim();
}

type FetchLike = typeof fetch;

export class CommunityClient {
  constructor(
    private readonly config: CommunityConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  getConfig(): CommunityConfig {
    return this.config;
  }

  private fetchWithDartsnutHeaders(input: RequestInfo | URL, init?: RequestInit): ReturnType<FetchLike> {
    return this.fetchImpl(input, withDartsnutSourceHeader(input, init));
  }

  async loginWithPassword(
    account: string,
    password: string
  ): Promise<
    | { ok: true; token: string; account: string }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/member/login-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ account: account.trim(), password })
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Login failed.",
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const token = String(data?.token || "").trim();
      const userInfo = data?.user_info as Record<string, unknown> | undefined;
      const acct = String(userInfo?.account || account).trim();
      if (!token) {
        return { ok: false, code: "api_error", message: "Login response did not include a token." };
      }
      return { ok: true, token, account: acct };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async loginWithGoogleIdToken(
    idToken: string
  ): Promise<
    | { ok: true; token: string; account: string }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/google/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ idToken: idToken.trim() })
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Google login failed.",
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const token = String(data?.token || "").trim();
      const userInfo = data?.user_info as Record<string, unknown> | undefined;
      const acct = String(userInfo?.account || "").trim();
      if (!token) {
        return { ok: false, code: "api_error", message: "Login response did not include a token." };
      }
      return { ok: true, token, account: acct || "Google user" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async listBoundDevices(
    token: string
  ): Promise<
    | { ok: true; devices: BoundDeviceRow[] }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/mobile/device-map/devices`, {
        method: "GET",
        headers: { token: token.trim(), Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Failed to load devices.",
          serverMessage
        };
      }
      const list = Array.isArray(parsed.data) ? parsed.data : [];
      return { ok: true, devices: normalizeBoundDevices(list) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async fetchSupabaseStates(
    deviceIds: string[]
  ): Promise<
    | {
        ok: true;
        states: Record<string, { state: unknown; updated_at: string | null }>;
        supabaseConfigured: boolean;
      }
    | { ok: false; message: string }
  > {
    if (!deviceIds.length) {
      return { ok: true, states: {}, supabaseConfigured: this.config.hasSupabase };
    }
    if (!this.config.hasSupabase) {
      return { ok: true, states: {}, supabaseConfigured: false };
    }
    const filter = buildInFilter(deviceIds);
    const qs = new URLSearchParams({
      select: "device_id,state,updated_at,last_update_source",
      device_id: filter
    });
    try {
      const url = `${this.config.supabaseUrl}/rest/v1/${encodeURIComponent(this.config.supabaseDeviceTable)}?${qs.toString()}`;
      const res = await this.fetchWithDartsnutHeaders(url, {
        method: "GET",
        headers: {
          apikey: this.config.supabaseAnonKey,
          Authorization: `Bearer ${this.config.supabaseAnonKey}`,
          Accept: "application/json"
        }
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, message: text || `Supabase request failed (${res.status}).` };
      }
      const rows = (await res.json().catch(() => [])) as unknown[];
      const states: Record<string, { state: unknown; updated_at: string | null }> = {};
      for (const row of Array.isArray(rows) ? rows : []) {
        const r = row as Record<string, unknown>;
        const id = String(r.device_id || "").trim();
        if (!id) {
          continue;
        }
        states[id] = {
          state: r.state ?? null,
          updated_at: r.updated_at != null ? String(r.updated_at) : null
        };
      }
      return { ok: true, states, supabaseConfigured: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message };
    }
  }

  async listDeployDevices(
    token: string,
    requestedDeviceIds?: string[] | null
  ): Promise<
    | { ok: true; devices: DeployDeviceRow[]; supabaseConfigured: boolean }
    | CommunityApiError
  > {
    const bound = await this.listBoundDevices(token);
    if (!bound.ok) {
      return bound;
    }
    const allowedIds = bound.devices.map((d) => d.deviceId);
    const targetIds = filterAllowedDeviceIds(allowedIds, requestedDeviceIds);
    if (!targetIds.length) {
      return { ok: true, devices: [], supabaseConfigured: this.config.hasSupabase };
    }
    const filteredBindings = bound.devices.filter((d) => targetIds.includes(d.deviceId));
    const stateResult = await this.fetchSupabaseStates(targetIds);
    if (!stateResult.ok) {
      return {
        ok: true,
        devices: mergeDeployDevices(filteredBindings, {}),
        supabaseConfigured: false
      };
    }
    return {
      ok: true,
      devices: mergeDeployDevices(filteredBindings, stateResult.states),
      supabaseConfigured: stateResult.supabaseConfigured
    };
  }

  async listMyGames(
    token: string
  ): Promise<
    | { ok: true; games: CommunityGameRow[]; total: number }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/game/my-list`, {
        method: "GET",
        headers: { token: token.trim(), Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Failed to load games.",
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const list = Array.isArray(data?.list) ? data.list : Array.isArray(parsed.data) ? parsed.data : [];
      const totalRaw = data?.total;
      const games = normalizeCommunityGames(list);
      const total = typeof totalRaw === "number" ? totalRaw : games.length;
      return { ok: true, games, total };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async listMyWidgets(
    token: string
  ): Promise<
    | { ok: true; widgets: CommunityAppRow[]; total: number }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/widget/my-list`, {
        method: "GET",
        headers: { token: token.trim(), Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Failed to load widgets.",
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const list = Array.isArray(data?.list) ? data.list : Array.isArray(parsed.data) ? parsed.data : [];
      const widgets = normalizeCommunityApps(list, "widget");
      const totalRaw = data?.total;
      const total = typeof totalRaw === "number" ? totalRaw : widgets.length;
      return { ok: true, widgets, total };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async listGameCategories(
    token: string
  ): Promise<
    | { ok: true; categories: CommunityCategoryRow[] }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/game-cate/list`, {
        method: "GET",
        headers: token.trim() ? { token: token.trim(), Accept: "application/json" } : { Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Failed to load game categories.",
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const list = Array.isArray(data?.list) ? data.list : Array.isArray(parsed.data) ? parsed.data : [];
      return { ok: true, categories: normalizeCommunityCategories(list, "game") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async listWidgetCategories(
    token: string
  ): Promise<
    | { ok: true; categories: CommunityCategoryRow[] }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/widget-cate/list`, {
        method: "GET",
        headers: token.trim() ? { token: token.trim(), Accept: "application/json" } : { Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Failed to load widget categories.",
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const list = Array.isArray(data?.list) ? data.list : Array.isArray(parsed.data) ? parsed.data : [];
      return { ok: true, categories: normalizeCommunityCategories(list, "widget") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async listGameControls(
    token: string
  ): Promise<
    | { ok: true; controls: CommunityControlRow[] }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/status/info`, {
        method: "GET",
        headers: token.trim() ? { token: token.trim(), Accept: "application/json" } : { Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Failed to load game controls.",
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const game = data?.GAME && typeof data.GAME === "object" ? (data.GAME as Record<string, unknown>) : {};
      const list = Array.isArray(game.CONTROL_OPTIONS) ? game.CONTROL_OPTIONS : [];
      return { ok: true, controls: normalizeCommunityControls(list) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async listWidgetStatusOptions(
    token: string
  ): Promise<
    | { ok: true; controls: CommunityControlRow[]; sizes: CommunitySizeRow[] }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/status/info`, {
        method: "GET",
        headers: token.trim() ? { token: token.trim(), Accept: "application/json" } : { Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Failed to load widget status options.",
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const widget = data?.WIDGET && typeof data.WIDGET === "object" ? (data.WIDGET as Record<string, unknown>) : {};
      const controls = Array.isArray(widget.CONTROL_OPTIONS) ? widget.CONTROL_OPTIONS : [];
      const sizes = Array.isArray(widget.WIDGET_SIZE_OPTIONS) ? widget.WIDGET_SIZE_OPTIONS : [];
      return { ok: true, controls: normalizeCommunityControls(controls), sizes: normalizeCommunitySizes(sizes) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async listAppVersions(
    token: string,
    projectType: "game" | "widget",
    appSystemId: number | string
  ): Promise<
    | { ok: true; versions: CommunityVersionRow[]; total: number }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    const isWidget = projectType === "widget";
    const qs = new URLSearchParams({
      [isWidget ? "widget_system_id" : "game_system_id"]: String(appSystemId)
    });
    try {
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/${isWidget ? "widget" : "game"}-version/list?${qs.toString()}`, {
        method: "GET",
        headers: { token: token.trim(), Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || `Failed to load ${projectType} versions.`,
          serverMessage
        };
      }
      const data = parsed.data as Record<string, unknown> | null | undefined;
      const list = Array.isArray(data?.list) ? data.list : Array.isArray(parsed.data) ? parsed.data : [];
      const versions = normalizeCommunityVersions(list, projectType);
      const totalRaw = data?.total;
      const total = typeof totalRaw === "number" ? totalRaw : versions.length;
      return { ok: true, versions, total };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async createApp(
    token: string,
    input: CommunityCreateAppInput
  ): Promise<
    | { ok: true; app: CommunityAppRow }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    try {
      const isWidget = input.projectType === "widget";
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/${isWidget ? "widget" : "game"}/add`, {
        method: "POST",
        headers: { token: token.trim(), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(
          isWidget
            ? {
                main_cover: input.mainCover,
                widget_name: input.appName,
                widget_cate_id: Number(input.categoryId),
                widget_id: input.appId,
                control: input.control,
                widget_size: input.widgetSize || ""
              }
            : {
                main_cover: input.mainCover,
                game_name: input.appName,
                game_cate_id: Number(input.categoryId),
                game_id: input.appId,
                min_personal: input.minPersonal || undefined,
                max_personal: input.maxPersonal || undefined,
                control: input.control
              }
        )
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || `Failed to create ${input.projectType} app.`,
          serverMessage
        };
      }
      const data = parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : {};
      const app = normalizeCommunityApps([data[isWidget ? "widget" : "game"] || data.info || data], input.projectType).at(0) || {
        id: data.id != null ? (typeof data.id === "number" ? data.id : String(data.id).trim()) : input.appId,
        appId: input.appId,
        appName: input.appName,
        projectType: input.projectType,
        mainCover: input.mainCover,
        description: "",
        status: "",
        createdAt: null
      };
      return { ok: true, app };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async createGame(
    token: string,
    input: {
      mainCover: string;
      gameName: string;
      gameId: string;
      gameCateId: number | string;
      minPersonal?: number | null;
      maxPersonal?: number | null;
      control: string[];
    }
  ): Promise<
    | { ok: true; game: CommunityGameRow }
    | CommunityApiError
  > {
    const result = await this.createApp(token, {
      projectType: "game",
      mainCover: input.mainCover,
      appName: input.gameName,
      appId: input.gameId,
      categoryId: input.gameCateId,
      minPersonal: input.minPersonal,
      maxPersonal: input.maxPersonal,
      control: input.control
    });
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      game: {
        id: result.app.id,
        gameId: result.app.appId,
        gameName: result.app.appName,
        mainCover: result.app.mainCover,
        description: result.app.description,
        status: result.app.status,
        createdAt: result.app.createdAt
      }
    };
  }

  async uploadNativeImage(
    token: string,
    file: Blob,
    filename: string
  ): Promise<
    | { ok: true; url: string }
    | CommunityApiError
  > {
    return this.uploadFileForUrl(token, "/community/upload/upload-native-image", file, filename, "image");
  }

  async uploadGameZip(
    token: string,
    file: Blob,
    filename: string
  ): Promise<
    | { ok: true; upload: CommunityUploadZipResult }
    | CommunityApiError
  > {
    const result = await this.uploadFileForUrl(token, "/community/upload/upload-game-zip", file, filename, "package");
    if (!result.ok) {
      return result;
    }
    const md5 = pickUploadMd5(result.data);
    if (!md5) {
      return { ok: false, code: "api_error", message: "Upload response did not include an MD5." };
    }
    return { ok: true, upload: { url: result.url, md5 } };
  }

  async uploadWidgetZip(
    token: string,
    file: Blob,
    filename: string
  ): Promise<
    | { ok: true; upload: CommunityUploadZipResult }
    | CommunityApiError
  > {
    const result = await this.uploadFileForUrl(token, "/community/upload/upload-widget-zip", file, filename, "package");
    if (!result.ok) {
      return result;
    }
    const md5 = pickUploadMd5(result.data);
    if (!md5) {
      return { ok: false, code: "api_error", message: "Upload response did not include an MD5." };
    }
    return { ok: true, upload: { url: result.url, md5 } };
  }

  private async uploadFileForUrl(
    token: string,
    endpoint: string,
    file: Blob,
    filename: string,
    label: string
  ): Promise<
    | { ok: true; url: string; data: unknown }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    try {
      const formData = new FormData();
      formData.append("file", file, filename);
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}${endpoint}`, {
        method: "POST",
        headers: { token: token.trim(), Accept: "application/json" },
        body: formData
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || `Failed to upload ${label}.`,
          serverMessage
        };
      }
      const url = pickUploadUrl(parsed.data);
      if (!url) {
        return { ok: false, code: "api_error", message: "Upload response did not include a URL." };
      }
      return { ok: true, url, data: parsed.data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async submitAppVersion(
    token: string,
    input: CommunitySubmitAppVersionInput
  ): Promise<
    | { ok: true; result: CommunityVersionSubmitResult }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    try {
      const isWidget = input.projectType === "widget";
      const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}/community/${isWidget ? "widget" : "game"}-version/add`, {
        method: "POST",
        headers: { token: token.trim(), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(
          isWidget
            ? {
                widget_system_id: Number(input.appSystemId),
                version: input.version,
                widget_download_url: input.downloadUrl,
                widget_download_md5: input.downloadMd5,
                description: input.description,
                fields: input.fields || "",
                preview: input.preview,
                submit_mode: "review"
              }
            : {
                game_system_id: Number(input.appSystemId),
                version: input.version,
                game_download_url: input.downloadUrl,
                game_download_md5: input.downloadMd5,
                description: input.description,
                fields: input.fields || "",
                preview: input.preview,
                submit_mode: "review"
              }
        )
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (res.status === 403) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: "session_expired",
          message: serverMessage || "Please sign in again.",
          serverMessage
        };
      }
      if (!isApiSuccess(code)) {
        const serverMessage = apiServerMessage(parsed);
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: serverMessage || "Failed to submit version for review.",
          serverMessage
        };
      }
      const data = parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : {};
      return {
        ok: true,
        result: {
          versionId:
            data.id != null
              ? typeof data.id === "number"
                ? data.id
                : String(data.id).trim()
              : data.version_id != null
                ? typeof data.version_id === "number"
                  ? data.version_id
                  : String(data.version_id).trim()
                : null,
          status: String(data.status ?? "1")
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "network_error", message };
    }
  }

  async withdrawAppVersion(
    token: string,
    input: CommunityWithdrawAppVersionInput
  ): Promise<
    | { ok: true; status: string }
    | CommunityApiError
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    const isWidget = input.projectType === "widget";
    const appSystemKey = isWidget ? "widget_system_id" : "game_system_id";
    const versionId = typeof input.versionId === "number" ? input.versionId : String(input.versionId).trim();
    const appSystemId =
      typeof input.appSystemId === "number" ? input.appSystemId : String(input.appSystemId).trim();
    const payload = {
      id: versionId,
      version_id: versionId,
      [appSystemKey]: appSystemId,
      submit_mode: "draft",
      status: 0
    };
    const endpoints = [
      `/community/${isWidget ? "widget" : "game"}-version/withdraw`,
      `/community/${isWidget ? "widget" : "game"}-version/cancel-review`,
      `/community/${isWidget ? "widget" : "game"}-version/cancel`,
      `/community/${isWidget ? "widget" : "game"}-version/update`
    ];
    let lastMessage = `Failed to pull ${input.projectType} version out of review.`;
    let lastServerMessage: string | undefined;
    let lastCode: CommunityAuthErrorCode = "api_error";
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchWithDartsnutHeaders(`${this.config.baseApi}${endpoint}`, {
          method: "POST",
          headers: { token: token.trim(), "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload)
        });
        const raw = await res.json().catch(() => null);
        const parsed = normalizeApiJson(raw) || {};
        const code = Number(parsed.code);
        const serverMessage = apiServerMessage(parsed);
        const message = serverMessage || lastMessage;
        if (res.status === 403) {
          return {
            ok: false,
            code: "session_expired",
            message: message || "Please sign in again.",
            serverMessage
          };
        }
        if (res.status === 404 || code === 404) {
          lastMessage = message;
          lastServerMessage = serverMessage;
          continue;
        }
        if (!isApiSuccess(code)) {
          lastCode = mapApiErrorCode(code);
          lastMessage = message;
          lastServerMessage = serverMessage;
          continue;
        }
        const data = parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : {};
        return { ok: true, status: String(data.status ?? "0") };
      } catch (error) {
        lastCode = "network_error";
        lastMessage = error instanceof Error ? error.message : String(error);
        lastServerMessage = undefined;
      }
    }
    return { ok: false, code: lastCode, message: lastMessage, serverMessage: lastServerMessage };
  }

  async submitGameVersion(
    token: string,
    input: CommunitySubmitGameVersionInput
  ): Promise<
    | { ok: true; result: CommunityVersionSubmitResult }
    | CommunityApiError
  > {
    return this.submitAppVersion(token, {
      projectType: "game",
      appSystemId: input.gameSystemId,
      version: input.version,
      downloadUrl: input.gameDownloadUrl,
      downloadMd5: input.gameDownloadMd5,
      description: input.description,
      fields: input.fields,
      preview: input.preview
    });
  }
}

export function createCommunityClient(env: NodeJS.ProcessEnv = process.env): CommunityClient {
  return new CommunityClient(readCommunityConfig(env));
}
