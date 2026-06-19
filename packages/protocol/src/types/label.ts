/**
 * Tagged union for a pairing's human-readable label.
 *
 * A label is "set" (a non-empty user-chosen name like "Office Mac") or "not
 * set". The codebase historically modelled "not set" as `null` AND, on the
 * ControlRename wire, as the empty string `""` — two representations of the
 * same idea that invited bugs at the boundaries. This union makes "not set" a
 * first-class, self-describing value with no magic null/empty-string sentinel.
 *
 * The type is intentionally minimal: a `set` discriminant plus a `value` that
 * only exists in the `set: true` arm. Reading `.value` is impossible without
 * first narrowing on `.set`, so a handler can never dereference an absent
 * label.
 *
 * This module is pure (no Node imports), so it is re-exported from both
 * `@teleprompter/protocol` (server/daemon/CLI) and `@teleprompter/protocol/client`
 * (frontend/app) via `types/index.ts`.
 *
 * ## Wire contract (ADR-0003 Amendment 1, A1.3#1)
 *
 * `Label` travels on three E2EE wire surfaces (ControlRename, the relay.kx
 * daemon-hello, and the meta `hello` daemonLabel). There is ONE union type and
 * ONE meaning per value:
 *
 *  - `{ set: true, value: "X" }` — Set (X trimmed, non-empty)
 *  - `{ set: false }` — Clear (authoritative; ControlRename surface)
 *  - field ABSENT (kx/meta surfaces only) — keep-current (field-level None)
 *
 * The daemon's ControlRename emission always uses the union object — the
 * previous per-peer version-gate that downgraded to a legacy string for v1
 * peers has been removed. The decoders below accept BOTH the legacy and the
 * new union shapes on read so that any SQLite rows or old daemon frames can
 * still be decoded. See `decodeWireLabel` / `decodeKxLabelOrKeep`.
 */

export type Label = { set: true; value: string } | { set: false };

/** The canonical "not set" label. Reuse instead of re-allocating `{ set: false }`. */
export const LABEL_UNSET: Label = { set: false };

/**
 * Build a `Label` from a nullable/optional raw string. Trims whitespace; an
 * empty, all-whitespace, null, or undefined input becomes `{ set: false }`.
 * This is the canonical "user typed a name (or cleared it)" constructor.
 */
export function makeLabel(raw: string | null | undefined): Label {
  if (raw == null) return { set: false };
  const v = raw.trim();
  return v === "" ? { set: false } : { set: true, value: v };
}

/**
 * Collapse a `Label` back to the legacy `string | null` representation —
 * useful at the SQLite edge and for display sites that still think in
 * nullable strings. `{ set: false }` → `null`, `{ set: true, value }` → value.
 */
export function labelToNullable(label: Label): string | null {
  return label.set ? label.value : null;
}

/**
 * Narrow an unknown value to the union object shape `{ set: boolean; value?: unknown }`
 * without asserting the `value` field's type yet.
 */
function isUnionShape(v: unknown): v is { set: boolean; value?: unknown } {
  return typeof v === "object" && v !== null && "set" in v;
}

/**
 * Forgiving decoder for a `Label` field that arrived over the wire (or out of
 * SQLite, or from any untyped source). Accepts every shape the field has ever
 * had:
 *
 *  - legacy string: `"Office Mac"` → `{ set: true, value: "Office Mac" }`,
 *    `""` / whitespace → `{ set: false }`
 *  - legacy absence: `null` / `undefined` → `{ set: false }`
 *  - new union object: `{ set: true, value: "x" }` / `{ set: false }` passed
 *    through (with `value` trimmed and validated)
 *  - anything malformed → `{ set: false }` (documented lossy fallback)
 *
 * This is the read side of the compatibility strategy: a new peer uses it to
 * read frames from an old peer (legacy string), and an old daemon's records
 * read back through it too. NOTE: for the relay.kx daemon-hello and meta
 * `hello` surfaces, "not set" means *keep the current app-side label*, not
 * "clear" — use `decodeKxLabelOrKeep` there instead, which returns `null` to
 * signal keep-current. `decodeWireLabel` is for surfaces where `{ set: false }`
 * is authoritative (ControlRename clear, SQLite, IPC).
 */
export function decodeWireLabel(raw: unknown): Label {
  if (raw == null) return { set: false };
  if (typeof raw === "string") return makeLabel(raw);
  if (isUnionShape(raw)) {
    if (raw.set === false) return { set: false };
    if (raw.set === true && typeof raw.value === "string") {
      return makeLabel(raw.value);
    }
  }
  return { set: false };
}

/**
 * Decoder for the relay.kx daemon-hello and meta `hello` `daemonLabel` fields,
 * where "not set" means **keep the current app-side label**, NOT "clear it".
 * Returns `null` for every keep-current signal (legacy `null` / `undefined` /
 * missing, `{ set: false }`, and a legacy `""`) and a concrete
 * `{ set: true, value }` only when the daemon advertises a real label.
 *
 * Keeping this distinct from `decodeWireLabel` is what preserves the two
 * different meanings of "absent/clear": ControlRename's `{ set: false }` is an
 * authoritative clear, while the daemon-hello's absence is "I have nothing to
 * say about the label; leave whatever the user/QR seeded." The consumer
 * (`handleDaemonHello`) short-circuits on `null`.
 *
 * Per ADR-0003 Amendment 1 (A1.3#1), the preferred keep-current signal on
 * kx/meta surfaces is FIELD ABSENCE (omitting the field entirely), not
 * `{ set: false }`. Both are still accepted here for back-compat with older
 * daemon frames stored in SQLite or in-flight when the daemon restarts.
 */
export function decodeKxLabelOrKeep(raw: unknown): Label | null {
  const decoded = decodeWireLabel(raw);
  return decoded.set ? decoded : null;
}
