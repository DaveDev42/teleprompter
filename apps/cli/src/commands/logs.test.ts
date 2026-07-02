import { describe, expect, test } from "bun:test";
import { resolveLogsSid } from "./logs";

// Mirrors the `matchSessions` test style in session.test.ts:95-138 — same
// exact/prefix/ambiguous/none matrix, but exercised through `resolveLogsSid`
// (the `tp logs <sid>` resolution path) rather than the bare matcher.
describe("resolveLogsSid", () => {
  const sessions = [
    { sid: "session-mncx9824" },
    { sid: "session-aaaa1111" },
    { sid: "session-aaaa2222" },
  ];

  test("resolves an exact sid match", () => {
    const logs: string[] = [];
    const sid = resolveLogsSid(sessions, "session-aaaa1111", (m) =>
      logs.push(m),
    );
    expect(sid).toBe("session-aaaa1111");
    expect(logs).toHaveLength(0);
  });

  test("resolves an unambiguous prefix match", () => {
    const logs: string[] = [];
    const sid = resolveLogsSid(sessions, "session-mncx", (m) => logs.push(m));
    expect(sid).toBe("session-mncx9824");
    expect(logs).toHaveLength(0);
  });

  test("reports ambiguous prefix with candidate hints", () => {
    const logs: string[] = [];
    const sid = resolveLogsSid(sessions, "session-aaaa", (m) => logs.push(m));
    expect(sid).toBeNull();
    expect(logs.some((l) => l.includes("ambiguous"))).toBe(true);
    expect(logs.some((l) => l.includes("session-aaaa1111"))).toBe(true);
    expect(logs.some((l) => l.includes("session-aaaa2222"))).toBe(true);
  });

  test("reports no match with known-sids hint", () => {
    const logs: string[] = [];
    const sid = resolveLogsSid(sessions, "nope", (m) => logs.push(m));
    expect(sid).toBeNull();
    expect(logs.some((l) => l.includes("No session matches"))).toBe(true);
    expect(logs.some((l) => l.includes("Known sids"))).toBe(true);
  });

  test("reports no match without a hint list when there are no candidates", () => {
    const logs: string[] = [];
    const sid = resolveLogsSid([], "anything", (m) => logs.push(m));
    expect(sid).toBeNull();
    expect(logs.some((l) => l.includes("No session matches"))).toBe(true);
    expect(logs.some((l) => l.includes("Known sids"))).toBe(false);
  });

  test("caps the known-sids hint at 20 entries and notes the remainder", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      sid: `session-${String(i).padStart(2, "0")}`,
    }));
    const logs: string[] = [];
    const sid = resolveLogsSid(many, "nope", (m) => logs.push(m));
    expect(sid).toBeNull();
    expect(logs.some((l) => l.includes("5 more"))).toBe(true);
  });

  test("rejects middle-of-string substring match (not prefix/exact)", () => {
    const logs: string[] = [];
    const sid = resolveLogsSid(sessions, "ncx9", (m) => logs.push(m));
    expect(sid).toBeNull();
  });
});
