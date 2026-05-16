#!/usr/bin/env bun
//
// Dog-fooding fixture: pair the locally-running RN Web build with the local
// `tp` daemon **once**, then reuse the resulting browser storage state on
// every subsequent dev session.
//
// What it does:
//   1. Spawns `tp pair new --label "dev-web"` and captures the pairing URL
//      (`tp://p?d=...`) from stdout. `tp pair new` blocks until the
//      frontend completes the X25519 kx, which is exactly what we want — we
//      drive the frontend ourselves with Playwright.
//   2. Launches Playwright (chromium), navigates to /pairing on the local
//      Expo web dev server, pastes the URL, and clicks Connect. Waits for
//      `Paired ...` on the CLI side (which closes the child process).
//   3. Dumps `browser.contexts()[0].storageState()` to
//      `apps/app/.dev-pairing-state.json` (gitignored).
//
// On the daemon side the pairing is persistent (store DB), so it survives
// daemon restarts. On the browser side we just reload the same storage
// state every time we open `localhost:8081`. As long as we don't run
// `tp pair delete` or wipe the daemon store, the same pairing keeps working
// across both sides until the relay's resume secret rotates or kx keys
// drift.
//
// Usage:
//   pnpm dev:app              # in one terminal — Expo web on :8081
//   bun run scripts/dev-pair.ts   # in another — runs once
//   # then open chromium with the dumped storage state, or load it from
//   # Playwright in any QA flow.

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env.TP_DEV_WEB_URL ?? "http://localhost:8081";
const STORAGE_PATH = resolve(
  __dirname,
  "..",
  "apps/app/.dev-pairing-state.json",
);
const TP_BIN = process.env.TP ?? "tp";
const LABEL = process.env.TP_DEV_PAIR_LABEL ?? "dev-web";
const PAIRING_URL_RE = /^(tp:\/\/p\?d=[^\s]+)/;
const PAIRED_RE = /Paired /;

async function captureFirstPairingUrl(): Promise<{
  url: string;
  proc: ReturnType<typeof spawn>;
  paired: Promise<void>;
}> {
  const proc = spawn(TP_BIN, ["pair", "new", "--label", LABEL], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let urlResolve: (u: string) => void;
  let urlReject: (e: Error) => void;
  const urlPromise = new Promise<string>((res, rej) => {
    urlResolve = res;
    urlReject = rej;
  });
  let pairedResolve: () => void;
  let pairedReject: (e: Error) => void;
  const pairedPromise = new Promise<void>((res, rej) => {
    pairedResolve = res;
    pairedReject = rej;
  });
  proc.stdout?.setEncoding("utf8");
  let buf = "";
  proc.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    process.stdout.write(chunk);
    let nl: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line walker
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const m = line.match(PAIRING_URL_RE);
      if (m) urlResolve(m[1]);
      if (PAIRED_RE.test(line)) pairedResolve();
    }
  });
  proc.on("error", (err) => {
    urlReject(err);
    pairedReject(err);
  });
  proc.on("exit", (code, signal) => {
    if (code !== 0) {
      const err = new Error(
        `tp pair new exited ${code ?? signal ?? "unknown"}`,
      );
      urlReject(err);
      pairedReject(err);
    }
  });
  const url = await urlPromise;
  return { url, proc, paired: pairedPromise };
}

async function main() {
  console.log(`[dev-pair] starting \`${TP_BIN} pair new\`...`);
  const { url, proc, paired } = await captureFirstPairingUrl();
  console.log(`[dev-pair] captured pairing URL (${url.slice(0, 24)}...)`);
  console.log(`[dev-pair] opening ${WEB_URL}/pairing in chromium...`);

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${WEB_URL}/pairing`, { waitUntil: "networkidle" });

    const textarea = page.getByTestId("pairing-input");
    await textarea.fill(url);

    const connect = page.getByTestId("pairing-connect");
    await connect.click();

    console.log("[dev-pair] waiting for daemon-side pair.completed...");
    await paired;
    console.log("[dev-pair] pairing completed — waiting for app to redirect.");

    await page.waitForURL((u) => !u.pathname.startsWith("/pairing"), {
      timeout: 30_000,
    });

    await mkdir(dirname(STORAGE_PATH), { recursive: true });
    await context.storageState({ path: STORAGE_PATH });
    console.log(`[dev-pair] storage state saved to ${STORAGE_PATH}`);
  } finally {
    await browser.close();
    if (!proc.killed) proc.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error("[dev-pair] failed:", err);
  process.exit(1);
});
