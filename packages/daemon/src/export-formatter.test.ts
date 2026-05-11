import { describe, expect, test } from "bun:test";
import {
  formatEventRecord,
  formatIoRecords,
  formatMarkdown,
} from "./export-formatter";
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
    const rec = makeEventRecord(1, "Stop", {
      last_assistant_message: "Hello world",
    });
    const result = formatEventRecord(rec);
    expect(result).toContain("### Assistant Response");
    expect(result).toContain("Hello world");
  });

  test("UserPromptSubmit formats as blockquote", () => {
    const rec = makeEventRecord(1, "UserPromptSubmit", {
      prompt: "Do something",
    });
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
    const records = [makeIoRecord(1, "  \n  \n", 1000)];
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
      {
        sid: "s",
        state: "stopped",
        cwd: "/",
        createdAt: 0,
        updatedAt: 0,
        lastSeq: 3,
      },
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
      {
        sid: "s",
        state: "stopped",
        cwd: "/",
        createdAt: 0,
        updatedAt: 0,
        lastSeq: 1,
      },
      records,
    );
    expect(result).toContain("### Meta: config");
    expect(result).toContain("```json");
  });

  test("appends truncation notice when truncated flag is set", () => {
    const result = formatMarkdown(
      {
        sid: "s",
        state: "stopped",
        cwd: "/",
        createdAt: 0,
        updatedAt: 0,
        lastSeq: 1,
      },
      [],
      true,
    );
    expect(result).toContain("Export truncated");
  });

  test("formats 50k mixed records under 1000ms (perf SLA)", () => {
    const records: StoredRecord[] = [];
    const N = 50_000;
    const eventNames = [
      "UserPromptSubmit",
      "Stop",
      "PreToolUse",
      "PostToolUse",
    ];
    for (let i = 0; i < N; i++) {
      const r = i % 20;
      if (r < 14) {
        records.push(
          makeIoRecord(i, `line ${i} ${"x".repeat(80)}\n`, 1000 + i),
        );
      } else if (r < 19) {
        const name = eventNames[i % eventNames.length];
        records.push(
          makeEventRecord(
            i,
            name,
            name === "Stop"
              ? { last_assistant_message: `done ${i}` }
              : { prompt: `prompt ${i}` },
            1000 + i,
          ),
        );
      } else {
        records.push(makeMetaRecord(i, "meta", { key: i }, 1000 + i));
      }
    }
    const t = performance.now();
    const md = formatMarkdown(
      {
        sid: "perf",
        state: "stopped",
        cwd: "/",
        createdAt: 0,
        updatedAt: 0,
        lastSeq: N,
      },
      records,
      false,
    );
    const elapsed = performance.now() - t;
    expect(md.length).toBeGreaterThan(1_000_000);
    expect(elapsed).toBeLessThan(1000);
  });
});
