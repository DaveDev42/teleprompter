/**
 * Silent best-effort catch handler: logs the error at debug level and
 * returns, so callers can drop a `.catch(swallow)` on fire-and-forget
 * promises without losing the stack trace in tests or verbose logs.
 *
 * Previously the same intent showed up across the codebase as empty
 * `catch {}` blocks with a `// ignore` comment — impossible to see what
 * was dropped at runtime. Prefer `swallow` for that case; reserve bare
 * `catch` for call sites where a log would be genuinely noisy.
 */
export function swallow(err: unknown): void {
  if (process.env.NODE_ENV !== "production") {
    // Debug-only surface: console.debug is a no-op in release builds of
    // Metro/Hermes, so this is free in production.
    console.debug("[swallow]", err);
  }
}
