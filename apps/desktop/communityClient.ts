/**
 * Dartsnut community API + Supabase device state (mirrors dartsnut-community-pc server routes).
 */

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

export type ApiEnvelope = {
  code?: number;
  desc?: string;
  msg?: string;
  data?: unknown;
};

export function readCommunityConfig(env: NodeJS.ProcessEnv = process.env): CommunityConfig {
  const baseApi = String(env.DARTSNUT_BASE_API || DEFAULT_BASE_API).trim().replace(/\/$/, "");
  const supabaseUrl = String(env.DARTSNUT_SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/$/, "");
  const supabaseAnonKey = String(env.DARTSNUT_SUPABASE_ANON_KEY || "").trim();
  const supabaseDeviceTable =
    String(env.DARTSNUT_SUPABASE_DEVICE_TABLE || DEFAULT_SUPABASE_DEVICE_TABLE).trim() ||
    DEFAULT_SUPABASE_DEVICE_TABLE;
  const googleClientId = String(env.DARTSNUT_GOOGLE_CLIENT_ID || "").trim();
  return {
    baseApi,
    supabaseUrl,
    supabaseAnonKey,
    supabaseDeviceTable,
    googleClientId,
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

type FetchLike = typeof fetch;

export class CommunityClient {
  constructor(
    private readonly config: CommunityConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  getConfig(): CommunityConfig {
    return this.config;
  }

  async loginWithPassword(
    account: string,
    password: string
  ): Promise<
    | { ok: true; token: string; account: string }
    | { ok: false; code: CommunityAuthErrorCode; message: string }
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    try {
      const res = await this.fetchImpl(`${this.config.baseApi}/community/member/login-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ account: account.trim(), password })
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (!isApiSuccess(code)) {
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: String(parsed.desc || parsed.msg || "Login failed.")
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
    | { ok: false; code: CommunityAuthErrorCode; message: string }
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    try {
      const res = await this.fetchImpl(`${this.config.baseApi}/community/google/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ idToken: idToken.trim() })
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (!isApiSuccess(code)) {
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: String(parsed.desc || parsed.msg || "Google login failed.")
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
    | { ok: false; code: CommunityAuthErrorCode; message: string }
  > {
    if (!this.config.baseApi) {
      return { ok: false, code: "config_missing", message: "Community API URL is not configured." };
    }
    if (!token.trim()) {
      return { ok: false, code: "session_expired", message: "Please sign in first." };
    }
    try {
      const res = await this.fetchImpl(`${this.config.baseApi}/mobile/device-map/devices`, {
        method: "GET",
        headers: { token: token.trim(), Accept: "application/json" }
      });
      const raw = await res.json().catch(() => null);
      const parsed = normalizeApiJson(raw) || {};
      const code = Number(parsed.code);
      if (!isApiSuccess(code)) {
        return {
          ok: false,
          code: mapApiErrorCode(code),
          message: String(parsed.desc || parsed.msg || "Failed to load devices.")
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
      const res = await this.fetchImpl(url, {
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
    | { ok: false; code: CommunityAuthErrorCode; message: string }
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
}

export function createCommunityClient(env: NodeJS.ProcessEnv = process.env): CommunityClient {
  return new CommunityClient(readCommunityConfig(env));
}
