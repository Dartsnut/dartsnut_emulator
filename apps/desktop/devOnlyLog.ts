import { app } from "electron";

/** True for unpackaged dev runs; false for packaged release builds. */
export function isDevLoggingEnabled(): boolean {
  return !app.isPackaged;
}

export const devLog = {
  log(...args: unknown[]): void {
    if (isDevLoggingEnabled()) {
      console.log(...args);
    }
  },
  info(...args: unknown[]): void {
    if (isDevLoggingEnabled()) {
      console.info(...args);
    }
  },
  warn(...args: unknown[]): void {
    if (isDevLoggingEnabled()) {
      console.warn(...args);
    }
  },
  error(...args: unknown[]): void {
    if (isDevLoggingEnabled()) {
      console.error(...args);
    }
  },
  debug(...args: unknown[]): void {
    if (isDevLoggingEnabled()) {
      console.debug(...args);
    }
  }
};
