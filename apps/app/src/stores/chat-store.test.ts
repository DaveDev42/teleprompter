/**
 * Unit tests for chat-store.
 *
 * Covers:
 *  - addMessage appends to messages[]
 *  - elicitation / permission messages flip showTerminalFallback
 *  - streaming text accumulates across multiple chunks into one final message
 *  - finalizeStreaming with whitespace-only text is a no-op (clears buffer)
 *  - processHookEvent: UserPromptSubmit, Stop, PreToolUse, PostToolUse,
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
    s.appendStreaming("partial");
    s.addMessage({
      id: makeId(),
      type: "elicitation",
      text: "?",
      ts: Date.now(),
    });

    s.clear();

    const after = useChatStore.getState();
    expect(after.messages).toEqual([]);
    expect(after.streamingText).toBe("");
    expect(after.showTerminalFallback).toBe(false);
  });
});

describe("chat-store: streaming text accumulation", () => {
  beforeEach(resetStore);

  test("multiple appendStreaming chunks combine into one message", () => {
    const s = useChatStore.getState();
    s.appendStreaming("Hello");
    s.appendStreaming(" ");
    s.appendStreaming("world");
    s.appendStreaming("!");

    expect(useChatStore.getState().streamingText).toBe("Hello world!");
    expect(useChatStore.getState().messages.length).toBe(0);

    s.finalizeStreaming();

    const state = useChatStore.getState();
    expect(state.streamingText).toBe("");
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].text).toBe("Hello world!");
    expect(state.messages[0].type).toBe("streaming");
  });

  test("finalizeStreaming with empty buffer is a no-op", () => {
    const s = useChatStore.getState();
    s.finalizeStreaming();
    const state = useChatStore.getState();
    expect(state.messages.length).toBe(0);
    expect(state.streamingText).toBe("");
  });

  test("finalizeStreaming with whitespace-only buffer clears without adding message", () => {
    const s = useChatStore.getState();
    s.appendStreaming("   \n\t  ");
    s.finalizeStreaming();
    const state = useChatStore.getState();
    expect(state.messages.length).toBe(0);
    expect(state.streamingText).toBe("");
  });

  test("streaming then addMessage interleave preserves order", () => {
    const s = useChatStore.getState();
    s.appendStreaming("first stream");
    s.finalizeStreaming();
    s.addMessage({
      id: makeId(),
      type: "user",
      text: "user input",
      ts: Date.now(),
    });
    s.appendStreaming("second stream");
    s.finalizeStreaming();

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(3);
    expect(msgs[0].text).toBe("first stream");
    expect(msgs[1].text).toBe("user input");
    expect(msgs[2].text).toBe("second stream");
  });
});

describe("chat-store: processHookEvent", () => {
  beforeEach(resetStore);

  test("UserPromptSubmit finalizes streaming + appends user message", () => {
    useChatStore.getState().appendStreaming("partial response");

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "hello",
      }),
    );

    const msgs = useChatStore.getState().messages;
    // The streaming buffer (above) was finalized into a "streaming" msg,
    // then the user prompt was appended.
    expect(msgs.length).toBe(2);
    expect(msgs[0].type).toBe("streaming");
    expect(msgs[0].text).toBe("partial response");
    expect(msgs[1].type).toBe("user");
    expect(msgs[1].text).toBe("hello");
    expect(msgs[1].source).toBe("remote");
    expect(useChatStore.getState().streamingText).toBe("");
  });

  test("Stop finalizes streaming text into one message (streaming) and appends assistant message when last_assistant_message is present", () => {
    const s = useChatStore.getState();
    s.appendStreaming("I'm thinking");
    s.appendStreaming(" about it");

    const event: StopEvent = {
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
      last_assistant_message: "Done!",
    };
    processHookEvent(event);

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(2);
    expect(msgs[0].type).toBe("streaming");
    expect(msgs[0].text).toBe("I'm thinking about it");
    expect(msgs[1].type).toBe("assistant");
    expect(msgs[1].text).toBe("Done!");
  });

  test("Stop without last_assistant_message only finalizes streaming", () => {
    useChatStore.getState().appendStreaming("trailing text");

    processHookEvent({
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
    } as StopEvent);

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("streaming");
    expect(msgs[0].text).toBe("trailing text");
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
    // Simulate optimistic add from the view layer (before sendChat)
    useChatStore.getState().addMessage({
      id: makeId(),
      type: "user",
      text: "ping",
      source: "local",
      ts: Date.now(),
    });
    expect(useChatStore.getState().messages.length).toBe(1);

    // Daemon echoes the same prompt back via hook event
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "ping",
      }),
    );

    const msgs = useChatStore.getState().messages;
    // Should still be 1 — the optimistic local message covers the echo
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

  test("UserPromptSubmit de-dups even after streaming text is finalized between add and echo", () => {
    // Simulate: user sends optimistically, PTY streams partial bytes
    // (which the app stores in streamingText), then the echoed hook
    // event fires. finalizeStreaming inside processHookEvent will append
    // a "streaming" message, which must NOT fool the dedup scan.
    useChatStore.getState().addMessage({
      id: makeId(),
      type: "user",
      text: "ping",
      source: "local",
      ts: Date.now(),
    });
    useChatStore.getState().appendStreaming("partial bytes before echo");

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "ping",
      }),
    );

    const msgs = useChatStore.getState().messages;
    // Expected: user (local) + streaming (finalized), NO duplicate user.
    expect(msgs.length).toBe(2);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("ping");
    expect(msgs[1].type).toBe("streaming");
    expect(msgs[1].text).toBe("partial bytes before echo");
  });

  test("backward scan stops after first non-match so delayed echoes are not swallowed", () => {
    // Documents the deliberate `break` in the backward scan: once the most
    // recent user message fails to match, older user messages are NOT
    // revisited. User types "A", then "B" (both optimistic), then the
    // delayed echo for "A" arrives; we want A(local) + B(local) + A(remote),
    // not a silent swallow of the echo.
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
    // Daemon appends "\n" before writing to PTY; the hook event may round-
    // trip either form. Dedup compares trimmed text so both match.
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
    // Prior user message without source: "local" (e.g. from previous session replay)
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
    // Both should exist — dedup only applies when a local-origin optimistic
    // message is the most recent user message.
    expect(msgs.length).toBe(2);
  });

  test("UserPromptSubmit does NOT de-dup against a prior source: 'remote' user message", () => {
    // Prior remote-origin user message (e.g. replay from another frontend).
    // Only source === "local" triggers dedup; "remote" is informational.
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

  test("optimistic send -> daemon echo -> streaming -> stop (no duplicate user bubble)", () => {
    // UI calls addOptimisticUserMessage then transport.sendChat
    addOptimisticUserMessage("How are you?");
    expect(useChatStore.getState().messages.length).toBe(1);

    // Daemon echoes the prompt back via hook event
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "How are you?",
      }),
    );
    // Streaming response
    useChatStore.getState().appendStreaming("I'm ");
    useChatStore.getState().appendStreaming("fine.");
    processHookEvent({
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
      last_assistant_message: "I'm fine.",
    } as StopEvent);

    const msgs = useChatStore.getState().messages;
    // Exactly: user (local optimistic) → streaming → assistant
    expect(msgs.length).toBe(3);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("How are you?");
    expect(msgs[0].source).toBe("local");
    expect(msgs[1].type).toBe("streaming");
    expect(msgs[2].type).toBe("assistant");
  });

  test("full conversation: prompt -> streaming chunks -> stop finalizes", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "How are you?",
      }),
    );
    useChatStore.getState().appendStreaming("I'm ");
    useChatStore.getState().appendStreaming("fine, ");
    useChatStore.getState().appendStreaming("thanks.");
    processHookEvent({
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
      last_assistant_message: "I'm fine, thanks.",
    } as StopEvent);

    const msgs = useChatStore.getState().messages;
    // user → streaming → assistant
    expect(msgs.length).toBe(3);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("How are you?");
    expect(msgs[0].source).toBe("remote");
    expect(msgs[1].type).toBe("streaming");
    expect(msgs[1].text).toBe("I'm fine, thanks.");
    expect(msgs[2].type).toBe("assistant");
    expect(msgs[2].text).toBe("I'm fine, thanks.");
    expect(useChatStore.getState().streamingText).toBe("");
  });
});

describe("chat-store: isAssistantResponding latch", () => {
  beforeEach(resetStore);

  test("starts closed", () => {
    expect(useChatStore.getState().isAssistantResponding).toBe(false);
  });

  test("UserPromptSubmit opens the gate", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "hi",
      }),
    );
    expect(useChatStore.getState().isAssistantResponding).toBe(true);
  });

  test("Stop closes the gate", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "hi",
      }),
    );
    expect(useChatStore.getState().isAssistantResponding).toBe(true);

    processHookEvent({
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
    } as StopEvent);

    expect(useChatStore.getState().isAssistantResponding).toBe(false);
  });

  test("clear() resets the gate", () => {
    useChatStore.getState().setAssistantResponding(true);
    expect(useChatStore.getState().isAssistantResponding).toBe(true);

    useChatStore.getState().clear();
    expect(useChatStore.getState().isAssistantResponding).toBe(false);
  });

  test("setAssistantResponding can be toggled directly", () => {
    const s = useChatStore.getState();
    s.setAssistantResponding(true);
    expect(useChatStore.getState().isAssistantResponding).toBe(true);
    s.setAssistantResponding(false);
    expect(useChatStore.getState().isAssistantResponding).toBe(false);
  });

  test("INSERT-mode scenario: PTY io between Stop and next UserPromptSubmit does NOT pollute streaming", () => {
    // Reproduces the v0.1.x P1: after a turn ends with Stop, the user enters
    // INSERT-mode in claude's editor. Many PTY io frames arrive (autocomplete
    // dropdown, repaints, echoed keystrokes). If we naively appendStreaming
    // each one, the next UserPromptSubmit's finalizeStreaming would commit
    // that garbage as a "streaming" ChatMessage. The view layer guards
    // appendStreaming on `isAssistantResponding === true` — this test
    // verifies the latch state that drives that guard.
    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "first question",
      }),
    );
    useChatStore.getState().appendStreaming("real answer");
    processHookEvent({
      session_id: "sess",
      hook_event_name: "Stop",
      cwd: "/tmp",
      last_assistant_message: "real answer",
    } as StopEvent);

    // Gate is now closed — view layer would skip appendStreaming for PTY
    // io frames arriving here.
    expect(useChatStore.getState().isAssistantResponding).toBe(false);

    // Simulate: user is in INSERT mode. View skips appendStreaming because
    // gate is closed. (If buggy: would call appendStreaming("garbage echo").)
    // No state change in test — we are verifying the contract.

    processHookEvent(
      baseEvent({
        hook_event_name: "UserPromptSubmit",
        user_prompt: "second question",
      }),
    );

    const msgs = useChatStore.getState().messages;
    // user(first) -> streaming(real answer) -> assistant(real answer) ->
    // user(second). No "garbage echo" streaming bubble.
    expect(msgs.length).toBe(4);
    expect(msgs[0].type).toBe("user");
    expect(msgs[0].text).toBe("first question");
    expect(msgs[1].type).toBe("streaming");
    expect(msgs[1].text).toBe("real answer");
    expect(msgs[2].type).toBe("assistant");
    expect(msgs[3].type).toBe("user");
    expect(msgs[3].text).toBe("second question");
    expect(useChatStore.getState().streamingText).toBe("");
  });
});
