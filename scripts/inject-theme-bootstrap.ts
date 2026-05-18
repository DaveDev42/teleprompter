#!/usr/bin/env bun
// Injects an inline theme bootstrap <script> into apps/app/dist/index.html so
// the persisted dark/light preference is applied to <html> on the very first
// paint, before the React bundle loads. Without this, the page renders with
// light CSS variables and snaps to dark a few hundred ms later when the
// async theme store finishes loading — a textbook FOUC.
//
// We do this post-export because the app builds as an Expo Router SPA
// (web.output is not "static"), so the +html.tsx convention is not honored —
// Expo emits one minimal index.html and serves every route through it.
//
// Mirrors apps/app/src/lib/secure-storage.ts (web: `tp_${key}` localStorage)
// and apps/app/src/stores/theme-store.ts (key `app_theme`, values
// "dark" | "light" | "system", default "system" resolves via media query).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HTML_PATH = join(
  import.meta.dir,
  "..",
  "apps",
  "app",
  "dist",
  "index.html",
);

const MARKER = "tp-theme-bootstrap";

const BOOTSTRAP = `<script id="${MARKER}">(function(){try{var s=localStorage.getItem('tp_app_theme');var d=s==='dark'||((!s||s==='system')&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d){document.documentElement.classList.add('dark');}}catch(e){}})();</script>`;

if (!existsSync(HTML_PATH)) {
  console.error(`inject-theme-bootstrap: ${HTML_PATH} not found`);
  process.exit(1);
}

const html = readFileSync(HTML_PATH, "utf8");

if (html.includes(`id="${MARKER}"`)) {
  console.log("inject-theme-bootstrap: already injected, skipping");
  process.exit(0);
}

const headOpen = html.indexOf("<head>");
if (headOpen === -1) {
  console.error("inject-theme-bootstrap: <head> not found in index.html");
  process.exit(1);
}

const insertAt = headOpen + "<head>".length;
const patched = html.slice(0, insertAt) + BOOTSTRAP + html.slice(insertAt);

writeFileSync(HTML_PATH, patched);
console.log(`inject-theme-bootstrap: patched ${HTML_PATH}`);
