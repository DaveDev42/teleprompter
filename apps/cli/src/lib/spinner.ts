const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Simple stderr spinner for long operations.
 * Returns a stop function: call with a message to replace the spinner line,
 * or without args to just clear it.
 */
export function spinner(message: string): (finalMessage?: string) => void {
  // Skip spinner if not a TTY (piped output, CI, etc.)
  if (!process.stderr.isTTY) {
    process.stderr.write(`${message}\n`);
    return (finalMessage?: string) => {
      if (finalMessage) process.stderr.write(`${finalMessage}\n`);
    };
  }

  let frame = 0;
  const interval = setInterval(() => {
    process.stderr.write(`\r${FRAMES[frame % FRAMES.length]} ${message}`);
    frame++;
  }, 80);

  return (finalMessage?: string) => {
    clearInterval(interval);
    process.stderr.write("\r\x1b[K"); // clear line
    if (finalMessage) {
      process.stderr.write(`${finalMessage}\n`);
    }
  };
}
