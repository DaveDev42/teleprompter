/**
 * Unit tests for chat-store (hooks-only mode).
 *
 * Covers:
 *  - addMessage appends to messages[]
 *  - elicitation / permission messages flip showTerminalFallback
 *  - processHookEvent: UserPromptSubmit (with dedup), Stop (with and without
 *    last_assistant_message), StopFailure, PreToolUse, PostToolUse,
 *    PermissionRequest, Elicitation, Notification, SessionStart (default)
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type {
  HookEventBase,
  PostToolUseEvent,
  PreToolUseEvent,
  StopEvent,
} from "@teleprompter/protocol/client";
import {
  addOptimisticUserMessage,
  makeId,
  processHookEvent,
  useChatStore,
} from "./chat-store";

function resetStore() {
  useChatStore.getState().clear();
}

function baseEvent<T extends Partial<HookEventBase>>(extra: T): HookEventBase {
  return {
    session_id: "sess",
    hook_event_name: "SessionStart",
    cwd: "/tmp",
    ...extra,
  } as HookEventBase;
}

describe("chat-store: basic actions", () => {
  beforeEach(resetStore);

  test("addMessage appends to messages[]", () => {
    const s = useChatStore.getState();
    s.addMessage({
      id: makeId(),
      type: "user",
      text: "hello",
      ts: Date.now(),
    });
    s.addMessage({
      id: makeId(),
      type: "assistant",
      text: "hi there",
      ts: Date.now(),
    });
    const messages = useChatStore.getState().messages;
    expect(messages.length).toBe(2);
    expect(messages[0].text).toBe("hello");
    expect(messages[1].type).toBe("assistant");
  });

  test("makeId produces unique ids", () => {
    const a = makeId();
    const b = makeId();
    expect(a).not.toBe(b);
  });

  test("elicitation message flips showTerminalFallback", () => {
    const s = useChatStore.getState();
    s.addMessage({
      id: makeId(),
      type: "elicitation",
      text: "pick one",
      ts: Date.now(),
    });
    expect(useChatStore.getState().showTerminalFallback).toBe(true);
  });

  test("permission message flips showTerminalFallback", () => {
    const s = useChatStore.getState();
    s.addMessage({
      id: makeId(),
      type: "permission",
      text: "allow?",
      ts: Date.now(),
    });
    expect(useChatStore.getState().showTerminalFallback).toBe(true);
  });

  test("normal messages do NOT flip showTerminalFallback", () => {
    const s = useChatStore.getState();
    s.addMessage({
      id: makeId(),
      type: "assistant",
      text: "hi",
      ts: Date.now(),
    });
    expect(useChatStore.getState().showTerminalFallback).toBe(false);
  });

  test("addOptimisticUserMessage appends a local-origin user message", () => {
    addOptimisticUserMessage("hello world");
    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("hello world");
    expect(msgs[0].source).toBe("local");
  });

  test("addOptimisticUserMessage trims text and ignores whitespace-only input", () => {
    addOptimisticUserMessage("  padded  ");
    addOptimisticUserMessage("   \n\t ");
    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toBe("padded");
  });

  test("dismissTerminalFallback clears the banner", () => {
    const s = useChatStore.getState();
    s.addMessage({
      id: makeId(),
      type: "elicitation",
      text: "?",
      ts: Date.now(),
    });
    expect(useChatStore.getState().showTerminalFallback).toBe(true);
    s.dismissTerminalFallback();
    expect(useChatStore.getState().showTerminalFallback).toBe(false);
  });

  test("clear resets everything", () => {
    const s = useChatStore.getState();
    s.addMessage({
      id: makeId(),
      type: "user",
      text: "hi",
      ts: Date.now(),
    });
    s.addMessage({
      id: makeId(),
      type: "elicitation",
      text: "?",
      ts: Date.now(),
    });

    s.clear();

    const after = useChatStore.getState();
    expect(after.messages).toEqual([]);
    expect(after.showTerminalFallback).toBe(false);
  });
});

describe("chat-store: processHookEvent", () => {
  beforeEach(resetStore);

  test("UserPromptSubmit appends user message", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "hello",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("hello");
    expect(msgs[0].source).toBe("remote");
  });

  test("Stop with last_assistant_message adds assistant message", () => {
    const event: StopEvent = {
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
      last_assistant_message: "Done!",
    };
    processHookEvent(event);

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("assistant");
    expect(msgs[0].text).toBe("Done!");
  });

  test("Stop without last_assistant_message adds nothing", () => {
    processHookEvent({
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
    } as StopEvent);

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(0);
  });

  test("PreToolUse adds a tool message", () => {
    const event: PreToolUseEvent = {
      session_id: "sess",
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    processHookEvent(event);

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("tool");
    expect(msgs[0].toolName).toBe("Bash");
    expect(msgs[0].toolInput).toEqual({ command: "ls" });
    expect(msgs[0].text).toContain("Bash");
  });

  test("PostToolUse adds a tool message with result", () => {
    const event: PostToolUseEvent = {
      session_id: "sess",
      hook_event_name: "PostToolUse",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_result: "file1\nfile2",
    };
    processHookEvent(event);

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("tool");
    expect(msgs[0].toolName).toBe("Bash");
    expect(msgs[0].toolResult).toBe("file1\nfile2");
  });

  test("PermissionRequest adds a permission message and flips terminal fallback", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "PermissionRequest",
        tool_name: "Write",
        tool_input: { file_path: "/etc/passwd" },
      }),
    );

    const state = useChatStore.getState();
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].type).toBe("permission");
    expect(state.messages[0].permissionTool).toBe("Write");
    expect(state.showTerminalFallback).toBe(true);
  });

  test("Elicitation with numbered choices parses them", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "Elicitation",
        message: "Pick one:\n1) Option A\n2) Option B\n3) Option C",
      }),
    );

    const state = useChatStore.getState();
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].type).toBe("elicitation");
    expect(state.messages[0].choices).toEqual([
      "Option A",
      "Option B",
      "Option C",
    ]);
    expect(state.showTerminalFallback).toBe(true);
  });

  test("Elicitation with no parseable choices leaves choices undefined", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "Elicitation",
        message: "Just a plain prompt.",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].choices).toBeUndefined();
  });

  test("Notification adds a system message", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "Notification",
        message: "Heads up!",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("system");
    expect(msgs[0].text).toBe("Heads up!");
  });

  test("session lifecycle hook events are silent (no chat noise)", () => {
    for (const name of [
      "SessionStart",
      "SessionEnd",
      "SubagentStart",
      "SubagentStop",
    ]) {
      processHookEvent(baseEvent({ hook_event_name: name }));
    }
    expect(useChatStore.getState().messages.length).toBe(0);
  });

  test("truly unknown hook events fall through to a system message", () => {
    processHookEvent(baseEvent({ hook_event_name: "TotallyMadeUpEvent" }));
    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("system");
    expect(msgs[0].event).toBe("TotallyMadeUpEvent");
  });

  test("UserPromptSubmit de-dups optimistic local user message with same text", () => {
    useChatStore.getState().addMessage({
      id: makeId(),
      type: "user",
      text: "ping",
      source: "local",
      ts: Date.now(),
    });
    expect(useChatStore.getState().messages.length).toBe(1);

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "ping",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("ping");
  });

  test("UserPromptSubmit with different text does NOT de-dup (appends)", () => {
    useChatStore.getState().addMessage({
      id: makeId(),
      type: "user",
      text: "first",
      source: "local",
      ts: Date.now(),
    });

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "second",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(2);
    expect(msgs[0].text).toBe("first");
    expect(msgs[1].text).toBe("second");
  });

  test("backward scan stops after first non-match so delayed echoes are not swallowed", () => {
    addOptimisticUserMessage("A");
    addOptimisticUserMessage("B");
    expect(useChatStore.getState().messages.length).toBe(2);

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "A",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(3);
    expect(msgs[0].text).toBe("A");
    expect(msgs[0].source).toBe("local");
    expect(msgs[1].text).toBe("B");
    expect(msgs[1].source).toBe("local");
    expect(msgs[2].text).toBe("A");
    expect(msgs[2].source).toBe("remote");
  });

  test("UserPromptSubmit de-dups against daemon-echoed text with trailing newline", () => {
    useChatStore.getState().addMessage({
      id: makeId(),
      type: "user",
      text: "hi",
      source: "local",
      ts: Date.now(),
    });

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "hi\n",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toBe("hi");
  });

  test("UserPromptSubmit does NOT de-dup non-local user messages", () => {
    useChatStore.getState().addMessage({
      id: makeId(),
      type: "user",
      text: "echo",
      ts: Date.now(),
    });

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "echo",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(2);
  });

  test("UserPromptSubmit does NOT de-dup against a prior source: 'remote' user message", () => {
    useChatStore.getState().addMessage({
      id: makeId(),
      type: "user",
      text: "echo",
      source: "remote",
      ts: Date.now(),
    });

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "echo",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(2);
    expect(msgs[0].source).toBe("remote");
    expect(msgs[1].source).toBe("remote");
  });

  test("optimistic send -> daemon echo -> stop (no duplicate user bubble)", () => {
    addOptimisticUserMessage("How are you?");
    expect(useChatStore.getState().messages.length).toBe(1);

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "How are you?",
      }),
    );
    processHookEvent({
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
      last_assistant_message: "I'm fine.",
    } as StopEvent);

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(2);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("How are you?");
    expect(msgs[0].source).toBe("local");
    expect(msgs[1].type).toBe("assistant");
    expect(msgs[1].text).toBe("I'm fine.");
  });

  test("full conversation: prompt -> stop finalizes correctly", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "How are you?",
      }),
    );
    processHookEvent({
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
      last_assistant_message: "I'm fine, thanks.",
    } as StopEvent);

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(2);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("How are you?");
    expect(msgs[0].source).toBe("remote");
    expect(msgs[1].type).toBe("assistant");
    expect(msgs[1].text).toBe("I'm fine, thanks.");
  });

  test("StopFailure emits a system error chip", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "hi",
      }),
    );

    processHookEvent(
      baseEvent({
        hook_event_name: "StopFailure",
        error: "timeout",
      }),
    );

    const s = useChatStore.getState();
    const last = s.messages[s.messages.length - 1];
    expect(last.type).toBe("system");
    expect(last.event).toBe("StopFailure");
    expect(last.text).toBe("timeout");
  });
});
