import { create } from "zustand";
import type { HookEventBase } from "@teleprompter/protocol";

export type ChatMessageType =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "streaming";

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  event?: string; // hook_event_name
  text: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  ts: number;
}

export interface ChatState {
  messages: ChatMessage[];
  /** Partial streaming text from PTY output (between events) */
  streamingText: string;

  // Actions
  addMessage: (msg: ChatMessage) => void;
  appendStreaming: (text: string) => void;
  finalizeStreaming: () => void;
  clear: () => void;
}

let nextId = 0;
export function makeId(): string {
  return `msg-${++nextId}-${Date.now()}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streamingText: "",

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  appendStreaming: (text) =>
    set((s) => ({ streamingText: s.streamingText + text })),

  finalizeStreaming: () => {
    const { streamingText } = get();
    if (streamingText.trim()) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: makeId(),
            type: "streaming",
            text: streamingText,
            ts: Date.now(),
          },
        ],
        streamingText: "",
      }));
    } else {
      set({ streamingText: "" });
    }
  },

  clear: () => set({ messages: [], streamingText: "" }),
}));

/**
 * Process a hook event record into chat messages.
 */
export function processHookEvent(event: HookEventBase) {
  const store = useChatStore.getState();
  const name = event.hook_event_name;

  switch (name) {
    case "UserPromptSubmit": {
      // Finalize any streaming text before user message
      store.finalizeStreaming();
      store.addMessage({
        id: makeId(),
        type: "user",
        event: name,
        text: (event as any).user_prompt ?? (event as any).prompt ?? "",
        ts: Date.now(),
      });
      break;
    }
    case "Stop": {
      // Finalize streaming text as assistant message
      store.finalizeStreaming();
      const lastMsg = (event as any).last_assistant_message;
      if (lastMsg) {
        store.addMessage({
          id: makeId(),
          type: "assistant",
          event: name,
          text: lastMsg,
          ts: Date.now(),
        });
      }
      break;
    }
    case "PreToolUse": {
      store.finalizeStreaming();
      const toolEvent = event as any;
      store.addMessage({
        id: makeId(),
        type: "tool",
        event: name,
        text: `Using tool: ${toolEvent.tool_name}`,
        toolName: toolEvent.tool_name,
        toolInput: toolEvent.tool_input,
        ts: Date.now(),
      });
      break;
    }
    case "PostToolUse": {
      const toolEvent = event as any;
      store.addMessage({
        id: makeId(),
        type: "tool",
        event: name,
        text: `Tool result: ${toolEvent.tool_name}`,
        toolName: toolEvent.tool_name,
        toolInput: toolEvent.tool_input,
        toolResult: toolEvent.tool_result,
        ts: Date.now(),
      });
      break;
    }
    case "PermissionRequest": {
      store.finalizeStreaming();
      store.addMessage({
        id: makeId(),
        type: "system",
        event: name,
        text: `Permission requested: ${(event as any).tool_name ?? "unknown"}`,
        ts: Date.now(),
      });
      break;
    }
    case "Elicitation": {
      store.finalizeStreaming();
      store.addMessage({
        id: makeId(),
        type: "system",
        event: name,
        text: (event as any).message ?? "Input requested",
        ts: Date.now(),
      });
      break;
    }
    default: {
      // Other events: SessionStart, SessionEnd, Notification, etc.
      store.addMessage({
        id: makeId(),
        type: "system",
        event: name,
        text: name,
        ts: Date.now(),
      });
      break;
    }
  }
}
