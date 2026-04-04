import {
  decrypt,
  deriveSessionKeys,
  encrypt,
  generateKeyPair,
} from "@teleprompter/protocol";

/**
 * Verify E2EE crypto primitives work correctly.
 * Tests key exchange, bidirectional encrypt/decrypt, and wrong-key rejection.
 * This is a local crypto self-test, not a relay round-trip verification.
 *
 * Returns true if all checks pass.
 */
export async function verifyE2EECrypto(
  log: (line: string) => void = console.log,
): Promise<boolean> {
  const daemonKp = await generateKeyPair();
  const frontendKp = await generateKeyPair();

  const daemonKeys = await deriveSessionKeys(
    daemonKp,
    frontendKp.publicKey,
    "daemon",
  );
  const frontendKeys = await deriveSessionKeys(
    frontendKp,
    daemonKp.publicKey,
    "frontend",
  );

  const testPayload = new TextEncoder().encode(
    `E2EE verification test ${Date.now()}`,
  );
  const originalText = new TextDecoder().decode(testPayload);

  let passed = true;

  try {
    // Daemon encrypts -> Frontend decrypts
    const ciphertext = await encrypt(testPayload, daemonKeys.tx);
    const decrypted = await decrypt(ciphertext, frontendKeys.rx);
    const decryptedText = new TextDecoder().decode(decrypted);

    if (decryptedText === originalText) {
      log("  daemon → frontend: OK");
    } else {
      log("  daemon → frontend: FAIL (mismatch)");
      passed = false;
    }

    // Frontend encrypts -> Daemon decrypts
    const ciphertext2 = await encrypt(testPayload, frontendKeys.tx);
    const decrypted2 = await decrypt(ciphertext2, daemonKeys.rx);
    const decryptedText2 = new TextDecoder().decode(decrypted2);

    if (decryptedText2 === originalText) {
      log("  frontend → daemon: OK");
    } else {
      log("  frontend → daemon: FAIL (mismatch)");
      passed = false;
    }

    // Verify wrong key is rejected
    const wrongKp = await generateKeyPair();
    const wrongKeys = await deriveSessionKeys(
      wrongKp,
      frontendKp.publicKey,
      "daemon",
    );
    try {
      await decrypt(ciphertext, wrongKeys.rx);
      log("  relay isolation:   FAIL (wrong key decrypted!)");
      passed = false;
    } catch {
      log("  relay isolation:   OK (wrong key rejected)");
    }
  } catch (err) {
    log(`  E2EE verification: FAILED (${err})`);
    passed = false;
  }

  return passed;
}
