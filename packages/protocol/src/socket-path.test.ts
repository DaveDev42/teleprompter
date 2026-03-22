import { describe, test, expect } from "bun:test";
import { getSocketPath } from "./socket-path";

describe("getSocketPath", () => {
  test("returns a path ending with daemon.sock", () => {
    const path = getSocketPath();
    expect(path).toMatch(/daemon\.sock$/);
  });

  test("returns a consistent path on repeated calls", () => {
    const path1 = getSocketPath();
    const path2 = getSocketPath();
    expect(path1).toBe(path2);
  });

  test("includes teleprompter in the path", () => {
    const path = getSocketPath();
    expect(path).toContain("teleprompter");
  });
});
