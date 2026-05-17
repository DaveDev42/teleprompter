/**
 * YesNoPrompt — ink component for single-keypress yes/no questions.
 *
 * Usage (component):
 *   <YesNoPrompt question="Delete 3 sessions?" defaultValue={false} onAnswer={ans => ...} />
 *
 * Usage (helper, awaitable):
 *   const ok = await promptYesNo({ question: "Continue?", defaultValue: true });
 */

import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useState } from "react";

// ─── Component ────────────────────────────────────────────────────────────────

export interface YesNoPromptProps {
  /** The prompt text. The component appends the [Y/n] or [y/N] hint. */
  question: string;
  /** true = Enter defaults to yes ([Y/n]), false = Enter defaults to no ([y/N]). */
  defaultValue: boolean;
  /** Fired when the user answers. The component exits ink after calling this. */
  onAnswer: (answer: boolean) => void;
  /** Fired on Esc/Ctrl+C. If omitted, treats cancel as the default value. */
  onCancel?: () => void;
}

/**
 * Single-keypress yes/no prompt rendered via ink.
 * Reads: y/Y → true, n/N → false, Enter → defaultValue, Esc/Ctrl+C → onCancel.
 * Prints the answered line (e.g. "Delete? [Y/n] yes") before exiting.
 */
export function YesNoPrompt({
  question,
  defaultValue,
  onAnswer,
  onCancel,
}: YesNoPromptProps): React.ReactElement {
  const { exit } = useApp();
  const [answered, setAnswered] = useState<boolean | null>(null);

  const hint = defaultValue ? "[Y/n]" : "[y/N]";

  useInput((input, key) => {
    if (answered !== null) return; // already answered

    if (key.escape || (key.ctrl && input === "c")) {
      if (onCancel) {
        setAnswered(defaultValue); // show default before exiting
        setTimeout(() => {
          onCancel();
          exit();
        }, 0);
      } else {
        setAnswered(defaultValue);
        setTimeout(() => {
          onAnswer(defaultValue);
          exit();
        }, 0);
      }
      return;
    }

    if (key.return) {
      setAnswered(defaultValue);
      setTimeout(() => {
        onAnswer(defaultValue);
        exit();
      }, 0);
      return;
    }

    if (input === "y" || input === "Y") {
      setAnswered(true);
      setTimeout(() => {
        onAnswer(true);
        exit();
      }, 0);
      return;
    }

    if (input === "n" || input === "N") {
      setAnswered(false);
      setTimeout(() => {
        onAnswer(false);
        exit();
      }, 0);
      return;
    }
  });

  if (answered !== null) {
    return (
      <Box>
        <Text>
          {question} {hint} <Text color="green">{answered ? "yes" : "no"}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text>
        {question} {hint}{" "}
      </Text>
    </Box>
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────

export interface PromptYesNoOptions {
  question: string;
  defaultValue: boolean;
  /** Optional AbortSignal — resolves immediately with defaultValue on abort. */
  signal?: AbortSignal;
}

/**
 * Awaitable yes/no prompt. Wraps `<YesNoPrompt>` + `waitUntilExit()`.
 *
 * Non-TTY: returns `defaultValue` immediately without rendering.
 * Abort signal: returns `defaultValue` immediately on abort.
 */
export async function promptYesNo(opts: PromptYesNoOptions): Promise<boolean> {
  const { question, defaultValue, signal } = opts;

  // Non-TTY short-circuit: don't attempt to read from a pipe/redirect.
  if (!process.stdin.isTTY) {
    return defaultValue;
  }

  // Abort short-circuit.
  if (signal?.aborted) {
    return defaultValue;
  }

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let answer = defaultValue;

    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      answer = value;
    };

    let inkInstance: ReturnType<typeof render> | null = null;

    const cleanup = (): void => {
      if (inkInstance) {
        try {
          inkInstance.unmount();
        } catch {
          // best-effort
        }
        inkInstance = null;
      }
    };

    if (signal) {
      signal.addEventListener("abort", () => {
        settle(defaultValue);
        cleanup();
        resolve(defaultValue);
      });
    }

    try {
      inkInstance = render(
        <YesNoPrompt
          question={question}
          defaultValue={defaultValue}
          onAnswer={(ans) => settle(ans)}
          onCancel={() => settle(defaultValue)}
        />,
        { exitOnCtrlC: false },
      );

      inkInstance
        .waitUntilExit()
        .then(() => {
          cleanup();
          resolve(answer);
        })
        .catch((err: unknown) => {
          cleanup();
          reject(err);
        });
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}
