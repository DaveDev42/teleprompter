import type {
  HookEventBase,
  PostToolUseEvent,
  PreToolUseEvent,
  StopEvent,
} from "@teleprompter/protocol/client";
import { create } from "zustand";

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
  /**
   * Origin of the message. "local" marks optimistic user bubbles added before
   * the daemon round-trip; the matching `UserPromptSubmit` hook event is then
   * de-duplicated so the same text does not render twice.
   */
  source?: "local" | "remote";
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
      set((s) => ({
        messages: [...s.messages, msg],
        showTerminalFallback: true,
      }));
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

  clear: () =>
    set({ messages: [], streamingText: "", showTerminalFallback: false }),
}));

/**
 * Optimistically append a local user bubble to the chat store. Called by
 * `sendChat` callers so the user sees their own message immediately, without
 * waiting for the daemon's `UserPromptSubmit` round-trip. The echoed hook
 * event is de-duplicated against the `source: "local"` marker — but only
 * when the optimistic message is still the most recent user message when
 * the echo arrives (see `processHookEvent` backward-scan semantics).
 */
export function addOptimisticUserMessage(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  useChatStore.getState().addMessage({
    id: makeId(),
    type: "user",
    text: trimmed,
    source: "local",
    ts: Date.now(),
  });
}

/**
 * Process a hook event record into chat messages.
 */
export function processHookEvent(event: HookEventBase) {
  const store = useChatStore.getState();
  const name = event.hook_event_name;

  switch (name) {
    case "UserPromptSubmit": {
      // finalizeStreaming() mutates the store, so re-read live messages for
      // the dedup scan below.
      store.finalizeStreaming();
      const promptText =
        (event.user_prompt as string) ?? (event.prompt as string) ?? "";
      // De-dup against a freshly added optimistic local user bubble.
      // The view layer adds `source: "local"` immediately before calling
      // `client.sendChat`; the daemon then echoes the same prompt back via
      // this hook event, which would otherwise duplicate the bubble. Scan
      // backward skipping non-user messages (a streaming message may have
      // been appended by finalizeStreaming just above), and match on
      // trimmed text — the daemon appends `\n` before writing to the PTY,
      // but Claude's hook may round-trip either form.
      const liveMsgs = useChatStore.getState().messages;
      const trimmedPrompt = promptText.trim();
      for (let i = liveMsgs.length - 1; i >= 0; i--) {
        const m = liveMsgs[i];
        if (m.type !== "user") continue;
        if (m.source === "local" && m.text.trim() === trimmedPrompt) {
          return;
        }
        // The most-recent user message isn't a dedup match; stop here —
        // earlier user messages in the stack belong to prior turns.
        break;
      }
      store.addMessage({
        id: makeId(),
        type: "user",
        event: name,
        text: promptText,
        source: "remote",
        ts: Date.now(),
      });
      break;
    }
    case "Stop": {
      // Finalize streaming text as assistant message
      store.finalizeStreaming();
      const stopEvent = event as StopEvent;
      const lastMsg = stopEvent.last_assistant_message;
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
      const toolEvent = event as PreToolUseEvent;
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
      const toolEvent = event as PostToolUseEvent;
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
        text: `Permission requested: ${(event.tool_name as string) ?? "unknown"}`,
        permissionTool: event.tool_name as string,
        toolInput: event.tool_input,
        ts: Date.now(),
      });
      break;
    }
    case "Elicitation": {
      store.finalizeStreaming();
      const message = (event.message as string) ?? "Input requested";
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
    case "Notification": {
      store.addMessage({
        id: makeId(),
        type: "system",
        event: name,
        text:
          (event.message as string) ??
          (event.title as string) ??
          "Notification",
        ts: Date.now(),
      });
      break;
    }
    default: {
      // Other events: SessionStart, SessionEnd, SubagentStart, etc.
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
