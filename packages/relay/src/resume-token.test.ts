import { describe, expect, test } from "bun:test";
import { ResumeTokenSigner } from "./resume-token";

const SECRET = "x".repeat(64);

describe("ResumeTokenSigner", () => {
  test("issues and verifies a token round-trip", () => {
    const signer = new ResumeTokenSigner({ secret: SECRET });
    const { token, expiresAt } = signer.issue({
      role: "daemon",
      daemonId: "d-1",
    });
    const payload = signer.verify(token);
    expect(payload).not.toBeNull();
    expect(payload?.role).toBe("daemon");
    expect(payload?.daemonId).toBe("d-1");
    expect(payload?.frontendId).toBeUndefined();
    expect(payload?.expiresAt).toBe(expiresAt);
  });

  test("preserves frontendId for frontend tokens", () => {
    const signer = new ResumeTokenSigner({ secret: SECRET });
    const { token } = signer.issue({
      role: "frontend",
      daemonId: "d-1",
      frontendId: "fe-abc",
    });
    const payload = signer.verify(token);
    expect(payload?.role).toBe("frontend");
    expect(payload?.frontendId).toBe("fe-abc");
  });

  test("rejects expired tokens", () => {
    const signer = new ResumeTokenSigner({ secret: SECRET });
    const { token } = signer.issue({
      role: "daemon",
      daemonId: "d-1",
      expiresAt: Date.now() - 1000,
    });
    expect(signer.verify(token)).toBeNull();
  });

  test("rejects tokens signed with a different secret", () => {
    const a = new ResumeTokenSigner({ secret: SECRET });
    const b = new ResumeTokenSigner({ secret: "y".repeat(64) });
    const { token } = a.issue({ role: "daemon", daemonId: "d-1" });
    expect(b.verify(token)).toBeNull();
  });

  test("rejects tampered tokens", () => {
    const signer = new ResumeTokenSigner({ secret: SECRET });
    const { token } = signer.issue({ role: "daemon", daemonId: "d-1" });
    const tampered = `${token.slice(0, -2)}xx`;
    expect(signer.verify(tampered)).toBeNull();
  });

  test("rejects malformed tokens", () => {
    const signer = new ResumeTokenSigner({ secret: SECRET });
    expect(signer.verify("")).toBeNull();
    expect(signer.verify("nope")).toBeNull();
    expect(signer.verify("a.b.c")).toBeNull();
  });

  test("falls back to ephemeral secret when none provided", () => {
    const signer = new ResumeTokenSigner();
    expect(signer.ephemeral).toBe(true);
    // Still issues working tokens — they just don't survive a process restart.
    const { token } = signer.issue({ role: "daemon", daemonId: "d-1" });
    expect(signer.verify(token)).not.toBeNull();
  });

  test("rejects too-short secrets and falls back to ephemeral", () => {
    const signer = new ResumeTokenSigner({ secret: "short" });
    expect(signer.ephemeral).toBe(true);
  });
});
