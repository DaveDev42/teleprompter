import stripAnsi from "strip-ansi";
import type { StoredRecord } from "./store/session-db";

export interface ExportSessionMeta {
  sid: string;
  state: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
}

const IO_MERGE_GAP_MS = 2000;

export function formatEventRecord(rec: StoredRecord): string {
  const raw = Buffer.from(rec.payload).toString("utf-8");
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return `### ${rec.name ?? "Event"}\n\n${raw}`;
  }

  switch (rec.name) {
    case "Stop":
      if (data.last_assistant_message) {
        return `### Assistant Response\n\n${data.last_assistant_message}`;
      }
      return `### Assistant Response\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    case "UserPromptSubmit":
      if (data.prompt) {
        return `### User\n\n> ${String(data.prompt).replace(/\n/g, "\n> ")}`;
      }
      return `### User\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    case "PreToolUse":
      return `### Tool Use: ${data.tool_name ?? "unknown"}\n\n\`\`\`json\n${JSON.stringify(data.tool_input, null, 2)}\n\`\`\``;

    case "PostToolUse":
      return `### Tool Result: ${data.tool_name ?? "unknown"}\n\n\`\`\`json\n${JSON.stringify(data.tool_result ?? data.tool_input, null, 2)}\n\`\`\``;

    case "PermissionRequest":
      return `### Permission Request\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    case "Elicitation":
      return `### Elicitation\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    case "ElicitationResult":
      return `### Elicitation Result\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    case "SubagentStart":
      return `### Subagent Start\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    case "SubagentStop":
      return `### Subagent Stop\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    case "SessionStart":
      return `### Session Start\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    case "SessionEnd":
      return `### Session End\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

    default:
      return `### ${rec.name ?? "Event"}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
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
  const raw = Buffer.from(rec.payload).toString("utf-8");
  try {
    const data = JSON.parse(raw);
    return `### Meta: ${rec.name ?? "unknown"}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  } catch {
    return `### Meta: ${rec.name ?? "unknown"}\n\n${raw}`;
  }
}

export function formatMarkdown(
  meta: ExportSessionMeta,
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
