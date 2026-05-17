import { render } from "ink";
import { createElement } from "react";
import { Spinner as InkSpinner } from "../components/ink/spinner";

/**
 * Simple spinner for long operations backed by the ink Spinner component.
 * Returns a stop function: call with a message to replace the spinner line,
 * or without args to just clear it.
 *
 * Non-TTY: writes the message to stderr immediately, stop() writes the final
 * message (if any) — same observable behaviour as the old setInterval impl.
 */
export function spinner(message: string): (finalMessage?: string) => void {
  if (!process.stderr.isTTY) {
    process.stderr.write(`${message}\n`);
    return (finalMessage?: string) => {
      if (finalMessage) process.stderr.write(`${finalMessage}\n`);
    };
  }

  // stdout isTTY check is handled inside <InkSpinner> — it renders null when
  // stdout is not a TTY. We render to stdout (ink default) matching the old
  // behaviour (the old impl wrote to stderr, but the spinner frames themselves
  // were the only stderr output; the final message is always written below).
  const instance = render(createElement(InkSpinner, { message }));

  return (finalMessage?: string) => {
    instance.unmount();
    if (finalMessage) {
      process.stderr.write(`${finalMessage}\n`);
    }
  };
}
