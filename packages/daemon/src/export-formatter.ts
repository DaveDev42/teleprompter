import type { WsSessionMeta } from "@teleprompter/protocol";
import stripAnsi from "strip-ansi";
import type { StoredRecord } from "./store/session-db";

const IO_MERGE_GAP_MS = 2000;

/** Event names that render as `### {Display Name}` + full JSON block */
const JSON_BLOCK_EVENTS: Record<string, string> = {
  PermissionRequest: "Permission Request",
  Elicitation: "Elicitation",
  ElicitationResult: "Elicitation Result",
  SubagentStart: "Subagent Start",
  SubagentStop: "Subagent Stop",
  SessionStart: "Session Start",
  SessionEnd: "Session End",
};

function jsonBlock(heading: string, data: unknown): string {
  return `### ${heading}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

export function formatEventRecord(rec: StoredRecord): string {
  const raw = Buffer.from(rec.payload).toString("utf-8");
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return `### ${rec.name ?? "Event"}\n\n${raw}`;
  }

  if (!data) {
    return `### ${rec.name ?? "Event"}\n\n${raw}`;
  }

  switch (rec.name) {
    case "Stop":
      if (data.last_assistant_message) {
        return `### Assistant Response\n\n${data.last_assistant_message}`;
      }
      return jsonBlock("Assistant Response", data);

    case "UserPromptSubmit":
      if (data.prompt) {
        return `### User\n\n> ${String(data.prompt).replace(/\n/g, "\n> ")}`;
      }
      return jsonBlock("User", data);

    case "PreToolUse":
      return jsonBlock(`Tool Use: ${data.tool_name ?? "unknown"}`, data.tool_input);

    case "PostToolUse":
      return jsonBlock(`Tool Result: ${data.tool_name ?? "unknown"}`, data.tool_result ?? data.tool_input);

    default: {
      const displayName = (rec.name && JSON_BLOCK_EVENTS[rec.name]) ?? rec.name ?? "Event";
      return jsonBlock(displayName, data);
    }
  }
}

export function formatIoRecords(records: StoredRecord[]): string {
  if (records.length === 0) return "";

  const blocks: string[] = [];
  let currentBlock: string[] = [];
  let lastTs = 0;

  for (const rec of records) {
    const text = stripAnsi(Buffer.from(rec.payload).toString("utf-8"));
    if (!text.trim()) continue;

    if (lastTs > 0 && rec.ts - lastTs > IO_MERGE_GAP_MS) {
      if (currentBlock.length > 0) {
        blocks.push(`\`\`\`terminal\n${currentBlock.join("")}\n\`\`\``);
        currentBlock = [];
      }
    }

    currentBlock.push(text);
    lastTs = rec.ts;
  }

  if (currentBlock.length > 0) {
    blocks.push(`\`\`\`terminal\n${currentBlock.join("")}\n\`\`\``);
  }

  return blocks.join("\n\n");
}

function formatMetaRecord(rec: StoredRecord): string {
  const label = `Meta: ${rec.name ?? "unknown"}`;
  const raw = Buffer.from(rec.payload).toString("utf-8");
  try {
    return jsonBlock(label, JSON.parse(raw));
  } catch {
    return `### ${label}\n\n${raw}`;
  }
}

export function formatMarkdown(
  meta: WsSessionMeta,
  records: StoredRecord[],
  truncated = false,
): string {
  const lines: string[] = [];

  lines.push(`# Session: ${meta.sid}`);
  lines.push(`- CWD: ${meta.cwd}`);
  lines.push(`- State: ${meta.state}`);
  lines.push(`- Created: ${new Date(meta.createdAt).toISOString()}`);
  lines.push("");

  let i = 0;
  while (i < records.length) {
    const rec = records[i];

    if (rec.kind === "io") {
      const ioGroup: StoredRecord[] = [];
      while (i < records.length && records[i].kind === "io") {
        ioGroup.push(records[i]);
        i++;
      }
      const formatted = formatIoRecords(ioGroup);
      if (formatted) {
        lines.push(formatted);
        lines.push("");
      }
    } else if (rec.kind === "event") {
      lines.push(formatEventRecord(rec));
      lines.push("");
      i++;
    } else if (rec.kind === "meta") {
      lines.push(formatMetaRecord(rec));
      lines.push("");
      i++;
    } else {
      i++;
    }
  }

  if (truncated) {
    lines.push(`> **Note:** Export truncated at the configured record limit.`);
    lines.push("");
  }

  return lines.join("\n");
}
