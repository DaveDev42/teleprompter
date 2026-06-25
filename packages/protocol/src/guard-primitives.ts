/**
 * Shared primitive type guards for wire-boundary validation.
 *
 * These helpers are used by every guard module (control-guard, hook-guard,
 * ipc-guard, relay-client-guard, relay-guard, relay-server-guard,
 * session-server-guard) to validate raw JSON values received over untrusted
 * transports before narrowing them to typed protocol messages.
 *
 * All numeric guards use `Number.isFinite` which rejects both `NaN` and
 * `Infinity`. The integer guards additionally require `Number.isInteger`.
 */

/** A plain object with string keys and unknown values. */
export type PlainObject = { [key: string]: unknown };

/** Narrow `v` to a non-null, non-array plain object. */
export function isObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrow `v` to a string. */
export function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Narrow `v` to a finite number (excludes `NaN` and `Infinity`).
 * Use for wire fields that may be any real number (timestamps, versions, etc.).
 */
export function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Narrow `v` to a string or `undefined`. */
export function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

/**
 * Narrow `v` to a finite number or `undefined`.
 * Use for optional wire fields that may be any real number.
 */
export function isOptionalNumber(v: unknown): v is number | undefined {
  return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Narrow `v` to a non-negative integer (0, 1, 2, …).
 * Use for wire fields that are monotonic counters or frame indices:
 * `seq`, replay cursor `c`, subscription `after`.
 */
export function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Narrow `v` to a positive integer (1, 2, 3, …).
 * Use for wire fields that must be strictly positive: PIDs, etc.
 */
export function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Maximum terminal dimension. `struct winsize` (ws_col / ws_row, passed to
 * the kernel via TIOCSWINSZ) stores each dimension in a `unsigned short`
 * (uint16). 65535 is the structural ceiling of that field — it is NOT a
 * tunable: a value of 65536 truncates to 0, degenerating or crashing the PTY.
 */
export const MAX_TERMINAL_DIMENSION = 65535;

/**
 * Narrow `v` to a valid terminal dimension: an integer in [1, 65535].
 * Use for cols/rows wire fields. Unlike `isPositiveInt`, this enforces the
 * uint16 upper bound so an attacker-controlled value cannot truncate when it
 * reaches the kernel's `ws_col` / `ws_row` (TIOCSWINSZ). Shared by the
 * frontend→daemon (relay-guard) and daemon→runner (ipc-guard) trust boundaries.
 */
export function isTerminalDimension(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= MAX_TERMINAL_DIMENSION
  );
}

/**
 * Narrow `v` to a valid terminal dimension or `undefined` (for optional
 * cols/rows on `session.create`). See `isTerminalDimension`.
 */
export function isOptionalTerminalDimension(
  v: unknown,
): v is number | undefined {
  return v === undefined || isTerminalDimension(v);
}

/**
 * Narrow `v` to a string array.
 * Shared by ipc-guard and relay-server-guard.
 */
export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Narrow `v` to a boolean. */
export function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/** Narrow `v` to a boolean or `undefined`. */
export function isOptionalBoolean(v: unknown): v is boolean | undefined {
  return v === undefined || typeof v === "boolean";
}

/** Narrow `v` to the relay role union `"daemon" | "frontend"`. */
export function isRole(v: unknown): v is "daemon" | "frontend" {
  return v === "daemon" || v === "frontend";
}

/** Narrow `v` to the push platform union `"ios" | "android"`. */
export function isPlatform(v: unknown): v is "ios" | "android" {
  return v === "ios" || v === "android";
}
