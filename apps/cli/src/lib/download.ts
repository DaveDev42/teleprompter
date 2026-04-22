import { createWriteStream, unlinkSync } from "fs";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

/**
 * Human-readable byte count. B for <1KB, KB/MB/GB with one decimal otherwise.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** Same magnitudes as formatBytes, suffixed with `/s`. */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Render `done` without its unit suffix, using the same scale as `total`, and
 * `total` with the unit. Result: ("29.1", "63.0 MB") — so the caller can print
 * "29.1 / 63.0 MB" with a shared unit.
 */
function splitValueAndUnit(done: number, total: number): [string, string] {
  // Pick the unit from `total` so the pair shares a scale even when `done`
  // would round down to a smaller one early in the download.
  let unit: string;
  let divisor: number;
  if (total < KB) {
    unit = "B";
    divisor = 1;
  } else if (total < MB) {
    unit = "KB";
    divisor = KB;
  } else if (total < GB) {
    unit = "MB";
    divisor = MB;
  } else {
    unit = "GB";
    divisor = GB;
  }

  const fmt = (n: number) => {
    if (divisor === 1) return String(Math.round(n));
    return (n / divisor).toFixed(1);
  };
  return [fmt(done), `${fmt(total)} ${unit}`];
}

/**
 * Render one redrawable progress line. Caller is responsible for \r + padding.
 * The label is assumed to be a single line of printable text — do not pass
 * content containing `\n`, `\r`, or raw ANSI escapes, or the repaint breaks.
 *
 * Shape when total known:
 *   "<label> [====      ] 45% (29.1 / 63.0 MB) 28.3 MB/s"
 * Shape when total unknown (GitHub CDN occasionally omits Content-Length):
 *   "<label> 29.7 MB 28.3 MB/s"
 */
export function formatProgressLine(opts: {
  label: string;
  bytesDone: number;
  bytesTotal: number | null;
  bytesPerSec: number;
  barWidth: number;
}): string {
  const { label, bytesDone, bytesTotal, bytesPerSec, barWidth } = opts;
  const speedPart = bytesPerSec > 0 ? ` ${formatSpeed(bytesPerSec)}` : "";

  if (bytesTotal == null || bytesTotal <= 0) {
    return `${label} ${formatBytes(Math.max(0, bytesDone))}${speedPart}`;
  }

  const ratio = Math.min(1, Math.max(0, bytesDone / bytesTotal));
  const pct = Math.round(ratio * 100);
  const filled = Math.round(ratio * barWidth);
  const bar = `${"=".repeat(filled)}${" ".repeat(Math.max(0, barWidth - filled))}`;

  // Share the unit suffix (driven by total) so the pair reads naturally:
  //   "(29.1 / 63.0 MB)"  rather than  "(29.1 MB / 63.0 MB)".
  const clampedDone = Math.min(bytesTotal, Math.max(0, bytesDone));
  const [doneNum, totalWithUnit] = splitValueAndUnit(clampedDone, bytesTotal);
  return `${label} [${bar}] ${pct}% (${doneNum} / ${totalWithUnit})${speedPart}`;
}

/**
 * Decile log gate for non-TTY mode: true iff we just crossed a 10% boundary
 * (or hit 100%) between `prevPct` and `curPct`.
 */
export function shouldLogDecile(opts: {
  prevPct: number;
  curPct: number;
}): boolean {
  const { prevPct, curPct } = opts;
  if (curPct <= prevPct) return false;
  const prevDecile = Math.floor(prevPct / 10);
  const curDecile = Math.floor(curPct / 10);
  if (curDecile > prevDecile) return true;
  if (curPct >= 100 && prevPct < 100) return true;
  return false;
}

export type RenderMode = "tty" | "log";

/**
 * Pick the rendering strategy. TTY → live line rewrite via `\r`.
 * Non-TTY (CI, pipes) → one log line per 10% crossing.
 *
 * The progress line itself uses no ANSI colors, so NO_COLOR does not affect
 * this decision — the only signal that matters is whether `\r` will work.
 */
export function pickRenderMode(opts: { isTTY: boolean }): RenderMode {
  return opts.isTTY ? "tty" : "log";
}

/** Live download state exposed to renderers. */
type ProgressState = {
  bytesDone: number;
  bytesTotal: number | null;
  bytesPerSec: number;
};

type DownloadOpts = {
  /** User-visible label, e.g. "Downloading tp v0.1.13". Must be single-line. */
  label: string;
  /** Stall timeout: abort if zero bytes received in this many ms. Default 30s. */
  stallTimeoutMs?: number;
  /** Absolute cap on the whole download. Default 600s. */
  hardTimeoutMs?: number;
  /** Override stderr for testing. */
  stderr?: NodeJS.WriteStream;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Milliseconds between repaints in TTY mode. Default 100ms. */
  tickIntervalMs?: number;
};

/**
 * Stream-download `url` into `destPath` with live progress feedback.
 *
 * - Renders a progress bar on a TTY, logs 10% markers elsewhere.
 * - Uses a stall timeout (no bytes for `stallTimeoutMs`) + absolute cap
 *   (`hardTimeoutMs`) instead of a single fetch-wide deadline that penalises
 *   slow-but-steady links on 100MB+ assets. Abort reasons are forwarded to
 *   the caller so stalls surface as `"no bytes received for 30000ms (stalled)"`
 *   rather than the generic `"The operation was aborted."`.
 */
export async function downloadWithProgress(
  url: string,
  destPath: string,
  opts: DownloadOpts,
): Promise<void> {
  const stderr = opts.stderr ?? process.stderr;
  const stallTimeoutMs = opts.stallTimeoutMs ?? 30_000;
  const hardTimeoutMs = opts.hardTimeoutMs ?? 600_000;
  const tickIntervalMs = opts.tickIntervalMs ?? 100;
  const fetchFn = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  let hardTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new Error(`download exceeded ${hardTimeoutMs}ms`));
  }, hardTimeoutMs);
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const clearAllTimers = () => {
    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  // Stall timer — reset on each chunk. Fires only when the stream genuinely
  // halts for stallTimeoutMs, which is the signal users actually care about.
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      controller.abort(
        new Error(`no bytes received for ${stallTimeoutMs}ms (stalled)`),
      );
    }, stallTimeoutMs);
  };

  // Convert an AbortError into the abort reason so callers see a meaningful
  // "(stalled)" / "exceeded Xms" message instead of "The operation was aborted."
  // Declared as a `function` (not an arrow assigned to a const) so TS applies
  // its `never`-return narrowing at each call site — callers can `rethrow(err)`
  // without a surrounding `return`/`throw` and subsequent code is still
  // correctly seen as unreachable.
  function rethrow(err: unknown): never {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof Error) throw reason;
      if (typeof reason === "string") throw new Error(reason);
    }
    throw err;
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    clearAllTimers();
    rethrow(err);
  }

  if (!res.ok || !res.body) {
    clearAllTimers();
    throw new Error(`Download failed: HTTP ${res.status}`);
  }

  const lenHeader = res.headers.get("content-length");
  const bytesTotal =
    lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;

  const mode = pickRenderMode({ isTTY: Boolean(stderr.isTTY) });

  const state: ProgressState = {
    bytesDone: 0,
    bytesTotal,
    bytesPerSec: 0,
  };

  // Sliding 1s window for speed calculation. Keeps the number responsive without
  // jittering wildly on a per-chunk basis.
  const windowMs = 1000;
  const samples: Array<{ t: number; bytes: number }> = [];
  const recordSample = (bytes: number) => {
    const now = performance.now();
    samples.push({ t: now, bytes });
    const cutoff = now - windowMs;
    while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
    if (samples.length < 2) {
      state.bytesPerSec = 0;
      return;
    }
    const span = samples[samples.length - 1].t - samples[0].t;
    const delta = samples[samples.length - 1].bytes - samples[0].bytes;
    state.bytesPerSec = span > 0 ? (delta / span) * 1000 : 0;
  };

  let maxLineLen = 0;
  const writeTtyLine = () => {
    const line = formatProgressLine({
      label: opts.label,
      bytesDone: state.bytesDone,
      bytesTotal: state.bytesTotal,
      bytesPerSec: state.bytesPerSec,
      barWidth: 24,
    });
    // pad to overwrite a longer previous line — track the widest line we've
    // ever drawn so variable-width tails (speed jitter, eta) don't leave
    // stale characters behind.
    const padded =
      line.length < maxLineLen
        ? line + " ".repeat(maxLineLen - line.length)
        : line;
    stderr.write(`\r${padded}`);
    if (line.length > maxLineLen) maxLineLen = line.length;
  };

  // Separate milestone counters so the "% decile" and "MB heartbeat" branches
  // don't share state — reuse was bug-prone even though the branches never
  // interleave in practice.
  let prevDecilePct = 0;
  let prevMbMilestone = 0;
  const writeLogLine = () => {
    if (state.bytesTotal == null) {
      // Unknown total → log every MB crossing as a rough heartbeat.
      const mbDone = Math.floor(state.bytesDone / MB);
      if (mbDone > prevMbMilestone) {
        stderr.write(
          `${opts.label}: ${formatBytes(state.bytesDone)}${
            state.bytesPerSec > 0 ? ` (${formatSpeed(state.bytesPerSec)})` : ""
          }\n`,
        );
        prevMbMilestone = mbDone;
      }
      return;
    }
    const curPct = Math.min(
      100,
      Math.floor((state.bytesDone / state.bytesTotal) * 100),
    );
    if (shouldLogDecile({ prevPct: prevDecilePct, curPct })) {
      stderr.write(
        `${opts.label}: ${curPct}% (${formatBytes(state.bytesDone)} / ${formatBytes(
          state.bytesTotal,
        )})${state.bytesPerSec > 0 ? ` ${formatSpeed(state.bytesPerSec)}` : ""}\n`,
      );
      prevDecilePct = curPct;
    }
  };

  const render = () => {
    recordSample(state.bytesDone);
    if (mode === "tty") writeTtyLine();
    else writeLogLine();
  };

  // Widen the try so `clearAllTimers()` in the finally covers every path on
  // which `ticker` / `stallTimer` / `fileClosed` could have been set, even if
  // `getReader()` / stream-setup throws synchronously.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let file: ReturnType<typeof createWriteStream> | null = null;
  let fileClosed: Promise<void> | null = null;
  try {
    ticker = mode === "tty" ? setInterval(writeTtyLine, tickIntervalMs) : null;
    file = createWriteStream(destPath);
    fileClosed = new Promise<void>((resolve, reject) => {
      file?.on("finish", () => resolve());
      file?.on("error", reject);
    });
    reader = res.body.getReader();
    resetStallTimer();
    // initial seed sample at t0 so the first real chunk yields a speed
    recordSample(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      state.bytesDone += value.byteLength;
      resetStallTimer();
      if (!file.write(value)) {
        // Race the drain event against abort — if the stream is torn down
        // while we're waiting, `drain` never fires and we'd hang forever.
        // Alias into a const so TS keeps the non-null narrowing inside the
        // closure (the outer `let file` loses it across callback boundaries).
        const stream = file;
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          };
          const onAbort = () => {
            stream.off("drain", onDrain);
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new Error("aborted"),
            );
          };
          stream.once("drain", onDrain);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      render();
    }
    file.end();
    await fileClosed;
  } catch (err) {
    file?.destroy();
    // Swallow any secondary rejection from fileClosed (e.g. destroy-emitted
    // 'error') so the original error is the one that surfaces to the caller.
    fileClosed?.catch(() => {});
    // On any failure, drop the partial file so callers don't mistake it for a
    // complete download. Best-effort.
    try {
      unlinkSync(destPath);
    } catch {}
    rethrow(err);
  } finally {
    try {
      reader?.releaseLock();
    } catch {}
    clearAllTimers();
    if (mode === "tty") {
      // Clear the progress line so the caller can write its own success message.
      stderr.write(`\r${" ".repeat(maxLineLen)}\r`);
    }
  }
}
