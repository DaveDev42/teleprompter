import { describe, expect, test } from "bun:test";
import { parseIpcMessage } from "./ipc-guard";

describe("parseIpcMessage", () => {
  describe("basic validation", () => {
    test("returns null for non-objects", () => {
      expect(parseIpcMessage(null)).toBeNull();
      expect(parseIpcMessage(undefined)).toBeNull();
      expect(parseIpcMessage("string")).toBeNull();
      expect(parseIpcMessage(42)).toBeNull();
      expect(parseIpcMessage(true)).toBeNull();
    });

    test("returns null when t is missing or not a string", () => {
      expect(parseIpcMessage({})).toBeNull();
      expect(parseIpcMessage({ t: 42 })).toBeNull();
      expect(parseIpcMessage({ t: null })).toBeNull();
    });

    test("returns null for unknown discriminants", () => {
      expect(parseIpcMessage({ t: "unknown" })).toBeNull();
      expect(parseIpcMessage({ t: "fake.event" })).toBeNull();
    });
  });

  describe("hello", () => {
    test("accepts valid hello", () => {
      const result = parseIpcMessage({
        t: "hello",
        sid: "session-1",
        cwd: "/tmp",
        pid: 1234,
      });
      expect(result).toEqual({
        t: "hello",
        sid: "session-1",
        cwd: "/tmp",
        pid: 1234,
        worktreePath: undefined,
        claudeVersion: undefined,
      });
    });

    test("accepts hello with optional fields", () => {
      const result = parseIpcMessage({
        t: "hello",
        sid: "s",
        cwd: "/tmp",
        pid: 1,
        worktreePath: "/w",
        claudeVersion: "1.0.0",
      });
      expect(result?.t).toBe("hello");
      if (result?.t === "hello") {
        expect(result.worktreePath).toBe("/w");
        expect(result.claudeVersion).toBe("1.0.0");
      }
    });

    test("rejects hello with missing fields", () => {
      expect(parseIpcMessage({ t: "hello", cwd: "/tmp", pid: 1 })).toBeNull();
      expect(parseIpcMessage({ t: "hello", sid: "s", pid: 1 })).toBeNull();
      expect(parseIpcMessage({ t: "hello", sid: "s", cwd: "/tmp" })).toBeNull();
    });

    test("rejects hello with wrong field types", () => {
      expect(
        parseIpcMessage({ t: "hello", sid: 1, cwd: "/tmp", pid: 1 }),
      ).toBeNull();
      expect(
        parseIpcMessage({ t: "hello", sid: "s", cwd: 5, pid: 1 }),
      ).toBeNull();
      expect(
        parseIpcMessage({ t: "hello", sid: "s", cwd: "/tmp", pid: "1" }),
      ).toBeNull();
      expect(
        parseIpcMessage({
          t: "hello",
          sid: "s",
          cwd: "/tmp",
          pid: 1,
          worktreePath: 42,
        }),
      ).toBeNull();
    });
  });

  describe("rec", () => {
    test("accepts valid rec", () => {
      const result = parseIpcMessage({
        t: "rec",
        sid: "s",
        kind: "io",
        ts: 1000,
        payload: "aGVsbG8=",
      });
      expect(result).toEqual({
        t: "rec",
        sid: "s",
        kind: "io",
        ts: 1000,
        payload: "aGVsbG8=",
        ns: undefined,
        name: undefined,
      });
    });

    test("accepts rec with namespace and name", () => {
      const result = parseIpcMessage({
        t: "rec",
        sid: "s",
        kind: "event",
        ts: 1,
        payload: "",
        ns: "claude",
        name: "Stop",
      });
      expect(result?.t).toBe("rec");
      if (result?.t === "rec") {
        expect(result.ns).toBe("claude");
        expect(result.name).toBe("Stop");
      }
    });

    test("rejects rec with invalid kind", () => {
      expect(
        parseIpcMessage({
          t: "rec",
          sid: "s",
          kind: "bogus",
          ts: 1,
          payload: "",
        }),
      ).toBeNull();
    });

    test("rejects rec with invalid namespace", () => {
      expect(
        parseIpcMessage({
          t: "rec",
          sid: "s",
          kind: "io",
          ts: 1,
          payload: "",
          ns: "bogus",
        }),
      ).toBeNull();
    });

    test("rejects rec with missing fields", () => {
      expect(
        parseIpcMessage({ t: "rec", kind: "io", ts: 1, payload: "" }),
      ).toBeNull();
      expect(
        parseIpcMessage({ t: "rec", sid: "s", ts: 1, payload: "" }),
      ).toBeNull();
      expect(
        parseIpcMessage({ t: "rec", sid: "s", kind: "io", payload: "" }),
      ).toBeNull();
    });
  });

  describe("bye", () => {
    test("accepts valid bye", () => {
      expect(parseIpcMessage({ t: "bye", sid: "s", exitCode: 0 })).toEqual({
        t: "bye",
        sid: "s",
        exitCode: 0,
      });
    });

    test("rejects bye missing fields", () => {
      expect(parseIpcMessage({ t: "bye", sid: "s" })).toBeNull();
      expect(parseIpcMessage({ t: "bye", exitCode: 0 })).toBeNull();
    });
  });

  describe("ack / input / resize", () => {
    test("ack", () => {
      expect(parseIpcMessage({ t: "ack", sid: "s", seq: 5 })).toEqual({
        t: "ack",
        sid: "s",
        seq: 5,
      });
      expect(parseIpcMessage({ t: "ack", sid: "s" })).toBeNull();
    });

    test("input", () => {
      expect(parseIpcMessage({ t: "input", sid: "s", data: "base64" })).toEqual(
        { t: "input", sid: "s", data: "base64" },
      );
      expect(parseIpcMessage({ t: "input", sid: "s" })).toBeNull();
    });

    test("resize", () => {
      expect(
        parseIpcMessage({ t: "resize", sid: "s", cols: 80, rows: 24 }),
      ).toEqual({ t: "resize", sid: "s", cols: 80, rows: 24 });
      expect(parseIpcMessage({ t: "resize", sid: "s", cols: 80 })).toBeNull();
    });
  });

  describe("pairing messages", () => {
    test("pair.begin with required only", () => {
      const result = parseIpcMessage({
        t: "pair.begin",
        relayUrl: "wss://relay.example",
      });
      expect(result).toEqual({
        t: "pair.begin",
        relayUrl: "wss://relay.example",
        daemonId: undefined,
        label: undefined,
      });
    });

    test("pair.begin with optional fields", () => {
      const result = parseIpcMessage({
        t: "pair.begin",
        relayUrl: "wss://r",
        daemonId: "d1",
        label: "laptop",
      });
      expect(result?.t).toBe("pair.begin");
      if (result?.t === "pair.begin") {
        expect(result.daemonId).toBe("d1");
        expect(result.label).toBe("laptop");
      }
    });

    test("pair.begin rejects missing relayUrl", () => {
      expect(parseIpcMessage({ t: "pair.begin" })).toBeNull();
    });

    test("pair.begin.ok", () => {
      expect(
        parseIpcMessage({
          t: "pair.begin.ok",
          pairingId: "p1",
          qrString: "tp:/...",
          daemonId: "d1",
        }),
      ).toEqual({
        t: "pair.begin.ok",
        pairingId: "p1",
        qrString: "tp:/...",
        daemonId: "d1",
      });
    });

    test("pair.begin.err validates reason enum", () => {
      expect(
        parseIpcMessage({ t: "pair.begin.err", reason: "already-pending" }),
      ).toEqual({
        t: "pair.begin.err",
        reason: "already-pending",
        message: undefined,
      });
      expect(
        parseIpcMessage({ t: "pair.begin.err", reason: "bogus" }),
      ).toBeNull();
    });

    test("pair.cancel", () => {
      expect(parseIpcMessage({ t: "pair.cancel", pairingId: "p1" })).toEqual({
        t: "pair.cancel",
        pairingId: "p1",
      });
    });

    test("pair.completed accepts null label", () => {
      expect(
        parseIpcMessage({
          t: "pair.completed",
          pairingId: "p1",
          daemonId: "d1",
          label: null,
        }),
      ).toEqual({
        t: "pair.completed",
        pairingId: "p1",
        daemonId: "d1",
        label: null,
      });
    });

    test("pair.completed accepts string label", () => {
      const result = parseIpcMessage({
        t: "pair.completed",
        pairingId: "p1",
        daemonId: "d1",
        label: "phone",
      });
      expect(result?.t).toBe("pair.completed");
      if (result?.t === "pair.completed") {
        expect(result.label).toBe("phone");
      }
    });

    test("pair.completed rejects non-string non-null label", () => {
      expect(
        parseIpcMessage({
          t: "pair.completed",
          pairingId: "p1",
          daemonId: "d1",
          label: 42,
        }),
      ).toBeNull();
    });

    test("pair.cancelled", () => {
      expect(parseIpcMessage({ t: "pair.cancelled", pairingId: "p1" })).toEqual(
        {
          t: "pair.cancelled",
          pairingId: "p1",
        },
      );
    });

    test("pair.error validates reason enum", () => {
      expect(
        parseIpcMessage({
          t: "pair.error",
          pairingId: "p1",
          reason: "kx-decrypt-failed",
        }),
      ).toEqual({
        t: "pair.error",
        pairingId: "p1",
        reason: "kx-decrypt-failed",
        message: undefined,
      });
      expect(
        parseIpcMessage({
          t: "pair.error",
          pairingId: "p1",
          reason: "daemon-id-taken", // valid for begin.err but not for pair.error
        }),
      ).toBeNull();
    });
  });

  describe("pair.remove / pair.rename", () => {
    test("pair.remove parses required daemonId", () => {
      expect(parseIpcMessage({ t: "pair.remove", daemonId: "d1" })).toEqual({
        t: "pair.remove",
        daemonId: "d1",
      });
      expect(parseIpcMessage({ t: "pair.remove" })).toBeNull();
    });

    test("pair.remove.ok requires daemonId and numeric notifiedPeers", () => {
      expect(
        parseIpcMessage({
          t: "pair.remove.ok",
          daemonId: "d1",
          notifiedPeers: 2,
        }),
      ).toEqual({ t: "pair.remove.ok", daemonId: "d1", notifiedPeers: 2 });
      expect(
        parseIpcMessage({
          t: "pair.remove.ok",
          daemonId: "d1",
          notifiedPeers: "2",
        }),
      ).toBeNull();
    });

    test("pair.remove.err validates reason enum", () => {
      expect(
        parseIpcMessage({
          t: "pair.remove.err",
          daemonId: "d1",
          reason: "not-found",
        }),
      ).toEqual({
        t: "pair.remove.err",
        daemonId: "d1",
        reason: "not-found",
        message: undefined,
      });
      expect(
        parseIpcMessage({
          t: "pair.remove.err",
          daemonId: "d1",
          reason: "bogus",
        }),
      ).toBeNull();
    });

    test("pair.rename accepts string or null label", () => {
      expect(
        parseIpcMessage({ t: "pair.rename", daemonId: "d1", label: "Mac" }),
      ).toEqual({ t: "pair.rename", daemonId: "d1", label: "Mac" });
      expect(
        parseIpcMessage({ t: "pair.rename", daemonId: "d1", label: null }),
      ).toEqual({ t: "pair.rename", daemonId: "d1", label: null });
      expect(
        parseIpcMessage({ t: "pair.rename", daemonId: "d1", label: 42 }),
      ).toBeNull();
    });

    test("pair.rename.ok parses full shape", () => {
      expect(
        parseIpcMessage({
          t: "pair.rename.ok",
          daemonId: "d1",
          label: "Mac",
          notifiedPeers: 1,
        }),
      ).toEqual({
        t: "pair.rename.ok",
        daemonId: "d1",
        label: "Mac",
        notifiedPeers: 1,
      });
    });

    test("pair.rename.err validates reason enum", () => {
      expect(
        parseIpcMessage({
          t: "pair.rename.err",
          daemonId: "d1",
          reason: "internal",
          message: "boom",
        }),
      ).toEqual({
        t: "pair.rename.err",
        daemonId: "d1",
        reason: "internal",
        message: "boom",
      });
      expect(
        parseIpcMessage({
          t: "pair.rename.err",
          daemonId: "d1",
          reason: "kx-decrypt-failed",
        }),
      ).toBeNull();
    });
  });

  describe("session.delete", () => {
    test("session.delete parses required sid", () => {
      expect(parseIpcMessage({ t: "session.delete", sid: "s-1" })).toEqual({
        t: "session.delete",
        sid: "s-1",
      });
    });

    test("session.delete rejects missing or non-string sid", () => {
      expect(parseIpcMessage({ t: "session.delete" })).toBeNull();
      expect(parseIpcMessage({ t: "session.delete", sid: 42 })).toBeNull();
    });

    test("session.delete.ok requires sid and boolean wasRunning", () => {
      expect(
        parseIpcMessage({
          t: "session.delete.ok",
          sid: "s-1",
          wasRunning: true,
        }),
      ).toEqual({ t: "session.delete.ok", sid: "s-1", wasRunning: true });
      expect(
        parseIpcMessage({
          t: "session.delete.ok",
          sid: "s-1",
          wasRunning: false,
        }),
      ).toEqual({ t: "session.delete.ok", sid: "s-1", wasRunning: false });
    });

    test("session.delete.ok rejects non-boolean wasRunning", () => {
      expect(
        parseIpcMessage({
          t: "session.delete.ok",
          sid: "s-1",
          wasRunning: "true",
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({ t: "session.delete.ok", sid: "s-1" }),
      ).toBeNull();
    });

    test("session.delete.err validates reason enum", () => {
      expect(
        parseIpcMessage({
          t: "session.delete.err",
          sid: "s-1",
          reason: "not-found",
        }),
      ).toEqual({
        t: "session.delete.err",
        sid: "s-1",
        reason: "not-found",
        message: undefined,
      });
      expect(
        parseIpcMessage({
          t: "session.delete.err",
          sid: "s-1",
          reason: "internal",
          message: "boom",
        }),
      ).toEqual({
        t: "session.delete.err",
        sid: "s-1",
        reason: "internal",
        message: "boom",
      });
      expect(
        parseIpcMessage({
          t: "session.delete.err",
          sid: "s-1",
          reason: "bogus",
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({ t: "session.delete.err", reason: "not-found" }),
      ).toBeNull();
    });
  });

  describe("session.prune", () => {
    test("session.prune parses with numeric olderThanMs", () => {
      expect(
        parseIpcMessage({
          t: "session.prune",
          olderThanMs: 60_000,
          includeRunning: false,
          dryRun: false,
        }),
      ).toEqual({
        t: "session.prune",
        olderThanMs: 60_000,
        includeRunning: false,
        dryRun: false,
      });
    });

    test("session.prune accepts null olderThanMs (all sessions)", () => {
      expect(
        parseIpcMessage({
          t: "session.prune",
          olderThanMs: null,
          includeRunning: true,
          dryRun: true,
        }),
      ).toEqual({
        t: "session.prune",
        olderThanMs: null,
        includeRunning: true,
        dryRun: true,
      });
    });

    test("session.prune rejects missing fields", () => {
      expect(
        parseIpcMessage({
          t: "session.prune",
          includeRunning: false,
          dryRun: false,
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({
          t: "session.prune",
          olderThanMs: 0,
          dryRun: false,
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({
          t: "session.prune",
          olderThanMs: 0,
          includeRunning: false,
        }),
      ).toBeNull();
    });

    test("session.prune rejects wrong field types", () => {
      expect(
        parseIpcMessage({
          t: "session.prune",
          olderThanMs: "1000",
          includeRunning: false,
          dryRun: false,
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({
          t: "session.prune",
          olderThanMs: 0,
          includeRunning: "yes",
          dryRun: false,
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({
          t: "session.prune",
          olderThanMs: 0,
          includeRunning: false,
          dryRun: 1,
        }),
      ).toBeNull();
    });

    test("session.prune.ok parses full shape", () => {
      expect(
        parseIpcMessage({
          t: "session.prune.ok",
          sids: ["a", "b"],
          runningKilled: 1,
          dryRun: false,
        }),
      ).toEqual({
        t: "session.prune.ok",
        sids: ["a", "b"],
        runningKilled: 1,
        dryRun: false,
      });
    });

    test("session.prune.ok rejects non-string array entries", () => {
      expect(
        parseIpcMessage({
          t: "session.prune.ok",
          sids: ["a", 42],
          runningKilled: 0,
          dryRun: false,
        }),
      ).toBeNull();
    });

    test("session.prune.ok rejects missing fields", () => {
      expect(
        parseIpcMessage({
          t: "session.prune.ok",
          sids: [],
          runningKilled: 0,
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({
          t: "session.prune.ok",
          runningKilled: 0,
          dryRun: false,
        }),
      ).toBeNull();
    });

    test("session.prune.err validates reason and partial fields", () => {
      expect(
        parseIpcMessage({
          t: "session.prune.err",
          reason: "internal",
          message: "boom",
          partialSids: ["a"],
          partialRunningKilled: 1,
        }),
      ).toEqual({
        t: "session.prune.err",
        reason: "internal",
        message: "boom",
        partialSids: ["a"],
        partialRunningKilled: 1,
      });
    });

    test("session.prune.err accepts missing optional message", () => {
      expect(
        parseIpcMessage({
          t: "session.prune.err",
          reason: "internal",
          partialSids: [],
          partialRunningKilled: 0,
        }),
      ).toEqual({
        t: "session.prune.err",
        reason: "internal",
        message: undefined,
        partialSids: [],
        partialRunningKilled: 0,
      });
    });

    test("session.prune.err rejects bogus reason and missing partials", () => {
      expect(
        parseIpcMessage({
          t: "session.prune.err",
          reason: "not-found",
          partialSids: [],
          partialRunningKilled: 0,
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({
          t: "session.prune.err",
          reason: "internal",
          partialRunningKilled: 0,
        }),
      ).toBeNull();
      expect(
        parseIpcMessage({
          t: "session.prune.err",
          reason: "internal",
          partialSids: [],
        }),
      ).toBeNull();
    });
  });
});
