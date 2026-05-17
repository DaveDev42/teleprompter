/**
 * TextPrompt — ink component for single-line text input with optional validation.
 *
 * Usage (component):
 *   <TextPrompt question="Enter label:" onSubmit={val => ...} onCancel={() => ...} />
 *
 * Usage (helper, awaitable):
 *   const val = await promptText({ question: "Enter name:" });
 *   // null = cancelled
 */

import { Box, render, Text, useApp, useInput } from "ink";
import type React from "react";
import { useState } from "react";

// ─── Component ────────────────────────────────────────────────────────────────

export interface TextPromptProps {
  /** The prompt text shown before the input field. */
  question: string;
  /**
   * Optional validator. Return an error message string (non-null) to reject the
   * current input, or null/undefined to accept it.
   */
  validate?: (input: string) => string | null | undefined;
  /** Fired when the user submits a valid value (Enter with passing validation). */
  onSubmit: (value: string) => void;
  /** Fired on Esc/Ctrl+C. */
  onCancel?: () => void;
  /** Dim placeholder text shown before the user has typed anything. */
  placeholder?: string;
}

/**
 * Single-line text input prompt rendered via ink.
 *
 * - Enter: submit (after validate passes).
 * - Esc / Ctrl+C: cancel.
 * - Backspace: delete last character.
 * - Left/right arrows: basic cursor movement.
 */
export function TextPrompt({
  question,
  validate,
  onSubmit,
  onCancel,
  placeholder,
}: TextPromptProps): React.ReactElement {
  const { exit } = useApp();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useInput((input, key) => {
    if (done) return;

    // Cancel
    if (key.escape || (key.ctrl && input === "c")) {
      setDone(true);
      setTimeout(() => {
        onCancel?.();
        exit();
      }, 0);
      return;
    }

    // Submit
    if (key.return) {
      const errMsg = validate ? validate(value) : null;
      if (errMsg) {
        setError(errMsg);
        return;
      }
      setDone(true);
      const submitted = value;
      setTimeout(() => {
        onSubmit(submitted);
        exit();
      }, 0);
      return;
    }

    // Navigation
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      setError(null);
      return;
    }

    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      setError(null);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      setValue(next);
      setCursor((c) => c - 1);
      setError(null);
      return;
    }

    // Regular printable character
    if (input && !key.ctrl && !key.meta) {
      const next = value.slice(0, cursor) + input + value.slice(cursor);
      setValue(next);
      setCursor((c) => c + input.length);
      setError(null);
    }
  });

  const showPlaceholder = value.length === 0 && !done;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{question} </Text>
        {showPlaceholder && placeholder ? (
          <Text dimColor>{placeholder}</Text>
        ) : (
          <Text>
            {value.slice(0, cursor)}
            <Text inverse>{value[cursor] ?? " "}</Text>
            {value.slice(cursor + 1)}
          </Text>
        )}
      </Box>
      {error ? (
        <Box>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────

export interface PromptTextOptions {
  question: string;
  validate?: (s: string) => string | null | undefined;
  placeholder?: string;
  /** Optional AbortSignal — resolves with null on abort. */
  signal?: AbortSignal;
}

/**
 * Awaitable text prompt. Wraps `<TextPrompt>` + `waitUntilExit()`.
 *
 * Returns the submitted string, or null on cancel/abort.
 * Non-TTY: returns null immediately without rendering.
 */
export async function promptText(
  opts: PromptTextOptions,
): Promise<string | null> {
  const { question, validate, placeholder, signal } = opts;

  // Non-TTY short-circuit.
  if (!process.stdin.isTTY) {
    return null;
  }

  // Abort short-circuit.
  if (signal?.aborted) {
    return null;
  }

  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    let result: string | null = null;

    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      result = value;
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
        settle(null);
        cleanup();
        resolve(null);
      });
    }

    try {
      inkInstance = render(
        <TextPrompt
          question={question}
          validate={validate}
          placeholder={placeholder}
          onSubmit={(val) => settle(val)}
          onCancel={() => settle(null)}
        />,
        { exitOnCtrlC: false },
      );

      inkInstance
        .waitUntilExit()
        .then(() => {
          cleanup();
          resolve(result);
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
