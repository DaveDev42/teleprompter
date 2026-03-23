import { create } from "zustand";
import type { HookEventBase } from "@teleprompter/protocol";

export type ChatMessageType =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "streaming"
  | "elicitation"
  | "permission";

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  event?: string; // hook_event_name
  text: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  /** For elicitation: parsed choices from the message */
  choices?: string[];
  /** For permission: the tool requesting permission */
  permissionTool?: string;
  ts: number;
}

export interface ChatState {
  messages: ChatMessage[];
  /** Partial streaming text from PTY output (between events) */
  streamingText: string;
  /** Show terminal fallback banner when chat can't handle the interaction */
  showTerminalFallback: boolean;

  // Actions
  addMessage: (msg: ChatMessage) => void;
  appendStreaming: (text: string) => void;
  finalizeStreaming: () => void;
  dismissTerminalFallback: () => void;
  clear: () => void;
}

let nextId = 0;
export function makeId(): string {
  return `msg-${++nextId}-${Date.now()}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streamingText: "",
  showTerminalFallback: false,

  addMessage: (msg) => {
    // Show terminal fallback for elicitation/permission (complex interactions)
    if (msg.type === "elicitation" || msg.type === "permission") {
      set((s) => ({ messages: [...s.messages, msg], showTerminalFallback: true }));
    } else {
      set((s) => ({ messages: [...s.messages, msg] }));
    }
  },

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

  dismissTerminalFallback: () => set({ showTerminalFallback: false }),

  clear: () => set({ messages: [], streamingText: "", showTerminalFallback: false }),
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
        type: "permission",
        event: name,
        text: `Permission requested: ${(event as any).tool_name ?? "unknown"}`,
        permissionTool: (event as any).tool_name,
        toolInput: (event as any).tool_input,
        ts: Date.now(),
      });
      break;
    }
    case "Elicitation": {
      store.finalizeStreaming();
      const message = (event as any).message ?? "Input requested";
      // Parse choices from message text (e.g., "A) Yes  B) No" patterns)
      const choices = parseChoices(message);
      store.addMessage({
        id: makeId(),
        type: "elicitation",
        event: name,
        text: message,
        choices: choices.length > 0 ? choices : undefined,
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

/**
 * Parse choices from elicitation text using heuristics.
 * Matches patterns like: "1) Option A  2) Option B" or "A. Yes  B. No"
 */
function parseChoices(text: string): string[] {
  // Pattern: numbered or lettered options separated by newlines or double spaces
  const patterns = [
    /(?:^|\n)\s*(?:\d+|[A-Za-z])[.)]\s*(.+)/g, // "1) Yes" or "A. No"
    /(?:^|\n)\s*[-•]\s*(.+)/g, // "- Option" or "• Option"
  ];

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length >= 2) {
      return matches.map((m) => m[1].trim());
    }
  }

  return [];
}
