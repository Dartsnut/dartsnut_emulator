import type { CSSProperties } from "react";
import type { ThemeId } from "./theme";
import { cn } from "./cn";

const themeSelectChevronStyle: CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, transparent 50%, var(--color-text-muted) 50%), linear-gradient(135deg, var(--color-text-muted) 50%, transparent 50%)",
  backgroundPosition: "calc(100% - 14px) calc(50% - 3px), calc(100% - 10px) calc(50% - 3px)",
  backgroundSize: "5px 5px, 5px 5px",
  backgroundRepeat: "no-repeat"
};

const themeIconBtnClass = "workspace-menu__button";

interface ThemeSwitcherProps {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
  id?: string;
  className?: string;
}

export function ThemeSwitcher({ value, onChange, id, className }: ThemeSwitcherProps) {
  return (
    <label
      className={cn(
        "inline-flex shrink-0 items-center gap-2 [app-region:no-drag] [-webkit-app-region:no-drag]",
        className
      )}
      htmlFor={id ?? "theme-select"}
    >
      <span className="text-[11px] font-normal tracking-wide text-[var(--theme-switcher-text)]">Appearance</span>
      <select
        id={id ?? "theme-select"}
        className="m-0 cursor-pointer appearance-none rounded-md border border-[var(--theme-switcher-border)] bg-[var(--theme-switcher-bg)] py-1 pl-2 pr-[26px] text-[11px] text-fg [font:inherit] focus-visible:shadow-[var(--shadow-focus-ring)] focus-visible:outline-none"
        style={themeSelectChevronStyle}
        value={value}
        onChange={(event) => onChange(event.target.value as ThemeId)}
        aria-label="Appearance"
        data-analytics-id="theme_select"
        data-analytics-area="theme"
      >
        <option value="system">System</option>
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

/** Cycles System -> Light -> Dark in compact navigation. */
export function ThemeSwitcherIcon({ value, onChange, id }: ThemeSwitcherIconProps) {
  const next = value === "system" ? "light" : value === "light" ? "dark" : "system";
  return (
    <button
      type="button"
      id={id}
      className={themeIconBtnClass}
      aria-label={`${value} theme (click for ${next})`}
      title={`Switch to ${next} theme`}
      data-analytics-id="theme_toggle"
      data-analytics-area="theme"
      onClick={() => onChange(next)}
    >
      {value === "system" ? <SystemIcon /> : value === "light" ? <SunIcon /> : <MoonIcon />}
      <span className="workspace-menu__button-label">Theme</span>
    </button>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
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
