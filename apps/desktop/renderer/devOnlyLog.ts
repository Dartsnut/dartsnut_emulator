/** True for Vite dev server; false for production renderer bundles (packaged app). */
export function isDevLoggingEnabled(): boolean {
  return import.meta.env.DEV;
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
