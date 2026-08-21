import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getAnalytics,
  isSupported,
  logEvent,
  setAnalyticsCollectionEnabled,
  setUserId,
  setUserProperties,
  type Analytics
} from "firebase/analytics";

const ANALYTICS_STORAGE_KEY = "dartsnut-analytics-enabled";
const FIREBASE_APP_NAME = "dartsnut-analytics";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

export function isFirebaseConfigComplete(config: typeof firebaseConfig): boolean {
  return Object.values(config).every((value) => typeof value === "string" && value.trim().length > 0);
}

export type AnalyticsValue = string | number | boolean;
export type AnalyticsParams = Record<string, AnalyticsValue>;
export type AnalyticsScreen = "main" | "settings";
export type AnalyticsPanel = "emulator" | "assets" | "deploy" | "community";

export type AnalyticsUser = {
  analyticsUserId: string | null;
  loggedIn: boolean;
  authMethod: "password" | "google" | null;
};

const emitAnalyticsEvent = logEvent as unknown as (
  instance: Analytics,
  name: string,
  params?: AnalyticsParams
) => void;

let analyticsPromise: Promise<Analytics | null> | null = null;
let analyticsEnabledOverride: boolean | null = null;
let currentScreen: AnalyticsScreen = "main";
let currentPanel: AnalyticsPanel | null = null;
let clickTrackingInstalled = false;
let lastScreenView: AnalyticsScreen | null = null;
const lastPanelViewByArea = new Map<string, AnalyticsPanel>();

function defaultAnalyticsEnabled(): boolean {
  return !import.meta.env.DEV;
}

function readStoredCollectionPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(ANALYTICS_STORAGE_KEY);
    if (stored === "true") {
      return true;
    }
    if (stored === "false") {
      return false;
    }
  } catch {
    // Storage is optional and may be unavailable in restricted renderer contexts.
  }
  return defaultAnalyticsEnabled();
}

function isAnalyticsEnabled(): boolean {
  return analyticsEnabledOverride ?? readStoredCollectionPreference();
}

function storeCollectionPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(ANALYTICS_STORAGE_KEY, String(enabled));
  } catch {
    // Storage is optional.
  }
}

async function createAnalytics(): Promise<Analytics | null> {
  if (typeof window === "undefined" || !isFirebaseConfigComplete(firebaseConfig)) {
    return null;
  }
  try {
    if (!(await isSupported())) {
      return null;
    }
    const app = getApps().some((candidate) => candidate.name === FIREBASE_APP_NAME)
      ? getApp(FIREBASE_APP_NAME)
      : initializeApp(firebaseConfig, FIREBASE_APP_NAME);
    const instance = getAnalytics(app);
    setAnalyticsCollectionEnabled(instance, isAnalyticsEnabled());
    return instance;
  } catch {
    return null;
  }
}

export function initializeAnalytics(): Promise<Analytics | null> {
  if (!analyticsPromise) {
    analyticsPromise = createAnalytics();
  }
  return analyticsPromise;
}

async function withAnalytics(callback: (instance: Analytics) => void): Promise<void> {
  try {
    const instance = await initializeAnalytics();
    if (!instance) {
      return;
    }
    callback(instance);
  } catch {
    // Analytics must never affect the app.
  }
}

export function getAnalyticsCollectionEnabled(): boolean {
  return isAnalyticsEnabled();
}

export function setAnalyticsCollectionEnabledPreference(enabled: boolean): void {
  analyticsEnabledOverride = enabled;
  storeCollectionPreference(enabled);
  void withAnalytics((instance) => {
    setAnalyticsCollectionEnabled(instance, enabled);
  });
}

const SENSITIVE_PARAM_KEY = /(prompt|response|content|message|path|file|ip|host|device|account|email|credential|password|token|api_key)/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ABSOLUTE_PATH_VALUE = /^(?:[A-Za-z]:[\\/]|[/~])/;
const IP_VALUE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function sanitizeAnalyticsParams(params: AnalyticsParams): AnalyticsParams {
  return Object.fromEntries(
    Object.entries(params).filter(([key, value]) => {
      if (SENSITIVE_PARAM_KEY.test(key)) {
        return false;
      }
      if (typeof value !== "string") {
        return true;
      }
      const trimmed = value.trim();
      return !EMAIL_VALUE.test(trimmed) && !ABSOLUTE_PATH_VALUE.test(trimmed) && !IP_VALUE.test(trimmed);
    })
  );
}

function eventParams(params: AnalyticsParams = {}): AnalyticsParams {
  return sanitizeAnalyticsParams({
    ...params,
    ...(import.meta.env.DEV ? { debug_mode: true } : {})
  });
}

export function setAnalyticsViewContext(screen: AnalyticsScreen, panel: AnalyticsPanel | null): void {
  currentScreen = screen;
  currentPanel = panel;
}

export function trackScreenView(screen: AnalyticsScreen): void {
  setAnalyticsViewContext(screen, currentPanel);
  if (lastScreenView === screen) {
    return;
  }
  lastScreenView = screen;
  void withAnalytics((instance) => {
    emitAnalyticsEvent(instance, "screen_view", eventParams({
      firebase_screen: screen,
      firebase_screen_class: "DartsnutAgent"
    }));
  });
}

export function trackPanelView(panel: AnalyticsPanel, area = "main"): void {
  currentPanel = panel;
  if (lastPanelViewByArea.get(area) === panel) {
    return;
  }
  lastPanelViewByArea.set(area, panel);
  void withAnalytics((instance) => {
    emitAnalyticsEvent(instance, "panel_view", eventParams({
      panel,
      area,
      screen: currentScreen
    }));
  });
}

export function trackUiAction(controlId: string, area?: string): void {
  if (!controlId.trim()) {
    return;
  }
  void withAnalytics((instance) => {
    emitAnalyticsEvent(instance, "ui_click", eventParams({
      control_id: controlId.trim(),
      area: area?.trim() || "app",
      screen: currentScreen,
      ...(currentPanel ? { panel: currentPanel } : {})
    }));
  });
}

export function trackAgentEvent(name: string, params: AnalyticsParams = {}): void {
  void withAnalytics((instance) => {
    emitAnalyticsEvent(instance, name, eventParams({
      screen: currentScreen,
      ...(currentPanel ? { panel: currentPanel } : {}),
      ...params
    }));
  });
}

export function updateAnalyticsUser(user: AnalyticsUser): void {
  void withAnalytics((instance) => {
    setUserId(instance, user.analyticsUserId);
    setUserProperties(instance, {
      signed_in: user.loggedIn ? "true" : "false",
      auth_method: user.authMethod ?? "none"
    });
  });
}

export function installAnalyticsClickTracking(): () => void {
  if (clickTrackingInstalled || typeof document === "undefined") {
    return () => undefined;
  }
  clickTrackingInstalled = true;
  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const control = target.closest<HTMLElement>("[data-analytics-id]");
    if (!control || control instanceof HTMLButtonElement && control.disabled) {
      return;
    }
    trackUiAction(control.dataset.analyticsId ?? "", control.dataset.analyticsArea);
  };
  document.addEventListener("click", handleClick, true);
  return () => {
    document.removeEventListener("click", handleClick, true);
    clickTrackingInstalled = false;
  };
}
