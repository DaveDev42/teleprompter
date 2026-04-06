import { rm } from "fs/promises";

/**
 * rm with retry for Windows EBUSY errors.
 * On Windows, files locked by open handles (sockets, SQLite) can't be
 * deleted immediately. This retries with exponential backoff.
 */
export async function rmRetry(
  path: string,
  opts?: { maxRetries?: number; baseDelayMs?: number },
): Promise<void> {
  const maxRetries = opts?.maxRetries ?? 5;
  const baseDelay = opts?.baseDelayMs ?? 100;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw err;
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
    }
  }
}
