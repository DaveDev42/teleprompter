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
import { makeId, processHookEvent, useChatStore } from "./chat-store";

function resetStore() {
  useChatStore.getState().clear();
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

  function baseEvent<T extends Partial<HookEventBase>>(
    extra: T,
  ): HookEventBase {
    return {
      session_id: "sess",
      hook_event_name: "SessionStart",
      cwd: "/tmp",
      ...extra,
    } as HookEventBase;
  }

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

  test("unknown / default hook events become a system message", () => {
    processHookEvent(
      baseEvent({
        hook_event_name: "SessionStart",
      }),
    );

    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("system");
    expect(msgs[0].event).toBe("SessionStart");
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
    expect(msgs[1].type).toBe("streaming");
    expect(msgs[1].text).toBe("I'm fine, thanks.");
    expect(msgs[2].type).toBe("assistant");
    expect(msgs[2].text).toBe("I'm fine, thanks.");
    expect(useChatStore.getState().streamingText).toBe("");
  });
});
