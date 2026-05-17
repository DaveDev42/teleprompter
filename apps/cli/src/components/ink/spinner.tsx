/**
 * Spinner — ink component for displaying an animated spinner with a message.
 *
 * Uses ink-spinner (cli-spinners) under the hood. Renders nothing when stdout
 * is not a TTY (piped output, CI, log files).
 *
 * Usage:
 *   const { unmount } = render(<Spinner message="Loading..." />);
 *   // ... work done ...
 *   unmount();
 *
 * The next PR (`lib/spinner.ts` migration) will consume this component to
 * replace the current manual setInterval-based spinner implementation.
 */

import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import type React from "react";

// ─── Component ────────────────────────────────────────────────────────────────

export interface SpinnerProps {
  /** Text displayed next to the spinning indicator. */
  message: string;
  /** Animation style. Defaults to "dots". */
  frame?: "dots" | "line" | "arc";
}

/**
 * Animated spinner rendered via ink.
 * Hidden entirely when `process.stdout.isTTY` is falsy, so piped output stays
 * clean (CI logs, file redirects, etc.).
 */
export function Spinner({
  message,
  frame = "dots",
}: SpinnerProps): React.ReactElement | null {
  // Do not pollute non-TTY output streams.
  if (!process.stdout.isTTY) {
    return null;
  }

  return (
    <Box>
      <Text color="cyan">
        <InkSpinner type={frame} />
      </Text>
      <Text> {message}</Text>
    </Box>
  );
}
