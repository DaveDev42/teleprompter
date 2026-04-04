import { describe, expect, test } from "bun:test";
import { spinner } from "./spinner";

describe("spinner", () => {
  test("returns a stop function", () => {
    const stop = spinner("Loading...");
    expect(typeof stop).toBe("function");
    stop(); // clean up
  });

  test("stop with message does not throw", () => {
    const stop = spinner("Working...");
    expect(() => stop("Done")).not.toThrow();
  });

  test("stop without message does not throw", () => {
    const stop = spinner("Working...");
    expect(() => stop()).not.toThrow();
  });
});
