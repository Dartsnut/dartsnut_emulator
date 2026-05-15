/** Must match inline script in apps/desktop/index.html */
export const THEME_STORAGE_KEY = "dartsnut-theme";

export type ThemeId = "dark" | "light";

const VALID: Record<string, true> = { dark: true, light: true };

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

/** No stored value: light OS → light theme, else dark */
export function resolveThemeFromEnvironment(): ThemeId {
  if (typeof window === "undefined") {
    return "dark";
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
  if (typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(prefers-color-scheme: light)").matches) {
        return "light";
      }
    } catch {
      /* ignore */
    }
  }
  return "dark";
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

export function applyTheme(theme: ThemeId): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.theme = theme;
  setStoredTheme(theme);
  if (typeof window !== "undefined" && window.dartsnutApi?.setShellUiTheme) {
    void window.dartsnutApi.setShellUiTheme(theme);
  }
}
