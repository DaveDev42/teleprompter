/**
 * Long-running stability soak (TODO.md "Long-running 안정성 (1시간 soak)").
 *
 * Measures four things over a configurable duration (default 1h):
 *   1. Daemon RSS trend — samples the live `tp daemon` process's resident set
 *      size (read from the daemon-lock pid file) on a fixed interval, so a
 *      slow leak shows up as a rising line instead of a single snapshot.
 *   2. Relay reconnect storm — opens and closes a daemon-role WebSocket N
 *      times per round, recording success rate and connect latency. Catches
 *      fd/handle leaks and auth-path regressions under churn.
 *   3. Frame round-trip latency — daemon → relay → frontend for N frames per
 *      round, reporting p50/p95/max. Catches cache/eviction or backpressure
 *      drift that only appears after the relay has been up for a while.
 *   4. WS idle/wake cycle — holds a connection idle past the idle window, then
 *      wakes it with a frame round-trip, repeated a few times. Guards the
 *      "idle close only when truly idle" invariant (daemon ping keeps it alive).
 *
 * The relay runs in-process (isolated RelayServer on an ephemeral port) so the
 * frame/reconnect/idle measurements don't perturb the real dogfood relay. The
 * RSS sample reads whatever `tp daemon` is already running locally — it does
 * NOT spawn or load a daemon, so the trend reflects real idle/usage memory.
 *
 * Usage:
 *   bun run scripts/soak.ts                  # 1h, default cadence
 *   bun run scripts/soak.ts --minutes 5      # short smoke run
 *   bun run scripts/soak.ts --minutes 60 --round-interval 30 \
 *     --reconnects 100 --frames 100 --json out.json
 *
 * Flags:
 *   --minutes <n>          total soak duration (default 60)
 *   --round-interval <s>   seconds between measurement rounds (default 60)
 *   --reconnects <n>       reconnect cycles per round (default 100)
 *   --frames <n>           frames per round-trip measurement (default 100)
 *   --idle-cycles <n>      idle/wake cycles in the final idle phase (default 5)
 *   --idle-hold <s>        seconds to hold idle per cycle (default 95, > relay
 *                          idleTimeout 90s, to actually exercise the boundary)
 *   --json <path>          write the full sample series as JSON
 *
 * Exit code is non-zero if any hard failure is observed (a reconnect that never
 * connects, a round-trip that drops frames, an idle cycle that the wake frame
 * can't traverse). RSS growth is reported but never fails the run on its own —
 * a threshold there would be guesswork; the trend line is the deliverable.
 */

import {
  getDaemonLockPath,
  readDaemonLockPid,
} from "../packages/daemon/src/daemon-lock";
import { RelayServer } from "../packages/relay/src/relay-server";

// ── CLI args ──

interface Args {
  minutes: number;
  roundInterval: number;
  reconnects: number;
  frames: number;
  idleCycles: number;
  idleHold: number;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    minutes: 60,
    roundInterval: 60,
    reconnects: 100,
    frames: 100,
    idleCycles: 5,
    idleHold: 95,
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case "--minutes":
        a.minutes = Number(val);
        i++;
        break;
      case "--round-interval":
        a.roundInterval = Number(val);
        i++;
        break;
      case "--reconnects":
        a.reconnects = Number(val);
        i++;
        break;
      case "--frames":
        a.frames = Number(val);
        i++;
        break;
      case "--idle-cycles":
        a.idleCycles = Number(val);
        i++;
        break;
      case "--idle-hold":
        a.idleHold = Number(val);
        i++;
        break;
      case "--json":
        a.json = val ?? null;
        i++;
        break;
      default:
        if (flag.startsWith("--")) {
          console.error(`Unknown flag: ${flag}`);
          process.exit(2);
        }
    }
  }
  return a;
}

// ── helpers ──

const DAEMON_ID = "soak-daemon";
const TOKEN = "soak-token";

/** Resident set size (KB) of a pid via macOS/Linux `ps`. -1 if gone. */
function rssKb(pid: number): number {
  const r = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
  if (r.exitCode !== 0) return -1;
  const out = r.stdout.toString().trim();
  const n = Number.parseInt(out, 10);
  return Number.isNaN(n) ? -1 : n;
}

/**
 * Resolve the live `tp daemon` pid for RSS sampling. Prefers the daemon-lock
 * pid file, but a launchd/systemd-managed daemon may run with a different
 * XDG_RUNTIME_DIR than this script (so the lock path won't match) — fall back
 * to `pgrep -f "tp daemon start"`, which finds the dogfood service process.
 * Returns null when no live daemon is found.
 */
function resolveDaemonPid(): number | null {
  const fromLock = readDaemonLockPid(getDaemonLockPath());
  if (fromLock && rssKb(fromLock) > 0) return fromLock;

  const r = Bun.spawnSync(["pgrep", "-f", "tp daemon start"]);
  if (r.exitCode !== 0) return null;
  // pgrep may return several pids (one per line); take the first live one.
  for (const line of r.stdout.toString().trim().split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isNaN(pid) && rssKb(pid) > 0) return pid;
  }
  return null;
}

function now(): number {
  return Bun.nanoseconds() / 1e6; // ms, monotonic
}

function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const t = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
}

function authDaemon(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      t: "relay.auth",
      role: "daemon",
      daemonId: DAEMON_ID,
      token: TOKEN,
      v: 2,
    }),
  );
}

function authFrontend(ws: WebSocket, frontendId: string): void {
  ws.send(
    JSON.stringify({
      t: "relay.auth",
      role: "frontend",
      daemonId: DAEMON_ID,
      token: TOKEN,
      v: 2,
      frontendId,
    }),
  );
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

// ── measurement rounds ──

interface ReconnectResult {
  attempts: number;
  ok: number;
  failed: number;
  connectMsP50: number;
  connectMsP95: number;
  connectMsMax: number;
}

/** Open+auth+close a daemon-role socket `attempts` times, timing each open. */
async function measureReconnect(
  port: number,
  attempts: number,
): Promise<ReconnectResult> {
  const latencies: number[] = [];
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < attempts; i++) {
    const t0 = now();
    try {
      const ws = await openWs(port);
      latencies.push(now() - t0);
      authDaemon(ws);
      ws.close();
      ok++;
    } catch {
      failed++;
    }
    // small gap so we churn rather than burst — closer to real reconnect storm
    await Bun.sleep(2);
  }
  latencies.sort((x, y) => x - y);
  return {
    attempts,
    ok,
    failed,
    connectMsP50: quantile(latencies, 0.5),
    connectMsP95: quantile(latencies, 0.95),
    connectMsMax: latencies.length
      ? latencies[latencies.length - 1]
      : Number.NaN,
  };
}

interface RoundTripResult {
  sent: number;
  received: number;
  rttMsP50: number;
  rttMsP95: number;
  rttMsMax: number;
}

/**
 * Stand up a daemon socket + frontend socket, publish `count` frames, and
 * measure each frame's daemon→relay→frontend round-trip. The frame `ct`
 * carries the send timestamp (relay forwards ciphertext opaquely, so we can
 * stash anything there) and a sequence the frontend echoes back via timing.
 */
async function measureRoundTrip(
  port: number,
  count: number,
): Promise<RoundTripResult> {
  const sid = "soak-rt";
  const daemon = await openWs(port);
  authDaemon(daemon);
  const frontend = await openWs(port);
  authFrontend(frontend, "fe-soak");
  await Bun.sleep(80); // let auth settle
  frontend.send(JSON.stringify({ t: "relay.sub", sid }));
  await Bun.sleep(50);

  const sendTimes = new Array<number>(count);
  const rtts: number[] = [];
  let received = 0;

  frontend.onmessage = (e) => {
    let msg: { t?: string; seq?: number };
    try {
      msg = JSON.parse(e.data as string);
    } catch {
      return;
    }
    if (msg.t === "relay.frame" && typeof msg.seq === "number") {
      const sentAt = sendTimes[msg.seq];
      if (sentAt !== undefined) {
        rtts.push(now() - sentAt);
        received++;
      }
    }
  };

  for (let i = 0; i < count; i++) {
    sendTimes[i] = now();
    daemon.send(
      JSON.stringify({
        t: "relay.pub",
        sid,
        ct: `soak-${i}`, // opaque to relay
        seq: i,
      }),
    );
    // tiny spacing keeps us under the per-client rate limit (500/s default)
    if (i % 50 === 49) await Bun.sleep(5);
  }

  // drain
  for (let i = 0; i < 300 && received < count; i++) {
    await Bun.sleep(10);
  }

  daemon.close();
  frontend.close();
  rtts.sort((x, y) => x - y);
  return {
    sent: count,
    received,
    rttMsP50: quantile(rtts, 0.5),
    rttMsP95: quantile(rtts, 0.95),
    rttMsMax: rtts.length ? rtts[rtts.length - 1] : Number.NaN,
  };
}

interface IdleCycleResult {
  cycle: number;
  heldSeconds: number;
  wokeOk: boolean;
  wakeRttMs: number;
}

/**
 * Hold a daemon+frontend pair open and idle for `holdSeconds` (past the relay
 * idleTimeout of 90s), then prove the connection still works by pushing one
 * frame and confirming it traverses. With no traffic the relay may close idle
 * sockets — this asserts that a still-active pair (we keep the sockets open,
 * just don't send) survives, and that a wake frame round-trips afterward.
 */
async function measureIdleCycle(
  port: number,
  cycle: number,
  holdSeconds: number,
): Promise<IdleCycleResult> {
  const sid = "soak-idle";
  const daemon = await openWs(port);
  authDaemon(daemon);
  const frontend = await openWs(port);
  authFrontend(frontend, "fe-idle");
  await Bun.sleep(80);
  frontend.send(JSON.stringify({ t: "relay.sub", sid }));
  await Bun.sleep(50);

  let wokeOk = false;
  let wakeRtt = Number.NaN;
  let wakeSentAt = 0;
  frontend.onmessage = (e) => {
    let msg: { t?: string; seq?: number };
    try {
      msg = JSON.parse(e.data as string);
    } catch {
      return;
    }
    if (msg.t === "relay.frame" && msg.seq === 999) {
      wakeRtt = now() - wakeSentAt;
      wokeOk = true;
    }
  };

  // idle hold — keep sockets open but send nothing
  await Bun.sleep(holdSeconds * 1000);

  // wake
  wakeSentAt = now();
  daemon.send(JSON.stringify({ t: "relay.pub", sid, ct: "wake", seq: 999 }));
  for (let i = 0; i < 200 && !wokeOk; i++) {
    await Bun.sleep(10);
  }

  daemon.close();
  frontend.close();
  return { cycle, heldSeconds: holdSeconds, wokeOk, wakeRttMs: wakeRtt };
}

// ── main ──

interface RoundSample {
  roundIndex: number;
  elapsedMin: number;
  daemonRssKb: number;
  reconnect: ReconnectResult;
  roundTrip: RoundTripResult;
  relayHealth: unknown;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("─".repeat(60));
  console.log("Teleprompter soak");
  console.log(
    `  duration=${args.minutes}m  round-interval=${args.roundInterval}s`,
  );
  console.log(
    `  reconnects/round=${args.reconnects}  frames/round=${args.frames}`,
  );
  console.log(`  idle-cycles=${args.idleCycles}  idle-hold=${args.idleHold}s`);
  console.log("─".repeat(60));

  // in-process relay
  const relay = new RelayServer();
  const port = relay.start(0);
  relay.registerToken(TOKEN, DAEMON_ID);
  console.log(`relay up on :${port}`);

  // live daemon pid for RSS sampling (optional — soak still runs without one)
  const daemonPid = resolveDaemonPid();
  if (daemonPid) {
    console.log(`tracking daemon pid ${daemonPid} for RSS trend`);
  } else {
    console.log(
      "no live `tp daemon` found — RSS trend will be skipped " +
        "(start one with `tp status` to capture it)",
    );
  }

  const samples: RoundSample[] = [];
  let hardFailures = 0;

  const totalMs = args.minutes * 60_000;
  const t0 = Date.now();
  let roundIndex = 0;

  while (Date.now() - t0 < totalMs) {
    const roundStart = Date.now();
    const elapsedMin = (roundStart - t0) / 60_000;

    const reconnect = await measureReconnect(port, args.reconnects);
    const roundTrip = await measureRoundTrip(port, args.frames);
    const rss = daemonPid ? rssKb(daemonPid) : -1;
    const relayHealth = await fetch(`http://localhost:${port}/health`)
      .then((r) => r.json())
      .catch(() => null);

    if (reconnect.failed > 0) {
      hardFailures += reconnect.failed;
      console.error(
        `  ✗ ${reconnect.failed}/${reconnect.attempts} reconnects FAILED`,
      );
    }
    if (roundTrip.received < roundTrip.sent) {
      hardFailures++;
      console.error(
        `  ✗ round-trip dropped ${roundTrip.sent - roundTrip.received}/${roundTrip.sent} frames`,
      );
    }

    samples.push({
      roundIndex,
      elapsedMin,
      daemonRssKb: rss,
      reconnect,
      roundTrip,
      relayHealth,
    });

    console.log(
      `[${elapsedMin.toFixed(1)}m] ` +
        `rss=${rss > 0 ? `${(rss / 1024).toFixed(1)}MB` : "n/a"} ` +
        `reconnect=${reconnect.ok}/${reconnect.attempts} ` +
        `(p95 ${reconnect.connectMsP95.toFixed(1)}ms) ` +
        `rtt=${roundTrip.received}/${roundTrip.sent} ` +
        `(p50 ${roundTrip.rttMsP50.toFixed(1)} p95 ${roundTrip.rttMsP95.toFixed(1)} max ${roundTrip.rttMsMax.toFixed(1)}ms)`,
    );

    roundIndex++;
    if (Date.now() - t0 >= totalMs) break;
    // sleep out the rest of the round interval before the next round, but never
    // sleep past the overall deadline (so a short run still ends on time).
    const spent = Date.now() - roundStart;
    const remaining = args.roundInterval * 1000 - spent;
    const untilDeadline = totalMs - (Date.now() - t0);
    const nap = Math.min(Math.max(remaining, 0), untilDeadline);
    if (nap > 0) await Bun.sleep(nap);
  }

  // idle/wake phase at the end (each cycle holds > idleTimeout)
  console.log("─".repeat(60));
  console.log(`idle/wake phase: ${args.idleCycles} cycles × ${args.idleHold}s`);
  const idleResults: IdleCycleResult[] = [];
  for (let c = 0; c < args.idleCycles; c++) {
    const r = await measureIdleCycle(port, c, args.idleHold);
    idleResults.push(r);
    if (!r.wokeOk) {
      hardFailures++;
      console.error(`  ✗ idle cycle ${c} failed to wake`);
    } else {
      console.log(
        `  ✓ idle cycle ${c}: held ${r.heldSeconds}s, woke in ${r.wakeRttMs.toFixed(1)}ms`,
      );
    }
  }

  // summary
  console.log("─".repeat(60));
  const rssSamples = samples.map((s) => s.daemonRssKb).filter((v) => v > 0);
  if (rssSamples.length >= 2) {
    const first = rssSamples[0];
    const last = rssSamples[rssSamples.length - 1];
    const max = Math.max(...rssSamples);
    const deltaPct = ((last - first) / first) * 100;
    console.log(
      `daemon RSS: start ${(first / 1024).toFixed(1)}MB → end ${(last / 1024).toFixed(1)}MB ` +
        `(peak ${(max / 1024).toFixed(1)}MB, Δ ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`,
    );
  } else {
    console.log("daemon RSS: not sampled (no live daemon)");
  }

  const totalReconnects = samples.reduce((n, s) => n + s.reconnect.attempts, 0);
  const okReconnects = samples.reduce((n, s) => n + s.reconnect.ok, 0);
  const totalFrames = samples.reduce((n, s) => n + s.roundTrip.sent, 0);
  const okFrames = samples.reduce((n, s) => n + s.roundTrip.received, 0);
  console.log(`reconnects: ${okReconnects}/${totalReconnects} ok`);
  console.log(`frames: ${okFrames}/${totalFrames} delivered`);
  console.log(
    `idle/wake: ${idleResults.filter((r) => r.wokeOk).length}/${idleResults.length} cycles ok`,
  );
  console.log(`rounds: ${samples.length}`);
  console.log(`hard failures: ${hardFailures}`);

  if (args.json) {
    await Bun.write(
      args.json,
      JSON.stringify({ args, samples, idleResults, hardFailures }, null, 2),
    );
    console.log(`wrote ${args.json}`);
  }

  relay.stop();
  console.log("─".repeat(60));
  console.log(hardFailures === 0 ? "SOAK PASS" : `SOAK FAIL (${hardFailures})`);
  process.exit(hardFailures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
