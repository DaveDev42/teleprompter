import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createLogger, setLogLevel } from "./logger";

describe("logger", () => {
  let output: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  beforeEach(() => {
    output = [];
    console.log = (...args: any[]) => output.push(args.join(" "));
    console.warn = (...args: any[]) => output.push(args.join(" "));
    console.error = (...args: any[]) => output.push(args.join(" "));
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    setLogLevel("info"); // reset
  });

  test("info level logs info messages", () => {
    setLogLevel("info");
    const log = createLogger("Test");
    log.info("hello");
    expect(output.length).toBe(1);
    expect(output[0]).toContain("[Test]");
    expect(output[0]).toContain("hello");
  });

  test("info level suppresses debug messages", () => {
    setLogLevel("info");
    const log = createLogger("Test");
    log.debug("hidden");
    expect(output.length).toBe(0);
  });

  test("debug level shows all messages", () => {
    setLogLevel("debug");
    const log = createLogger("Test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(output.length).toBe(4);
  });

  test("silent level suppresses everything", () => {
    setLogLevel("silent");
    const log = createLogger("Test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(output.length).toBe(0);
  });

  test("error level only shows errors", () => {
    setLogLevel("error");
    const log = createLogger("Test");
    log.info("hidden");
    log.warn("hidden");
    log.error("visible");
    expect(output.length).toBe(1);
    expect(output[0]).toContain("visible");
  });
});
