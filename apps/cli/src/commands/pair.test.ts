import { Store } from "@teleprompter/daemon";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = "bun run apps/cli/src/index.ts";

function captureWithEnv(cmd: string, env: Record<string, string>): string {
  const tmp = join(tmpdir(), `.tp-test-${process.pid}-${Date.now()}`);
  try {
    execSync(`${cmd} > "${tmp}" 2>&1`, {
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    return readFileSync(tmp, "utf-8");
  } catch {
    try {
      return readFileSync(tmp, "utf-8");
    } catch {
      return "";
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

describe("tp pair", () => {
  test("generates pairing data with QR code (default/alias)", () => {
    const result = captureWithEnv(
      `${CLI} pair --relay ws://test.example --no-save`,
      {},
    );
    expect(result).toContain("Generating pairing keys");
    expect(result).toContain("ws://test.example");
    expect(result).toContain('"relay":"ws://test.example"');
  });

  test("tp pair new emits QR", () => {
    const result = captureWithEnv(
      `${CLI} pair new --relay ws://test.example --no-save`,
      {},
    );
    expect(result).toContain('"relay":"ws://test.example"');
  });
});

describe("tp pair list/delete", () => {
  let dataHome: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), "tp-pair-"));
    env = { XDG_DATA_HOME: dataHome };
  });

  afterEach(() => {
    rmSync(dataHome, { recursive: true, force: true });
  });

  function seed(pairings: Array<{ id: string; relay: string }>) {
    const storeDir = join(dataHome, "teleprompter", "vault");
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

  test("list shows empty state", () => {
    const out = captureWithEnv(`${CLI} pair list`, env);
    expect(out).toContain("No pairings registered");
  });

  test("list shows registered pairings", () => {
    seed([
      { id: "daemon-aaaa1111", relay: "wss://r.example" },
      { id: "daemon-bbbb2222", relay: "wss://r2.example" },
    ]);
    const out = captureWithEnv(`${CLI} pair list`, env);
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
    const out = captureWithEnv(`${CLI} pair delete daemon-aaaa --yes`, env);
    expect(out).toContain("Deleted pairing daemon-aaaa1111");

    const store = new Store(join(dataHome, "teleprompter", "vault"));
    const remaining = store.listPairings();
    store.close();
    expect(remaining.map((p) => p.daemonId)).toEqual(["daemon-bbbb2222"]);
  });

  test("delete errors on no match", () => {
    seed([{ id: "daemon-aaaa1111", relay: "wss://r.example" }]);
    const out = captureWithEnv(`${CLI} pair delete nope --yes`, env);
    expect(out).toContain("No pairing matches");
  });

  test("delete errors on ambiguous prefix", () => {
    seed([
      { id: "daemon-aaaa1111", relay: "wss://r.example" },
      { id: "daemon-aaaa2222", relay: "wss://r2.example" },
    ]);
    const out = captureWithEnv(`${CLI} pair delete daemon-aaaa --yes`, env);
    expect(out).toContain("ambiguous");
    expect(out).toContain("daemon-aaaa1111");
    expect(out).toContain("daemon-aaaa2222");
  });

  test("delete without --yes on non-TTY refuses", () => {
    seed([{ id: "daemon-aaaa1111", relay: "wss://r.example" }]);
    const out = captureWithEnv(`${CLI} pair delete daemon-aaaa`, env);
    expect(out).toContain("Refusing to delete");

    const store = new Store(join(dataHome, "teleprompter", "vault"));
    expect(store.listPairings()).toHaveLength(1);
    store.close();
  });
});
