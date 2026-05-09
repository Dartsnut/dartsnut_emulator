import type { ThemeId } from "./theme";

interface ThemeSwitcherProps {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
  id?: string;
  className?: string;
}

export function ThemeSwitcher({ value, onChange, id, className }: ThemeSwitcherProps) {
  return (
    <label className={className ?? "theme-switcher"} htmlFor={id ?? "theme-select"}>
      <span className="theme-switcher-label">Appearance</span>
      <select
        id={id ?? "theme-select"}
        className="theme-switcher-select"
        value={value}
        onChange={(event) => onChange(event.target.value as ThemeId)}
        aria-label="Appearance"
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
  );
}

interface ThemeSwitcherIconProps {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
  id?: string;
}

/** Icon-only control for the window chrome band — cycles Dark ↔ Light. */
export function ThemeSwitcherIcon({ value, onChange, id }: ThemeSwitcherIconProps) {
  const label = value === "light" ? "Light theme (click for Dark)" : "Dark theme (click for Light)";
  return (
    <button
      type="button"
      id={id}
      className="theme-switcher-icon-btn"
      aria-label={label}
      title={value === "light" ? "Switch to Dark theme" : "Switch to Light theme"}
      onClick={() => onChange(value === "dark" ? "light" : "dark")}
    >
      {value === "light" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 14.5A8.5 8.5 0 019.5 3a8.45 8.45 0 00-1.8 10 8.5 8.5 0 0013.3 1.5z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
