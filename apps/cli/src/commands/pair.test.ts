import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "@teleprompter/daemon";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { capture } from "../test-util";

const CLI = "bun run apps/cli/src/index.ts";

describe("tp pair", () => {
  let home: string;
  let isolatedEnv: Record<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-pair-home-"));
    isolatedEnv = { HOME: home, XDG_DATA_HOME: join(home, "xdg") };
  });

  afterEach(() => {
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  test("generates pairing data with QR code (default/alias)", () => {
    const result = capture(
      `${CLI} pair --relay ws://test.example --no-save`,
      isolatedEnv,
    );
    expect(result).toContain("Generating pairing keys");
    expect(result).toContain("ws://test.example");
    expect(result).toContain('"relay":"ws://test.example"');
  });

  test("tp pair new emits QR", () => {
    const result = capture(
      `${CLI} pair new --relay ws://test.example --no-save`,
      isolatedEnv,
    );
    expect(result).toContain('"relay":"ws://test.example"');
  });
});

// SQLite file handles linger on Windows, causing EBUSY on rmSync in cleanup.
// Matches the pattern used by daemon store-cleanup tests.
describe.skipIf(process.platform === "win32")("tp pair list/delete", () => {
  let home: string;
  let env: Record<string, string>;
  let storeDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-pair-"));
    env = { HOME: home, XDG_DATA_HOME: join(home, "xdg") };
    storeDir = join(home, "xdg", "teleprompter", "vault");
  });

  afterEach(() => {
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  function seed(pairings: Array<{ id: string; relay: string }>) {
    const store = new Store(storeDir);
    for (const p of pairings) {
      store.savePairing({
        daemonId: p.id,
        relayUrl: p.relay,
        relayToken: "t",
        registrationProof: "proof",
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(32),
        pairingSecret: new Uint8Array(32),
      });
    }
    store.close();
  }

  function writePending(id: string, relay: string) {
    const dir = join(home, ".config", "teleprompter");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "pairing.json"),
      JSON.stringify({
        daemonId: id,
        relayUrl: relay,
        relayToken: "t",
        publicKey: "p",
        secretKey: "s",
        createdAt: Date.now(),
      }),
    );
  }

  test("list shows empty state", () => {
    const out = capture(`${CLI} pair list`, env);
    expect(out).toContain("No pairings registered");
  });

  test("list shows registered pairings", () => {
    seed([
      { id: "daemon-aaaa1111", relay: "wss://r.example" },
      { id: "daemon-bbbb2222", relay: "wss://r2.example" },
    ]);
    const out = capture(`${CLI} pair list`, env);
    expect(out).toContain("DAEMON ID");
    expect(out).toContain("daemon-aaaa1111");
    expect(out).toContain("daemon-bbbb2222");
    expect(out).toContain("wss://r.example");
  });

  test("list surfaces pending handoff file", () => {
    writePending("daemon-pending1", "ws://pending.example");
    const out = capture(`${CLI} pair list`, env);
    expect(out).toContain("Pending pairing");
    expect(out).toContain("daemon-pending1");
    expect(out).toContain("ws://pending.example");
  });

  test("list does not duplicate pending when already persisted", () => {
    seed([{ id: "daemon-same1", relay: "wss://r.example" }]);
    writePending("daemon-same1", "wss://r.example");
    const out = capture(`${CLI} pair list`, env);
    expect(out).not.toContain("Pending pairing");
  });

  test("delete by prefix removes one pairing", () => {
    seed([
      { id: "daemon-aaaa1111", relay: "wss://r.example" },
      { id: "daemon-bbbb2222", relay: "wss://r2.example" },
    ]);
    const out = capture(`${CLI} pair delete daemon-aaaa --yes`, env);
    expect(out).toContain("Deleted pairing daemon-aaaa1111");

    const store = new Store(storeDir);
    const remaining = store.listPairings();
    store.close();
    expect(remaining.map((p) => p.daemonId)).toEqual(["daemon-bbbb2222"]);
  });

  test("delete also removes matching pending handoff file", () => {
    writePending("daemon-pending1", "ws://pending.example");
    const out = capture(`${CLI} pair delete daemon-pending --yes`, env);
    expect(out).toContain("Deleted pairing daemon-pending1");
    expect(
      existsSync(join(home, ".config", "teleprompter", "pairing.json")),
    ).toBe(false);
  });

  test("delete preserves non-matching pending handoff file", () => {
    seed([{ id: "daemon-persisted1", relay: "wss://r.example" }]);
    writePending("daemon-pending1", "ws://pending.example");
    const out = capture(`${CLI} pair delete daemon-persisted --yes`, env);
    expect(out).toContain("Deleted pairing daemon-persisted1");
    expect(
      existsSync(join(home, ".config", "teleprompter", "pairing.json")),
    ).toBe(true);
  });

  test("delete errors on no match", () => {
    seed([{ id: "daemon-aaaa1111", relay: "wss://r.example" }]);
    const out = capture(`${CLI} pair delete nope --yes`, env);
    expect(out).toContain("No pairing matches");
  });

  test("delete errors on ambiguous prefix", () => {
    seed([
      { id: "daemon-aaaa1111", relay: "wss://r.example" },
      { id: "daemon-aaaa2222", relay: "wss://r2.example" },
    ]);
    const out = capture(`${CLI} pair delete daemon-aaaa --yes`, env);
    expect(out).toContain("ambiguous");
    expect(out).toContain("daemon-aaaa1111");
    expect(out).toContain("daemon-aaaa2222");
  });

  test("delete errors on extra positionals", () => {
    seed([{ id: "daemon-aaaa1111", relay: "wss://r.example" }]);
    const out = capture(`${CLI} pair delete daemon-aaaa extra --yes`, env);
    expect(out).toContain("Usage: tp pair delete");
  });

  test("delete without --yes on non-TTY refuses", () => {
    seed([{ id: "daemon-aaaa1111", relay: "wss://r.example" }]);
    const out = capture(`${CLI} pair delete daemon-aaaa`, env);
    expect(out).toContain("Refusing to delete");

    const store = new Store(storeDir);
    expect(store.listPairings()).toHaveLength(1);
    store.close();
  });
});
