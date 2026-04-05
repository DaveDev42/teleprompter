# Session Export Improvement Design

## Problem

Current session export has significant gaps:
- Markdown export extracts only `event` records with `Stop`/`UserPromptSubmit` — tool calls, permissions, elicitations are all missing
- PTY `io` records are completely ignored — terminal output not included in export
- No filtering options — no time range, record type selection, or configurable limit
- Hard limit of 10,000 records — large sessions get silently truncated

## Solution Overview

Extend the export pipeline across four layers: protocol types, session DB queries, daemon export formatter, and frontend delivery.

## 1. Protocol Changes

### `WsSessionExport` (Client → Daemon)

```typescript
interface WsSessionExport {
  t: "session.export";
  sid: string;
  format?: "json" | "markdown";       // default: "markdown"
  recordTypes?: RecordKind[];          // default: ["event", "io", "meta"]
  timeRange?: { from?: number; to?: number };
  limit?: number;                      // default: 50000, max: 50000
}
```

New fields are all optional — existing clients work unchanged.

### `WsSessionExported` (Daemon → Client)

No changes. The `d` field contains the formatted result string.

## 2. Session DB — Filtered Query

Add `getRecordsFiltered()` to `SessionDb`:

```typescript
getRecordsFiltered(opts: {
  kinds?: RecordKind[];
  from?: number;     // timestamp lower bound
  to?: number;       // timestamp upper bound
  limit?: number;    // default 50000
}): StoredRecord[]
```

Implementation: dynamic SQL with `WHERE kind IN (?) AND ts >= ? AND ts <= ?` conditions. Existing `getRecordsFrom()` unchanged (used by other paths).

## 3. Markdown Formatter — Event Expansion + IO Inclusion

### Event Records (by `name` field)

| Event Name | Markdown Format |
|------------|----------------|
| `Stop` | `### Assistant Response` + `last_assistant_message` text |
| `UserPromptSubmit` | `### User` + `> prompt` (blockquote) |
| `PreToolUse` | `### Tool Use: {tool_name}` + input JSON code block |
| `PostToolUse` | `### Tool Result: {tool_name}` + result JSON code block |
| `PermissionRequest` | `### Permission Request` + JSON code block |
| `Elicitation` | `### Elicitation` + JSON code block |
| `ElicitationResult` | `### Elicitation Result` + JSON code block |
| `SubagentStart` | `### Subagent Start` + metadata |
| `SubagentStop` | `### Subagent Stop` + metadata |
| `SessionStart` | `### Session Start` + metadata |
| `SessionEnd` | `### Session End` + metadata |
| Others | `### {name}` + full JSON fallback |

### IO Records

- Strip ANSI escape sequences using `strip-ansi` package
- Merge consecutive io records into single code blocks (gap threshold: 2 seconds)
- Skip io records that are empty or whitespace-only after stripping
- Format: ` ```terminal\n{stripped_output}\n``` `

### Meta Records

`### Meta: {name}` + JSON code block.

### Record Ordering

All records sorted by `seq` (already ordered from DB). Timestamps shown as ISO strings in section headers when mixing record types.

## 4. Hard Limit

- Default: 50,000 (up from 10,000)
- Client-configurable via `limit` field, server caps at 50,000
- When truncated, append a notice: `> Note: Export truncated at {limit} records.`

## 5. Frontend Changes

### ws-client.ts — Response Handler

Add `session.exported` case to `handleMessage()`. Invoke a callback registered via Zustand store or event emitter.

### Platform-specific Delivery

- **Web**: Create `Blob` from content → `URL.createObjectURL()` → programmatic `<a download="session-{sid}.md">` click
- **iOS/Android**: Write to temp file via `expo-file-system` → `expo-sharing` `shareAsync()` → Share Sheet

### SessionDrawer.tsx — UX Flow

1. User taps Export button
2. Button shows loading indicator
3. `session.export` message sent with default options
4. On `session.exported` received → platform-specific download/share
5. Loading indicator clears

## 6. Dependencies

- `strip-ansi` added to `packages/daemon/package.json` (daemon-only, used during export formatting)

## 7. Testing

### Unit Tests (session-db)
- `getRecordsFiltered()` with kind filter, time range, limit, combinations

### Unit Tests (export formatter)
- Each event type produces correct markdown heading and body
- IO records: ANSI stripping, consecutive merging, empty skip
- Meta records formatted correctly
- Mixed record types maintain seq order
- Truncation notice appended when limit reached
- JSON format returns all records with metadata

### Integration
- Full export pipeline: store records → export handler → WsSessionExported message
- Filter combinations: recordTypes, timeRange, limit
- Backward compatibility: existing export calls (no new options) still work

## 8. Files to Modify

| File | Changes |
|------|---------|
| `packages/protocol/src/types/ws.ts` | Extend `WsSessionExport` with new fields |
| `packages/daemon/src/store/session-db.ts` | Add `getRecordsFiltered()` |
| `packages/daemon/src/daemon.ts` | Rewrite `handleSessionExport()` |
| `packages/daemon/package.json` | Add `strip-ansi` dependency |
| `apps/app/src/lib/ws-client.ts` | Handle `session.exported` message |
| `apps/app/src/components/SessionDrawer.tsx` | Loading state + platform delivery |
| `packages/daemon/src/store/session-db.test.ts` | New filtered query tests |
| `packages/daemon/src/export.test.ts` | New export formatter tests |
| `TODO.md` | Mark items as completed |
