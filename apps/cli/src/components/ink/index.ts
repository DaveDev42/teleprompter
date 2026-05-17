/**
 * Shared ink (React for CLI) component library for tp CLI prompts.
 *
 * Components:
 *   YesNoPrompt / promptYesNo  — single-keypress yes/no question
 *   TextPrompt / promptText    — single-line text input with optional validation
 *   Spinner                    — animated spinner (hidden in non-TTY)
 *   KeyHandler                 — declarative keyboard binding component
 */

export type { KeyBindings, KeyHandlerProps } from "./key-handler";
export { KeyHandler } from "./key-handler";
export type { SpinnerProps } from "./spinner";
export { Spinner } from "./spinner";
export type { PromptTextOptions, TextPromptProps } from "./text-prompt";
export { promptText, TextPrompt } from "./text-prompt";
export type { PromptYesNoOptions, YesNoPromptProps } from "./yes-no-prompt";
export { promptYesNo, YesNoPrompt } from "./yes-no-prompt";
