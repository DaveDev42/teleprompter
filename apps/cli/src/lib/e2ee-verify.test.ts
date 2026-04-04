import { describe, expect, test } from "bun:test";
import { verifyE2EECrypto } from "./e2ee-verify";

describe("verifyE2EECrypto", () => {
  test("passes all E2EE checks", async () => {
    const lines: string[] = [];
    const passed = await verifyE2EECrypto((line) => lines.push(line));

    expect(passed).toBe(true);
    expect(lines.some((l) => l.includes("daemon → frontend: OK"))).toBe(true);
    expect(lines.some((l) => l.includes("frontend → daemon: OK"))).toBe(true);
    expect(lines.some((l) => l.includes("relay isolation:   OK"))).toBe(true);
  });

  test("uses default logger without error", async () => {
    const passed = await verifyE2EECrypto();
    expect(passed).toBe(true);
  });
});
