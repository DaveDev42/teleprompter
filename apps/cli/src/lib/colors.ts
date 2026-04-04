/**
 * Minimal ANSI color helpers for CLI output.
 * Respects NO_COLOR (https://no-color.org/).
 */

const enabled = !process.env.NO_COLOR;

const wrap = (code: string, text: string) =>
  enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

export const green = (t: string) => wrap("32", t);
export const yellow = (t: string) => wrap("33", t);
export const red = (t: string) => wrap("31", t);
export const cyan = (t: string) => wrap("36", t);
export const dim = (t: string) => wrap("90", t);
export const bold = (t: string) => wrap("1", t);

export const ok = (msg: string) => `${green("✓")} ${msg}`;
export const warn = (msg: string) => `${yellow("!")} ${msg}`;
export const fail = (msg: string) => `${red("✕")} ${msg}`;
