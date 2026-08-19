/** Must match inline script in apps/desktop/index.html */
export const THEME_STORAGE_KEY = "dartsnut-theme";

export type ThemeId = "system" | "dark" | "light";
export type ResolvedThemeId = Exclude<ThemeId, "system">;

const VALID: Record<string, true> = { system: true, dark: true, light: true };

/** Legacy stored value before the theme id was renamed from `dart` to `dark`. */
const LEGACY_DARK_THEME_ID = "dart";

function normalizeLegacyThemeInStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (window.localStorage.getItem(THEME_STORAGE_KEY) === LEGACY_DARK_THEME_ID) {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    }
  } catch {
    /* ignore */
  }
}

export function isThemeId(value: string): value is ThemeId {
  return VALID[value] === true;
}

/** No stored value follows the operating system. */
export function resolveThemeFromEnvironment(): ThemeId {
  if (typeof window === "undefined") {
    return "system";
  }
  try {
    normalizeLegacyThemeInStorage();
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && isThemeId(raw)) {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "system";
}

export function getStoredTheme(): ThemeId | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    normalizeLegacyThemeInStorage();
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw && isThemeId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function setStoredTheme(theme: ThemeId): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function resolveThemePreference(theme: ThemeId): ResolvedThemeId {
  if (theme !== "system") {
    return theme;
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      /* ignore */
    }
  }
  return "dark";
}

export function applyTheme(theme: ThemeId): void {
  if (typeof document === "undefined") {
    return;
  }
  const resolved = resolveThemePreference(theme);
  document.documentElement.dataset.theme = resolved;
  setStoredTheme(theme);
  if (typeof window !== "undefined" && window.dartsnutApi?.setShellUiTheme) {
    void window.dartsnutApi.setShellUiTheme(theme);
  }
}
