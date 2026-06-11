/**
 * Unit tests for the modal-open counter. Plain bun:test — the registry has
 * no DOM or react-native dependency. Tests release every registration they
 * make so the module-level counter returns to zero for sibling tests.
 *
 * Run with:
 *   bun test apps/app/src/lib/modal-open-registry.test.ts
 */

import { describe, expect, test } from "bun:test";
import { isAnyModalOpen, registerOpenModal } from "./modal-open-registry";

describe("modal-open-registry", () => {
  test("open/release round-trip", () => {
    expect(isAnyModalOpen()).toBe(false);
    const release = registerOpenModal();
    expect(isAnyModalOpen()).toBe(true);
    release();
    expect(isAnyModalOpen()).toBe(false);
  });

  test("nested modals stay open until the last release", () => {
    const releaseOuter = registerOpenModal();
    const releaseInner = registerOpenModal();
    releaseOuter();
    expect(isAnyModalOpen()).toBe(true);
    releaseInner();
    expect(isAnyModalOpen()).toBe(false);
  });

  test("double release does not underflow the counter", () => {
    const releaseA = registerOpenModal();
    releaseA();
    releaseA(); // effect cleanup may run on both close and unmount
    expect(isAnyModalOpen()).toBe(false);

    const releaseB = registerOpenModal();
    expect(isAnyModalOpen()).toBe(true);
    releaseB();
    expect(isAnyModalOpen()).toBe(false);
  });
});
