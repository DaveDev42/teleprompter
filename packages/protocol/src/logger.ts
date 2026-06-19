/**
 * Simple level-based logger.
 *
 * Controlled by LOG_LEVEL env var:
 *   debug | info | warn | error | silent
 *
 * Default: info
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function getLevel(): number {
  const env =
    (typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined) ??
    "info";
  return LEVELS[env as LogLevel] ?? LEVELS.info;
}

let currentLevel = getLevel();

export function setLogLevel(level: LogLevel): void {
  const next = LEVELS[level];
  // Guard against unknown level strings (e.g. from JS callers or bad env var
  // values). Without this, an unrecognised level makes currentLevel = undefined,
  // and every `currentLevel <= LEVELS.x` comparison becomes `undefined <= n`
  // → false, silently disabling ALL log output. Fall back to `info` (consistent
  // with levelFromEnv above) instead of crashing or killing output.
  if (next === undefined) {
    currentLevel = LEVELS.info;
    return;
  }
  currentLevel = next;
}

export function createLogger(prefix: string) {
  return {
    debug(...args: unknown[]) {
      if (currentLevel <= LEVELS.debug) {
        console.log(`[${prefix}]`, ...args);
      }
    },
    info(...args: unknown[]) {
      if (currentLevel <= LEVELS.info) {
        console.log(`[${prefix}]`, ...args);
      }
    },
    warn(...args: unknown[]) {
      if (currentLevel <= LEVELS.warn) {
        console.warn(`[${prefix}]`, ...args);
      }
    },
    error(...args: unknown[]) {
      if (currentLevel <= LEVELS.error) {
        console.error(`[${prefix}]`, ...args);
      }
    },
  };
}
