# QA Audit + User Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all remaining test/type failures, create Getting Started guide with screenshots, and write FAQ document.

**Architecture:** Three independent workstreams — (A) bug fixes for test/type failures, (B) Getting Started guide with Playwright-captured screenshots, (C) FAQ from codebase analysis. Each can be done in parallel worktrees.

**Tech Stack:** Bun test, TypeScript, Playwright (screenshots), Markdown docs

---

## Workstream A: QA Bug Fixes

### Task A1: Fix expo-notifications type error

**Files:**
- Modify: `apps/app/src/hooks/use-push-notifications.ts:13,46,64`
- Modify: `apps/app/package.json`

The `expo-notifications` package is referenced but not installed. The Push Notifications PR (#52) added the hook but the dependency wasn't properly installed.

- [ ] **Step 1: Install expo-notifications**

```bash
cd apps/app && npx expo install expo-notifications
```

- [ ] **Step 2: Fix implicit any on line 64**

Read `apps/app/src/hooks/use-push-notifications.ts` and add proper type annotation to the `response` parameter in the notification response listener callback. The type should be `Notifications.NotificationResponse`.

- [ ] **Step 3: Verify type check passes**

```bash
pnpm type-check:all
```

Expected: All 5 packages pass with no errors.

- [ ] **Step 4: Verify tests still pass**

```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
```

Expected: Same or better pass count (330+).

- [ ] **Step 5: Commit**

```bash
git add apps/app/package.json apps/app/src/hooks/use-push-notifications.ts pnpm-lock.yaml
git commit -m "fix: install expo-notifications and fix type errors"
```

### Task A2: Fix worktree-manager tests failing from repo root

**Files:**
- Modify: `packages/daemon/src/worktree/worktree-manager.ts`
- Modify: `packages/daemon/src/worktree/worktree-manager.test.ts`

The `list()` method returns empty arrays when `bun test` runs from repo root. Root cause: `execFileSync` uses `process.cwd()` (repo root) instead of the test's temp repo. The `-C repoRoot` flag should handle this, but there may be a symlink resolution issue (`/tmp/` vs `/private/tmp/` on macOS).

- [ ] **Step 1: Add diagnostic logging to identify the actual failure**

In `worktree-manager.test.ts`, add a temporary debug test at the top of the describe block:

```typescript
test("debug: git worktree list output", async () => {
  const { execFileSync } = await import("child_process");
  const result = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  console.log("repoDir:", repoDir);
  console.log("porcelain output:", JSON.stringify(result));
  console.log("parsed length:", result.split("\n").length);
  expect(result).toContain("worktree ");
});
```

- [ ] **Step 2: Run from repo root to capture output**

```bash
bun test packages/daemon/src/worktree/worktree-manager.test.ts 2>&1 | head -30
```

Expected: Debug output showing actual git worktree list output and paths.

- [ ] **Step 3: Fix based on findings**

Most likely fix — `execFileSync` in `gitOutput()` needs explicit `cwd` option to match the repo being tested, OR the macOS `/tmp` → `/private/tmp` symlink causes path mismatch in the porcelain output parsing. The `list()` method's path comparison should use `fs.realpathSync()`.

Read the current `gitOutput` function and verify it passes `cwd`. If not, add it:

```typescript
function gitOutput(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    stdio: ["ignore", "pipe", "ignore"],
    ...(cwd && { cwd }),
  }).toString();
}
```

And update `list()` to call `gitOutput([...], this.repoRoot)`.

- [ ] **Step 4: Remove debug test, verify all pass from root**

```bash
bun test packages/daemon/src/worktree 2>&1 | tail -5
```

Expected: All pass (7/7 worktree-manager + worktree-ws tests).

- [ ] **Step 5: Run full test suite**

```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
```

Expected: 337/337 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/worktree/worktree-manager.ts packages/daemon/src/worktree/worktree-manager.test.ts
git commit -m "fix: resolve worktree test failures when running from repo root"
```

---

## Workstream B: Getting Started Guide

### Task B1: Capture screenshots with Playwright

**Files:**
- Create: `docs/screenshots/capture.ts` (Playwright screenshot script)
- Create: `docs/screenshots/*.png` (output images)

Use Playwright to capture consistent screenshots of the web app for documentation.

- [ ] **Step 1: Build web frontend**

```bash
cd apps/app && npx expo export --platform web
```

- [ ] **Step 2: Create screenshot capture script**

Create `docs/screenshots/capture.ts`:

```typescript
import { chromium } from "@playwright/test";

const BASE = "http://localhost:8081";

async function capture() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  const page = await context.newPage();

  // 1. Sessions empty state
  await page.goto(BASE);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "docs/screenshots/01-sessions-empty.png" });

  // 2. Settings tab
  await page.getByTestId("tab-settings").click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "docs/screenshots/02-settings.png" });

  // 3. Diagnostics panel
  await page.getByText("Diagnostics").click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "docs/screenshots/03-diagnostics.png" });

  await browser.close();
  console.log("Screenshots captured in docs/screenshots/");
}

capture();
```

- [ ] **Step 3: Start server, run script, stop server**

```bash
npx serve apps/app/dist -p 8081 &
SERVER_PID=$!
sleep 2
npx playwright install chromium
bun run docs/screenshots/capture.ts
kill $SERVER_PID
```

- [ ] **Step 4: Capture CLI screenshots**

Use terminal recording or `tp` commands and take manual terminal screenshots. At minimum, capture outputs of:

```bash
tp version
tp --help
tp pair
tp status
tp doctor
```

Save terminal output as code blocks in the Getting Started guide (no image needed for CLI — text is better).

- [ ] **Step 5: Commit screenshots**

```bash
git add docs/screenshots/
git commit -m "docs: capture app screenshots for getting started guide"
```

### Task B2: Write Getting Started guide

**Files:**
- Create: `docs/GETTING-STARTED.md`

- [ ] **Step 1: Write the document**

Create `docs/GETTING-STARTED.md` with this structure:

```markdown
# Getting Started with Teleprompter

Teleprompter lets you control Claude Code sessions remotely from your phone or any browser.

## Prerequisites

- macOS or Linux (Windows support is experimental)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- Bun v1.3.6+ (for development)

## Quick Install (CLI)

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
\`\`\`

This installs the `tp` binary to `~/.local/bin/tp`.

Verify:
\`\`\`bash
tp version
# tp v0.1.5
\`\`\`

## Step 1: Run Your First Session

\`\`\`bash
tp -p "explain what this project does"
\`\`\`

This wraps Claude Code with teleprompter's session management. All Claude flags work:

\`\`\`bash
tp --model sonnet -p "fix the bug in auth.ts"
tp -c  # continue last session
\`\`\`

## Step 2: Check Status

\`\`\`bash
tp status
\`\`\`

Shows all sessions with their state (running/stopped), sequence numbers, and age.

## Step 3: Connect Your Phone

### 3a. Generate pairing QR code

\`\`\`bash
tp pair
\`\`\`

This displays a QR code and pairing JSON. The data includes:
- Pairing secret (for E2E encryption)
- Daemon public key
- Relay URL (`wss://relay.tpmt.dev`)

### 3b. Open the app

- **Web**: Visit [tpmt.dev](https://tpmt.dev)
- **iOS**: Download from TestFlight (link TBD)
- **Android**: Download from Google Play Internal (link TBD)

### 3c. Scan or paste

- On iOS/Android: Tap "Scan QR Code" and scan the terminal QR
- On Web: Go to Settings > Pair, paste the JSON data

![Sessions empty state](screenshots/01-sessions-empty.png)

### 3d. Verify connection

After pairing, you'll see your sessions appear in the app. The connection badge shows green when connected.

## Step 4: Auto-start Daemon

To keep the daemon running across reboots:

\`\`\`bash
tp daemon install
\`\`\`

This registers a system service:
- **macOS**: launchd (`~/Library/LaunchAgents/dev.tpmt.daemon.plist`)
- **Linux**: systemd user service (`teleprompter-daemon.service`)

To remove:
\`\`\`bash
tp daemon uninstall
\`\`\`

## Step 5: Diagnostics

If something isn't working:

\`\`\`bash
tp doctor
\`\`\`

Checks: Bun, Node.js, Claude CLI, Git, daemon socket, pairing data, relay connectivity, E2EE self-test.

![Diagnostics panel](screenshots/03-diagnostics.png)

## Using the App

### Chat Tab
View Claude's responses as structured cards. Send messages from your phone.

### Terminal Tab
Full terminal emulator (xterm.js) showing Claude's PTY output — colors, vim, prompts all work.

### Settings
- **Theme**: Dark / Light / System
- **Fonts**: Chat font, code font, terminal font, font size
- **Voice**: OpenAI API key for voice input (Web only)
- **Diagnostics**: Connection status, E2EE self-test, session details

![Settings](screenshots/02-settings.png)

## CLI Reference

| Command | Description |
|---------|-------------|
| `tp [flags] [claude args]` | Run claude through teleprompter |
| `tp pair` | Generate pairing QR code |
| `tp status` | Show sessions & daemon status |
| `tp logs [session]` | Tail live session output |
| `tp doctor` | Diagnose environment |
| `tp upgrade` | Upgrade tp + Claude Code |
| `tp daemon install` | Auto-start on login |
| `tp -- <claude args>` | Forward directly to claude |

## Troubleshooting

See [FAQ](FAQ.md) for common issues.
```

- [ ] **Step 2: Verify all screenshot paths are correct**

Check that each `![...]` image reference matches a file in `docs/screenshots/`.

- [ ] **Step 3: Commit**

```bash
git add docs/GETTING-STARTED.md
git commit -m "docs: add Getting Started guide with screenshots"
```

---

## Workstream C: FAQ Document

### Task C1: Write FAQ

**Files:**
- Create: `docs/FAQ.md`

- [ ] **Step 1: Analyze common issues from codebase**

Review these sources for FAQ material:
- `TODO.md` known issues and limitations
- `apps/cli/src/commands/doctor.ts` — what it checks = what can go wrong
- `apps/app/src/components/DiagnosticsPanel.tsx` — what users can self-test
- `packages/daemon/src/transport/` — connection failure modes
- GitHub issues (`gh issue list`)

- [ ] **Step 2: Write the FAQ document**

Create `docs/FAQ.md`:

```markdown
# Frequently Asked Questions

## Installation

### Q: How do I install tp?

```bash
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
```

Or download the binary directly from [GitHub Releases](https://github.com/DaveDev42/teleprompter/releases).

### Q: Which platforms are supported?

- **CLI (`tp`)**: macOS (arm64, x64), Linux (x64, arm64), Windows (experimental)
- **App**: iOS (TestFlight), Android (Internal Track), Web ([tpmt.dev](https://tpmt.dev))

### Q: Do I need Claude Code installed?

Yes. `tp` wraps Claude Code, so `claude` must be in your PATH. Install it from [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code).

---

## Connection & Pairing

### Q: How do I connect my phone to my computer?

Run `tp pair` on your computer, then scan the QR code or paste the JSON in the app. See the [Getting Started guide](GETTING-STARTED.md).

### Q: My phone can't connect — what should I check?

1. Run `tp doctor` to verify your environment
2. Check that the relay is reachable: the doctor output shows relay connectivity
3. Ensure your daemon is running: `tp status`
4. Check the Diagnostics panel in the app (Settings > Diagnostics)

### Q: Can I connect multiple phones to one computer?

Yes. Each device gets independent E2E encryption keys. Run `tp pair` for each device.

### Q: Can I connect one phone to multiple computers?

Yes. Each computer appears as a separate daemon in the app's Daemons tab.

### Q: Is my data encrypted?

Yes, end-to-end. The relay server only sees encrypted ciphertext (zero-trust architecture). Encryption uses X25519 key exchange + XChaCha20-Poly1305.

---

## Sessions

### Q: Where are session recordings stored?

In `~/.local/share/teleprompter/vault/` as SQLite databases. Each session has an append-only record store.

### Q: How do I export a session?

In the app, open a session > tap the drawer menu > Export. Supports Markdown and JSON formats.

### Q: Sessions are piling up — how do I clean them?

The daemon auto-prunes sessions older than 7 days by default. To change:

```bash
tp daemon start --prune-ttl 3    # 3 days
TP_PRUNE_TTL_DAYS=14 tp daemon start  # 14 days via env
tp daemon start --no-prune       # disable auto-cleanup
```

### Q: How do I restart a failed session?

In the app, open the session drawer and tap "Restart".

---

## Daemon

### Q: The daemon isn't starting — what do I do?

```bash
tp doctor        # check environment
tp daemon start  # start manually in foreground (see logs)
```

Common issues:
- Port 7080 already in use (another tp instance)
- Claude CLI not found (install it first)

### Q: How do I auto-start the daemon on login?

```bash
tp daemon install    # registers launchd (macOS) or systemd (Linux)
tp daemon uninstall  # removes auto-start
```

### Q: How do I check daemon logs?

```bash
tp logs             # tail all sessions
tp logs <session>   # tail specific session
```

If using launchd/systemd:
- macOS: `~/.local/share/teleprompter/logs/daemon.log`
- Linux: `journalctl --user -u teleprompter-daemon`

---

## Voice

### Q: How does voice input work?

Voice uses the OpenAI Realtime API. Enter your API key in Settings > Voice > OpenAI API Key.

### Q: Voice doesn't work on my iPhone/Android

Voice is currently Web-only. Native mobile voice support is planned.

---

## Upgrading

### Q: How do I upgrade tp?

```bash
tp upgrade
```

This downloads the latest binary with SHA-256 checksum verification, backs up the current binary, and restarts the daemon if running as a service.

### Q: How do I upgrade Claude Code through tp?

```bash
tp upgrade --claude
# or directly:
tp -- update
```

---

## Development

### Q: How do I set up the development environment?

```bash
git clone https://github.com/DaveDev42/teleprompter.git
cd teleprompter
pnpm install
pnpm dev:app        # Start Expo web dev server
```

### Q: How do I run tests?

```bash
pnpm test           # Unit tests (Bun)
pnpm test:e2e       # E2E tests (Playwright, requires web build)
pnpm type-check:all # Type check all packages
pnpm lint           # Biome lint + format check
```

### Q: How do I build the tp binary locally?

```bash
pnpm build:cli:local  # Current platform
pnpm build:cli        # All platforms (darwin/linux × arm64/x64)
```
```

- [ ] **Step 3: Commit**

```bash
git add docs/FAQ.md
git commit -m "docs: add FAQ document"
```

---

## Workstream D: Final Verification

### Task D1: Full QA pass after all fixes

- [ ] **Step 1: Run full test suite**

```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
```

Expected: 337/337 pass, 0 fail.

- [ ] **Step 2: Run type checks**

```bash
pnpm type-check:all
```

Expected: All pass, no errors.

- [ ] **Step 3: Run lint**

```bash
npx biome ci .
```

Expected: No errors.

- [ ] **Step 4: Build web and run E2E**

```bash
cd apps/app && npx expo export --platform web && cd ../..
npx serve apps/app/dist -p 8081 &
npx playwright test --project=ci
kill %1
```

Expected: All CI tests pass.

- [ ] **Step 5: Verify docs render correctly**

Open `docs/GETTING-STARTED.md` and `docs/FAQ.md` in a markdown viewer. Verify:
- All image links resolve
- Code blocks are properly formatted
- No broken internal links

- [ ] **Step 6: Update README.md with doc links**

Add to README.md under a "Documentation" section:

```markdown
## Documentation

- [Getting Started](docs/GETTING-STARTED.md) — Installation, pairing, and first session
- [FAQ](docs/FAQ.md) — Common questions and troubleshooting
- [Architecture](ARCHITECTURE.md) — System design and protocol details
```

- [ ] **Step 7: Final commit**

```bash
git add README.md
git commit -m "docs: add documentation links to README"
```
