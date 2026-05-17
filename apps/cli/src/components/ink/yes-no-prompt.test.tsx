/**
 * Tests for YesNoPrompt component and promptYesNo helper.
 *
 * Uses ink-testing-library for component-level render/input simulation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { YesNoPrompt } from "./yes-no-prompt";

afterEach(() => {
  cleanup();
});

describe("YesNoPrompt — rendering", () => {
  test("renders question text with [Y/n] hint when defaultValue=true", () => {
    const { lastFrame } = render(
      <YesNoPrompt
        question="Continue?"
        defaultValue={true}
        onAnswer={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Continue?");
    expect(frame).toContain("[Y/n]");
  });

  test("renders question text with [y/N] hint when defaultValue=false", () => {
    const { lastFrame } = render(
      <YesNoPrompt
        question="Delete files?"
        defaultValue={false}
        onAnswer={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Delete files?");
    expect(frame).toContain("[y/N]");
  });
});

describe("YesNoPrompt — key handling", () => {
  test("pressing y calls onAnswer(true)", async () => {
    const answers: boolean[] = [];
    const onAnswer = mock((ans: boolean) => {
      answers.push(ans);
    });
    const { stdin } = render(
      <YesNoPrompt question="Ok?" defaultValue={false} onAnswer={onAnswer} />,
    );

    stdin.write("y");
    await new Promise((r) => setTimeout(r, 30));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(answers[0]).toBe(true);
  });

  test("pressing Y calls onAnswer(true)", async () => {
    const answers: boolean[] = [];
    const onAnswer = mock((ans: boolean) => {
      answers.push(ans);
    });
    const { stdin } = render(
      <YesNoPrompt question="Ok?" defaultValue={false} onAnswer={onAnswer} />,
    );

    stdin.write("Y");
    await new Promise((r) => setTimeout(r, 30));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(answers[0]).toBe(true);
  });

  test("pressing n calls onAnswer(false)", async () => {
    const answers: boolean[] = [];
    const onAnswer = mock((ans: boolean) => {
      answers.push(ans);
    });
    const { stdin } = render(
      <YesNoPrompt question="Ok?" defaultValue={true} onAnswer={onAnswer} />,
    );

    stdin.write("n");
    await new Promise((r) => setTimeout(r, 30));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(answers[0]).toBe(false);
  });

  test("pressing N calls onAnswer(false)", async () => {
    const answers: boolean[] = [];
    const onAnswer = mock((ans: boolean) => {
      answers.push(ans);
    });
    const { stdin } = render(
      <YesNoPrompt question="Ok?" defaultValue={true} onAnswer={onAnswer} />,
    );

    stdin.write("N");
    await new Promise((r) => setTimeout(r, 30));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(answers[0]).toBe(false);
  });

  test("pressing Enter with defaultValue=true calls onAnswer(true)", async () => {
    const answers: boolean[] = [];
    const onAnswer = mock((ans: boolean) => {
      answers.push(ans);
    });
    const { stdin } = render(
      <YesNoPrompt question="Ok?" defaultValue={true} onAnswer={onAnswer} />,
    );

    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(answers[0]).toBe(true);
  });

  test("pressing Enter with defaultValue=false calls onAnswer(false)", async () => {
    const answers: boolean[] = [];
    const onAnswer = mock((ans: boolean) => {
      answers.push(ans);
    });
    const { stdin } = render(
      <YesNoPrompt question="Ok?" defaultValue={false} onAnswer={onAnswer} />,
    );

    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(answers[0]).toBe(false);
  });

  test("pressing Escape calls onCancel when provided", async () => {
    const onCancel = mock(() => {});
    const onAnswer = mock(() => {});
    const { stdin } = render(
      <YesNoPrompt
        question="Ok?"
        defaultValue={true}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />,
    );

    stdin.write("\x1B"); // ESC — ink needs >20ms to resolve as standalone escape
    await new Promise((r) => setTimeout(r, 60));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("promptYesNo — non-TTY short-circuit", () => {
  test("returns defaultValue immediately when stdin is not a TTY", async () => {
    const origIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = false;

    try {
      const { promptYesNo } = await import("./yes-no-prompt");
      const result = await promptYesNo({
        question: "Delete?",
        defaultValue: true,
      });
      expect(result).toBe(true);

      const result2 = await promptYesNo({
        question: "Delete?",
        defaultValue: false,
      });
      expect(result2).toBe(false);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });

  test("returns defaultValue immediately when signal is already aborted", async () => {
    const origIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;

    try {
      const controller = new AbortController();
      controller.abort();
      const { promptYesNo } = await import("./yes-no-prompt");
      const result = await promptYesNo({
        question: "Delete?",
        defaultValue: false,
        signal: controller.signal,
      });
      expect(result).toBe(false);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = origIsTTY;
    }
  });
});
