import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "@teleprompter/daemon";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { capture } from "../test-util";
import { matchPairings } from "./pair";

const CLI = "bun run apps/cli/src/index.ts";

describe("matchPairings", () => {
  const pairings = [
    { daemonId: "daemon-mncx9824" },
    { daemonId: "daemon-aaaa1111" },
    { daemonId: "daemon-aaaa2222" },
  ];

  test("matches by prefix", () => {
    const out = matchPairings(pairings, "daemon-mncx");
    expect(out).toHaveLength(1);
    expect(out[0]!.daemonId).toBe("daemon-mncx9824");
  });

  test("matches via daemon-<fragment> shorthand when prefix does not", () => {
    const out = matchPairings(pairings, "mncx9824");
    expect(out).toHaveLength(1);
    expect(out[0]!.daemonId).toBe("daemon-mncx9824");
  });

  test("returns multiple on ambiguous prefix", () => {
    const out = matchPairings(pairings, "daemon-aaaa");
    expect(out).toHaveLength(2);
  });

  test("exact match wins over substring ambiguity", () => {
    const exact = [{ daemonId: "abc" }, { daemonId: "xabcy" }];
    const out = matchPairings(exact, "abc");
    expect(out).toHaveLength(1);
    expect(out[0]!.daemonId).toBe("abc");
  });

  test("does not match arbitrary mid-id substrings", () => {
    // "cx98" appears in the middle of daemon-mncx9824 but is neither a prefix
    // nor a daemon-<frag> shorthand — it must not match.
    const out = matchPairings(pairings, "cx98");
    expect(out).toHaveLength(0);
  });

  test("daemon-<fragment> shorthand matches exactly one", () => {
    const out = matchPairings(pairings, "aaaa1111");
    expect(out).toHaveLength(1);
    expect(out[0]!.daemonId).toBe("daemon-aaaa1111");
  });

  test("prefix match beats daemon-<fragment> shorthand", () => {
    // A fragment that is both a prefix of one ID and the suffix of another's
    // shorthand must resolve via prefix — the shorthand is only a fallback.
    const both = [{ daemonId: "abc" }, { daemonId: "daemon-abc" }];
    const out = matchPairings(both, "abc");
    expect(out).toHaveLength(1);
    expect(out[0]!.daemonId).toBe("abc");
  });
});

describe("pair.ts onClose race guard (static)", () => {
  // Regression for the v0.1.22 QA bug where `tp pair new` printed
  // "Daemon disconnected — pairing aborted." right after a successful pairing
  // because the IPC socket close handler raced the resolved promise. The fix
  // is a `settled` flag that gates the onClose error path. Verify the source
  // still wires the guard so future refactors don't silently regress it.
  test("onClose handler is gated by the `settled` flag", async () => {
    const src = await Bun.file(
      new URL("./pair.ts", import.meta.url).pathname,
    ).text();
    // The guard must short-circuit before printing the disconnect line.
    expect(src).toMatch(/let settled = false;/);
    expect(src).toMatch(/ipc!\.onClose\(\(\) => \{\s*if \(settled\) return;/);
  });
});

describe("tp pair", () => {
  test("tp pair --help prints usage", () => {
    const home = mkdtempSync(join(tmpdir(), "tp-pair-help-"));
    try {
      const out = capture(`${CLI} pair --help`, { HOME: home });
      expect(out).toContain("tp pair — manage mobile app pairings");
      expect(out).toContain("tp pair new");
    } finally {
      rmSync(home, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });
});

describe("tp pair list/delete", () => {
  let home: string;
  let env: Record<string, string>;
  let storeDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-pair-"));
    env = {
      HOME: home,
      XDG_DATA_HOME: join(home, "xdg"),
      XDG_RUNTIME_DIR: join(home, "runtime"),
      TP_UNPAIR_TIMEOUT_MS: "100",
    };
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

  function seed(
    pairings: Array<{ id: string; relay: string; label?: string | null }>,
  ) {
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
        label: p.label ?? null,
      });
    }
    store.close();
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

  test("delete removes pairing even when relay unreachable", () => {
    seed([{ id: "daemon-aaaa1111", relay: "ws://127.0.0.1:1" }]);
    const out = capture(`${CLI} pair delete daemon-aaaa --yes`, env);
    expect(out).toContain("Deleted pairing daemon-aaaa1111");

    const store = new Store(storeDir);
    expect(store.listPairings()).toHaveLength(0);
    store.close();
  });

  test("list shows LABEL column and persisted labels", () => {
    seed([
      { id: "daemon-aaaa1111", relay: "wss://r.example", label: "Office Mac" },
      { id: "daemon-bbbb2222", relay: "wss://r2.example" },
    ]);
    const out = capture(`${CLI} pair list`, env);
    expect(out).toContain("LABEL");
    expect(out).toContain("Office Mac");
    expect(out).toContain("daemon-aaaa1111");
  });

  test("rename updates the stored label by prefix", () => {
    seed([{ id: "daemon-aaaa1111", relay: "ws://127.0.0.1:1", label: "old" }]);
    const out = capture(`${CLI} pair rename daemon-aaaa New Label Here`, env);
    expect(out).toContain("Renamed daemon-aaaa1111");
    expect(out).toContain('"New Label Here"');

    const store = new Store(storeDir);
    const row = store
      .listPairings()
      .find((p) => p.daemonId === "daemon-aaaa1111");
    store.close();
    expect(row?.label).toBe("New Label Here");
  });

  test("rename trims leading/trailing whitespace in label", () => {
    seed([{ id: "daemon-aaaa1111", relay: "ws://127.0.0.1:1", label: "old" }]);
    const out = capture(
      `${CLI} pair rename daemon-aaaa '   padded label   '`,
      env,
    );
    expect(out).toContain("Renamed daemon-aaaa1111");

    const store = new Store(storeDir);
    const row = store
      .listPairings()
      .find((p) => p.daemonId === "daemon-aaaa1111");
    store.close();
    expect(row?.label).toBe("padded label");
  });

  test("rename with empty label clears it", () => {
    seed([{ id: "daemon-aaaa1111", relay: "ws://127.0.0.1:1", label: "old" }]);
    const out = capture(`${CLI} pair rename daemon-aaaa ''`, env);
    expect(out).toContain("(cleared)");

    const store = new Store(storeDir);
    const row = store
      .listPairings()
      .find((p) => p.daemonId === "daemon-aaaa1111");
    store.close();
    expect(row?.label).toBeNull();
  });

  test("rename errors on ambiguous prefix", () => {
    seed([
      { id: "daemon-aaaa1111", relay: "ws://127.0.0.1:1" },
      { id: "daemon-aaaa2222", relay: "ws://127.0.0.1:1" },
    ]);
    const out = capture(`${CLI} pair rename daemon-aaaa foo`, env);
    expect(out).toContain("ambiguous");
  });

  test("rename errors on no match", () => {
    seed([{ id: "daemon-aaaa1111", relay: "ws://127.0.0.1:1" }]);
    const out = capture(`${CLI} pair rename nope foo`, env);
    expect(out).toContain("No pairing matches");
  });

  test("delete without --yes on non-TTY refuses", () => {
    seed([{ id: "daemon-aaaa1111", relay: "wss://r.example" }]);
    const out = capture(`${CLI} pair delete daemon-aaaa`, env);
    expect(out).toContain("Refusing to delete");

    const store = new Store(storeDir);
    expect(store.listPairings()).toHaveLength(1);
    store.close();
  });

  test("rename matches by suffix fragment (parity with delete)", () => {
    seed([{ id: "daemon-mncx9824", relay: "ws://127.0.0.1:1", label: "old" }]);
    const out = capture(`${CLI} pair rename mncx9824 New`, env);
    expect(out).toContain("Renamed daemon-mncx9824");

    const store = new Store(storeDir);
    const row = store
      .listPairings()
      .find((p) => p.daemonId === "daemon-mncx9824");
    store.close();
    expect(row?.label).toBe("New");
  });

  test("delete matches by suffix fragment", () => {
    seed([{ id: "daemon-mncx9824", relay: "wss://r.example" }]);
    const out = capture(`${CLI} pair delete mncx9824 --yes`, env);
    expect(out).toContain("Deleted pairing daemon-mncx9824");
  });

  test("rename succeeds with stale daemon socket present", () => {
    const runtime = join(home, "runtime");
    mkdirSync(runtime, { recursive: true });
    const sockPath = join(runtime, "daemon.sock");
    writeFileSync(sockPath, "");
    seed([{ id: "daemon-aaaa1111", relay: "ws://127.0.0.1:1", label: "old" }]);

    const out = capture(`${CLI} pair rename daemon-aaaa NewLabel`, env);
    expect(out).toContain("Renamed daemon-aaaa1111");
    expect(existsSync(sockPath)).toBe(false);
  });
});
