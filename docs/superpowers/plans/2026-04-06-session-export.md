# Session Export Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand session export to include all event types, PTY io records (ANSI-stripped), filtering options, higher limits, and frontend download/share delivery.

**Architecture:** Extend protocol types with filter options → add filtered DB query → rewrite daemon export formatter with per-event-type markdown rendering and ANSI-stripped io blocks → add frontend response handler with platform-specific file delivery (Web: blob download, iOS/Android: Share Sheet).

**Tech Stack:** TypeScript, Bun, SQLite, strip-ansi, expo-sharing, expo-file-system

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/protocol/src/types/ws.ts` | Modify | Add filter fields to `WsSessionExport` |
| `packages/daemon/src/store/session-db.ts` | Modify | Add `getRecordsFiltered()` method |
| `packages/daemon/src/store/session-db.test.ts` | Modify | Tests for `getRecordsFiltered()` |
| `packages/daemon/src/export-formatter.ts` | Create | Markdown/JSON formatting logic extracted from daemon |
| `packages/daemon/src/export-formatter.test.ts` | Create | Tests for formatter |
| `packages/daemon/src/daemon.ts` | Modify | Rewrite `handleSessionExport()` to use new formatter |
| `packages/daemon/src/transport/ws-server.ts` | Modify | Pass full export options to handler |
| `packages/daemon/package.json` | Modify | Add `strip-ansi` dependency |
| `apps/app/src/lib/ws-client.ts` | Modify | Handle `session.exported`, extend `exportSession()` |
| `apps/app/src/components/SessionDrawer.tsx` | Modify | Loading state + platform delivery |
| `apps/app/package.json` | Modify | Add `expo-sharing`, `expo-file-system` |
| `TODO.md` | Modify | Mark export items as done |

---

### Task 1: Add `strip-ansi` dependency to daemon

**Files:**
- Modify: `packages/daemon/package.json`

- [ ] **Step 1: Install strip-ansi**

```bash
cd packages/daemon && pnpm add strip-ansi
```

Note: `strip-ansi` v7+ is ESM-only. Bun handles ESM natively, so this is fine.

- [ ] **Step 2: Verify import works**

```bash
cd packages/daemon && bun -e "import stripAnsi from 'strip-ansi'; console.log(stripAnsi('\x1b[31mhello\x1b[0m'))"
```

Expected: `hello`

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/package.json pnpm-lock.yaml
git commit -m "chore: add strip-ansi dependency to daemon"
```

---

### Task 2: Extend protocol types with export filter options

**Files:**
- Modify: `packages/protocol/src/types/ws.ts:100-104`

- [ ] **Step 1: Update `WsSessionExport` interface**

In `packages/protocol/src/types/ws.ts`, replace the existing `WsSessionExport` interface (lines 100-104):

```typescript
export interface WsSessionExport {
  t: "session.export";
  sid: string;
  format?: "json" | "markdown";
  recordTypes?: RecordKind[];
  timeRange?: { from?: number; to?: number };
  limit?: number;
}
```

- [ ] **Step 2: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS (all fields are optional, so existing code is compatible)

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/types/ws.ts
git commit -m "feat: add filter options to WsSessionExport protocol type"
```

---

### Task 3: Add `getRecordsFiltered()` to SessionDb

**Files:**
- Modify: `packages/daemon/src/store/session-db.ts`
- Modify: `packages/daemon/src/store/session-db.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/daemon/src/store/session-db.test.ts`:

```typescript
describe("getRecordsFiltered", () => {
  test("returns all records with no filters", () => {
    db.append("io", 1000, Buffer.from("a"));
    db.append("event", 2000, Buffer.from("b"), "claude", "Stop");
    db.append("meta", 3000, Buffer.from("c"));
    const records = db.getRecordsFiltered({});
    expect(records.length).toBe(3);
  });

  test("filters by kind", () => {
    db.append("io", 1000, Buffer.from("a"));
    db.append("event", 2000, Buffer.from("b"), "claude", "Stop");
    db.append("meta", 3000, Buffer.from("c"));
    const events = db.getRecordsFiltered({ kinds: ["event"] });
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("event");
  });

  test("filters by multiple kinds", () => {
    db.append("io", 1000, Buffer.from("a"));
    db.append("event", 2000, Buffer.from("b"), "claude", "Stop");
    db.append("meta", 3000, Buffer.from("c"));
    const result = db.getRecordsFiltered({ kinds: ["io", "meta"] });
    expect(result.length).toBe(2);
    expect(result[0].kind).toBe("io");
    expect(result[1].kind).toBe("meta");
  });

  test("filters by time range (from only)", () => {
    db.append("io", 1000, Buffer.from("a"));
    db.append("io", 2000, Buffer.from("b"));
    db.append("io", 3000, Buffer.from("c"));
    const result = db.getRecordsFiltered({ from: 2000 });
    expect(result.length).toBe(2);
    expect(result[0].ts).toBe(2000);
  });

  test("filters by time range (to only)", () => {
    db.append("io", 1000, Buffer.from("a"));
    db.append("io", 2000, Buffer.from("b"));
    db.append("io", 3000, Buffer.from("c"));
    const result = db.getRecordsFiltered({ to: 2000 });
    expect(result.length).toBe(2);
    expect(result[1].ts).toBe(2000);
  });

  test("filters by time range (from and to)", () => {
    db.append("io", 1000, Buffer.from("a"));
    db.append("io", 2000, Buffer.from("b"));
    db.append("io", 3000, Buffer.from("c"));
    const result = db.getRecordsFiltered({ from: 1500, to: 2500 });
    expect(result.length).toBe(1);
    expect(result[0].ts).toBe(2000);
  });

  test("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      db.append("io", 1000 + i, Buffer.from(`msg-${i}`));
    }
    const result = db.getRecordsFiltered({ limit: 3 });
    expect(result.length).toBe(3);
  });

  test("combines kind filter with time range", () => {
    db.append("io", 1000, Buffer.from("a"));
    db.append("event", 2000, Buffer.from("b"), "claude", "Stop");
    db.append("io", 3000, Buffer.from("c"));
    db.append("event", 4000, Buffer.from("d"), "claude", "Stop");
    const result = db.getRecordsFiltered({ kinds: ["event"], from: 1500 });
    expect(result.length).toBe(2);
    expect(result[0].ts).toBe(2000);
    expect(result[1].ts).toBe(4000);
  });

  test("default limit is 50000", () => {
    db.append("io", 1000, Buffer.from("a"));
    // Just verify it doesn't crash with default limit
    const result = db.getRecordsFiltered({});
    expect(result.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon && bun test src/store/session-db.test.ts
```

Expected: FAIL — `db.getRecordsFiltered is not a function`

- [ ] **Step 3: Implement `getRecordsFiltered()`**

In `packages/daemon/src/store/session-db.ts`, add method to `SessionDb` class after `getRecordsFrom()`:

```typescript
getRecordsFiltered(opts: {
  kinds?: RecordKind[];
  from?: number;
  to?: number;
  limit?: number;
}): StoredRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.kinds && opts.kinds.length > 0) {
    conditions.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    params.push(...opts.kinds);
  }
  if (opts.from !== undefined) {
    conditions.push("ts >= ?");
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    conditions.push("ts <= ?");
    params.push(opts.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 50000, 50000);
  const sql = `SELECT seq, kind, ts, ns, name, payload FROM records ${where} ORDER BY seq LIMIT ?`;
  params.push(limit);

  return this.db.prepare(sql).all(...params) as StoredRecord[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/daemon && bun test src/store/session-db.test.ts
```

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/store/session-db.ts packages/daemon/src/store/session-db.test.ts
git commit -m "feat: add getRecordsFiltered() to SessionDb with kind/time/limit filters"
```

---

### Task 4: Create export formatter module

**Files:**
- Create: `packages/daemon/src/export-formatter.ts`
- Create: `packages/daemon/src/export-formatter.test.ts`

- [ ] **Step 1: Write failing tests for event formatting**

Create `packages/daemon/src/export-formatter.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { formatMarkdown, formatEventRecord, formatIoRecords } from "./export-formatter";
import type { StoredRecord } from "./store/session-db";

function makeEventRecord(
  seq: number,
  name: string,
  payload: Record<string, unknown>,
  ts = 1000,
): StoredRecord {
  return {
    seq,
    kind: "event",
    ts,
    ns: "claude",
    name,
    payload: Buffer.from(JSON.stringify(payload)),
  };
}

function makeIoRecord(seq: number, data: string, ts = 1000): StoredRecord {
  return {
    seq,
    kind: "io",
    ts,
    ns: null,
    name: null,
    payload: Buffer.from(data),
  };
}

function makeMetaRecord(
  seq: number,
  name: string,
  payload: Record<string, unknown>,
  ts = 1000,
): StoredRecord {
  return {
    seq,
    kind: "meta",
    ts,
    ns: "daemon",
    name,
    payload: Buffer.from(JSON.stringify(payload)),
  };
}

describe("formatEventRecord", () => {
  test("Stop event extracts last_assistant_message", () => {
    const rec = makeEventRecord(1, "Stop", { last_assistant_message: "Hello world" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Assistant Response");
    expect(result).toContain("Hello world");
  });

  test("UserPromptSubmit formats as blockquote", () => {
    const rec = makeEventRecord(1, "UserPromptSubmit", { prompt: "Do something" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### User");
    expect(result).toContain("> Do something");
  });

  test("PreToolUse formats tool name and input", () => {
    const rec = makeEventRecord(1, "PreToolUse", {
      tool_name: "Read",
      tool_input: { path: "/foo/bar.ts" },
    });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Tool Use: Read");
    expect(result).toContain("```json");
    expect(result).toContain("/foo/bar.ts");
  });

  test("PostToolUse formats tool name and result", () => {
    const rec = makeEventRecord(1, "PostToolUse", {
      tool_name: "Read",
      tool_input: { path: "/foo" },
      tool_result: "file contents here",
    });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Tool Result: Read");
    expect(result).toContain("```json");
  });

  test("PermissionRequest formats as JSON block", () => {
    const rec = makeEventRecord(1, "PermissionRequest", {
      tool_name: "Bash",
      permission: "allow",
    });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Permission Request");
    expect(result).toContain("```json");
  });

  test("Elicitation formats as JSON block", () => {
    const rec = makeEventRecord(1, "Elicitation", { question: "Continue?" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Elicitation");
  });

  test("ElicitationResult formats as JSON block", () => {
    const rec = makeEventRecord(1, "ElicitationResult", { answer: "yes" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Elicitation Result");
  });

  test("SubagentStart formats metadata", () => {
    const rec = makeEventRecord(1, "SubagentStart", { agent_id: "abc" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Subagent Start");
  });

  test("SubagentStop formats metadata", () => {
    const rec = makeEventRecord(1, "SubagentStop", { agent_id: "abc" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Subagent Stop");
  });

  test("SessionStart formats metadata", () => {
    const rec = makeEventRecord(1, "SessionStart", { session_id: "abc" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Session Start");
  });

  test("SessionEnd formats metadata", () => {
    const rec = makeEventRecord(1, "SessionEnd", { session_id: "abc" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Session End");
  });

  test("unknown event falls back to JSON", () => {
    const rec = makeEventRecord(1, "Notification", { text: "something" });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Notification");
    expect(result).toContain("```json");
  });

  test("malformed payload falls back to raw text", () => {
    const rec: StoredRecord = {
      seq: 1,
      kind: "event",
      ts: 1000,
      ns: "claude",
      name: "Stop",
      payload: Buffer.from("not json"),
    };
    const result = formatEventRecord(rec);
    expect(result).toContain("### Stop");
    expect(result).toContain("not json");
  });
});

describe("formatIoRecords", () => {
  test("strips ANSI escape sequences", () => {
    const records = [makeIoRecord(1, "\x1b[31mhello\x1b[0m world")];
    const result = formatIoRecords(records);
    expect(result).toContain("hello world");
    expect(result).not.toContain("\x1b[");
  });

  test("merges consecutive io records within 2s gap", () => {
    const records = [
      makeIoRecord(1, "line1\n", 1000),
      makeIoRecord(2, "line2\n", 2000),
    ];
    const result = formatIoRecords(records);
    // Should be one code block
    const blockCount = (result.match(/```terminal/g) || []).length;
    expect(blockCount).toBe(1);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  test("splits io records with >2s gap into separate blocks", () => {
    const records = [
      makeIoRecord(1, "line1\n", 1000),
      makeIoRecord(2, "line2\n", 5000),
    ];
    const result = formatIoRecords(records);
    const blockCount = (result.match(/```terminal/g) || []).length;
    expect(blockCount).toBe(2);
  });

  test("skips whitespace-only io records", () => {
    const records = [
      makeIoRecord(1, "  \n  \n", 1000),
    ];
    const result = formatIoRecords(records);
    expect(result).toBe("");
  });

  test("handles empty input", () => {
    const result = formatIoRecords([]);
    expect(result).toBe("");
  });
});

describe("formatMarkdown", () => {
  test("generates header with session metadata", () => {
    const result = formatMarkdown(
      {
        sid: "test-123",
        state: "stopped",
        cwd: "/home/user/project",
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        lastSeq: 10,
      },
      [],
    );
    expect(result).toContain("# Session: test-123");
    expect(result).toContain("CWD: /home/user/project");
    expect(result).toContain("State: stopped");
  });

  test("interleaves event and io records by seq order", () => {
    const records: StoredRecord[] = [
      makeEventRecord(1, "UserPromptSubmit", { prompt: "Hello" }, 1000),
      makeIoRecord(2, "processing...\n", 2000),
      makeEventRecord(3, "Stop", { last_assistant_message: "Done" }, 3000),
    ];
    const result = formatMarkdown(
      { sid: "s", state: "stopped", cwd: "/", createdAt: 0, updatedAt: 0, lastSeq: 3 },
      records,
    );
    const userIdx = result.indexOf("### User");
    const termIdx = result.indexOf("```terminal");
    const assistantIdx = result.indexOf("### Assistant Response");
    expect(userIdx).toBeLessThan(termIdx);
    expect(termIdx).toBeLessThan(assistantIdx);
  });

  test("formats meta records as JSON blocks", () => {
    const records = [makeMetaRecord(1, "config", { key: "value" })];
    const result = formatMarkdown(
      { sid: "s", state: "stopped", cwd: "/", createdAt: 0, updatedAt: 0, lastSeq: 1 },
      records,
    );
    expect(result).toContain("### Meta: config");
    expect(result).toContain("```json");
  });

  test("appends truncation notice when truncated flag is set", () => {
    const result = formatMarkdown(
      { sid: "s", state: "stopped", cwd: "/", createdAt: 0, updatedAt: 0, lastSeq: 1 },
      [],
      true,
    );
    expect(result).toContain("Export truncated");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon && bun test src/export-formatter.test.ts
```

Expected: FAIL — cannot resolve `./export-formatter`

- [ ] **Step 3: Implement export formatter**

Create `packages/daemon/src/export-formatter.ts`:

```typescript
import stripAnsi from "strip-ansi";
import type { StoredRecord } from "./store/session-db";

interface ExportSessionMeta {
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

  // Header
  lines.push(`# Session: ${meta.sid}`);
  lines.push(`- CWD: ${meta.cwd}`);
  lines.push(`- State: ${meta.state}`);
  lines.push(`- Created: ${new Date(meta.createdAt).toISOString()}`);
  lines.push("");

  // Group consecutive io records for merging, process others inline
  let i = 0;
  while (i < records.length) {
    const rec = records[i];

    if (rec.kind === "io") {
      // Collect consecutive io records
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/daemon && bun test src/export-formatter.test.ts
```

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/export-formatter.ts packages/daemon/src/export-formatter.test.ts
git commit -m "feat: add export formatter with full event type support and ANSI-stripped IO"
```

---

### Task 5: Wire up daemon export handler with new formatter and filters

**Files:**
- Modify: `packages/daemon/src/transport/ws-server.ts:39, 204-206`
- Modify: `packages/daemon/src/daemon.ts:120-122, 611-683`

- [ ] **Step 1: Update WsServerEvents to pass full export message**

In `packages/daemon/src/transport/ws-server.ts`, change line 39:

```typescript
// Before:
onSessionExport?(client: WsClient, sid: string, format?: string): void;

// After:
onSessionExport?(client: WsClient, msg: WsClientMessage & { t: "session.export" }): void;
```

Update dispatch case (lines 204-206):

```typescript
// Before:
case "session.export":
  this.events.onSessionExport?.(client, msg.sid, msg.format);
  break;

// After:
case "session.export":
  this.events.onSessionExport?.(client, msg);
  break;
```

- [ ] **Step 2: Update daemon event handler registration**

In `packages/daemon/src/daemon.ts`, change lines 120-122:

```typescript
// Before:
onSessionExport: (client, sid, format) => {
  this.handleSessionExport(client, sid, format);
},

// After:
onSessionExport: (client, msg) => {
  this.handleSessionExport(client, msg);
},
```

- [ ] **Step 3: Rewrite `handleSessionExport()`**

In `packages/daemon/src/daemon.ts`, replace the `handleSessionExport` method (lines 611-683):

```typescript
private handleSessionExport(
  client: WsClient,
  msg: WsClientMessage & { t: "session.export" },
): void {
  const { sid, format, recordTypes, timeRange, limit } = msg as {
    sid: string;
    format?: "json" | "markdown";
    recordTypes?: RecordKind[];
    timeRange?: { from?: number; to?: number };
    limit?: number;
  };

  const session = this.store.getSession(sid);
  if (!session) {
    this.clientRegistry.send(client, {
      t: "err",
      e: "NOT_FOUND",
      m: `Session ${sid} not found`,
    });
    return;
  }

  const db = this.store.getSessionDb(sid);
  if (!db) {
    this.clientRegistry.send(client, {
      t: "err",
      e: "NOT_FOUND",
      m: `Session DB for ${sid} not found`,
    });
    return;
  }

  const effectiveLimit = Math.min(limit ?? 50000, 50000);
  const records = db.getRecordsFiltered({
    kinds: recordTypes,
    from: timeRange?.from,
    to: timeRange?.to,
    limit: effectiveLimit,
  });

  const meta = toWsSessionMeta(session);
  const truncated = records.length >= effectiveLimit;

  if (format === "json") {
    this.clientRegistry.send(client, {
      t: "session.exported" as const,
      sid,
      format: "json" as const,
      d: JSON.stringify({ meta, records, truncated }),
    });
  } else {
    const md = formatMarkdown(meta, records, truncated);
    this.clientRegistry.send(client, {
      t: "session.exported" as const,
      sid,
      format: "markdown" as const,
      d: md,
    });
  }
}
```

Add import at top of `daemon.ts`:

```typescript
import { formatMarkdown } from "./export-formatter";
```

- [ ] **Step 4: Run all daemon tests**

```bash
cd packages/daemon && bun test
```

Expected: ALL PASS

- [ ] **Step 5: Run full type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/daemon.ts packages/daemon/src/transport/ws-server.ts
git commit -m "feat: wire daemon export handler with filtered queries and new formatter"
```

---

### Task 6: Add frontend dependencies (expo-sharing, expo-file-system)

**Files:**
- Modify: `apps/app/package.json`

- [ ] **Step 1: Install dependencies**

```bash
cd apps/app && npx expo install expo-sharing expo-file-system
```

- [ ] **Step 2: Commit**

```bash
git add apps/app/package.json pnpm-lock.yaml
git commit -m "chore: add expo-sharing and expo-file-system to app"
```

---

### Task 7: Add `session.exported` handler to ws-client and SessionDrawer delivery

**Files:**
- Modify: `apps/app/src/lib/ws-client.ts:76-85, 140-179, 260-262`
- Modify: `apps/app/src/components/SessionDrawer.tsx`

- [ ] **Step 1: Extend WsEventHandler type**

In `apps/app/src/lib/ws-client.ts`, add to `WsEventHandler` (after line 84):

```typescript
onSessionExported?: (sid: string, format: string, content: string) => void;
```

- [ ] **Step 2: Add case to handleMessage**

In `apps/app/src/lib/ws-client.ts`, add case after the `worktree.created` case (line 177):

```typescript
case "session.exported":
  this.handlers.onSessionExported?.(msg.sid, msg.format, msg.d);
  break;
```

- [ ] **Step 3: Extend exportSession method**

In `apps/app/src/lib/ws-client.ts`, replace `exportSession` method (lines 260-262):

```typescript
exportSession(
  sid: string,
  format: "json" | "markdown" = "markdown",
  opts?: { recordTypes?: string[]; timeRange?: { from?: number; to?: number }; limit?: number },
) {
  this.send({
    t: "session.export",
    sid,
    format,
    ...opts,
  } as WsClientMessage);
}
```

- [ ] **Step 4: Update SessionDrawer with loading state and platform delivery**

Replace `apps/app/src/components/SessionDrawer.tsx` export button logic. Changes needed:

Add imports at top:

```typescript
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform } from "react-native";
```

Add state and effect in `SessionDrawer` component (after `const [showWorktreeForm, setShowWorktreeForm] = useState(false);`):

```typescript
const [exportingSid, setExportingSid] = useState<string | null>(null);
const exportCallbackRef = useRef<((sid: string, format: string, content: string) => void) | null>(null);

useEffect(() => {
  const client = getDaemonClient();
  if (!client) return;

  const handler = (sid: string, format: string, content: string) => {
    exportCallbackRef.current?.(sid, format, content);
  };

  // Register the handler on the client
  client.onSessionExported = handler;
  return () => {
    client.onSessionExported = undefined;
  };
}, []);
```

Replace the `exportSession` function:

```typescript
const exportSession = useCallback((sid: string) => {
  const client = getDaemonClient();
  if (!client) return;

  setExportingSid(sid);

  exportCallbackRef.current = async (_sid: string, format: string, content: string) => {
    setExportingSid(null);
    exportCallbackRef.current = null;

    const ext = format === "json" ? "json" : "md";
    const filename = `session-${_sid.slice(0, 8)}.${ext}`;

    if (Platform.OS === "web") {
      // Web: Blob download
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      // Native: expo-file-system + expo-sharing
      try {
        const FileSystem = require("expo-file-system") as typeof import("expo-file-system");
        const Sharing = require("expo-sharing") as typeof import("expo-sharing");
        const fileUri = FileSystem.documentDirectory + filename;
        await FileSystem.writeAsStringAsync(fileUri, content, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        await Sharing.shareAsync(fileUri, {
          mimeType: "text/plain",
          UTI: "public.plain-text",
        });
      } catch (err) {
        console.error("Export share failed:", err);
      }
    }
  };

  client.exportSession(sid, "markdown");
}, []);
```

Update the Export button in `SessionItem` to show loading state. Replace the export `Pressable` block (lines 85-95):

```typescript
{session.state === "stopped" && (
  <Pressable
    onPress={(e) => {
      e.stopPropagation?.();
      onExport();
    }}
    className="bg-tp-surface px-2 py-1 rounded"
    disabled={isExporting}
    style={{ opacity: isExporting ? 0.5 : 1 }}
  >
    {isExporting ? (
      <ActivityIndicator size="small" color="#999" />
    ) : (
      <Text className="text-tp-text-secondary text-xs">Export</Text>
    )}
  </Pressable>
)}
```

Add `isExporting` prop to `SessionItem`:

```typescript
function SessionItem({
  session,
  isActive,
  isExporting,
  onPress,
  onStop,
  onRestart,
  onExport,
}: {
  session: WsSessionMeta;
  isActive: boolean;
  isExporting: boolean;
  onPress: () => void;
  onStop: () => void;
  onRestart: () => void;
  onExport: () => void;
}) {
```

Pass `isExporting` in the FlatList renderItem:

```typescript
<SessionItem
  session={item.session}
  isActive={item.session.sid === currentSid}
  isExporting={exportingSid === item.session.sid}
  onPress={() => switchSession(item.session.sid)}
  onStop={() => stopSession(item.session.sid)}
  onRestart={() => restartSession(item.session.sid)}
  onExport={() => exportSession(item.session.sid)}
/>
```

- [ ] **Step 5: Add `onSessionExported` setter to DaemonWsClient**

In `apps/app/src/lib/ws-client.ts`, add a public setter property to the `DaemonWsClient` class (after `private disposed = false;` around line 93):

```typescript
set onSessionExported(handler: ((sid: string, format: string, content: string) => void) | undefined) {
  this.handlers.onSessionExported = handler;
}
```

- [ ] **Step 6: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/app/src/lib/ws-client.ts apps/app/src/components/SessionDrawer.tsx
git commit -m "feat: add frontend session.exported handler with Web download and native Share Sheet"
```

---

### Task 8: Update TODO.md

**Files:**
- Modify: `TODO.md:131-135`

- [ ] **Step 1: Mark export items as done**

Replace lines 131-135 in `TODO.md`:

```markdown
### Session Export — 기본 수준만 구현
- [x] Markdown export가 `event` 레코드만 추출 — tool calls, permissions, elicitations 등 누락 → 전체 hooks event 포맷팅 (Stop, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Elicitation 등)
- [x] PTY io 레코드 완전히 무시 — 터미널 출력이 export에 포함되지 않음 → strip-ansi로 ANSI escape 제거 후 코드 블록으로 포함
- [x] 필터링/포맷 옵션 없음 — 시간 범위, 레코드 종류 선택 등 미지원 → recordTypes, timeRange, limit 옵션 추가
- [x] 10,000 레코드 hard limit — 대규모 세션에서 잘림 가능 → 50,000 기본값, limit 파라미터로 조정 가능
```

- [ ] **Step 2: Commit**

```bash
git add TODO.md
git commit -m "docs: mark session export improvements as completed in TODO.md"
```

---

### Task 9: Run full test suite and verify

- [ ] **Step 1: Run all backend tests**

```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
```

Expected: ALL PASS

- [ ] **Step 2: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS
