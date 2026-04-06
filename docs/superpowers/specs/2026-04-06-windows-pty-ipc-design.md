# Windows PTY & IPC Support Design

## Overview

Teleprompter의 Runner/Daemon이 Windows에서 동작하도록 PTY, IPC, 서비스 관리, 빌드를 확장한다.
macOS/Linux 기존 동작을 유지하면서 플랫폼 분기를 추가한다.

## Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| PTY (Windows) | Node.js subprocess + node-pty | Bun `Bun.spawn({ terminal })` Windows 미지원 (#25565, 타임라인 없음). Bun N-API vtable 크래시 (#27471)로 Bun 내 node-pty 직접 사용 불가. Node.js 런타임에서 node-pty는 안정적 (크래시 0회 보고) |
| PTY (macOS/Linux) | 기존 `Bun.spawn({ terminal })` 유지 | 변경 불필요 |
| IPC | 전 플랫폼 `node:net` 통일 | `Bun.listen({ unix })`는 Windows Named Pipes 미지원. `node:net`은 Bun 내장 호환 레이어로 Unix socket + Named Pipes 모두 지원 (v1.1.28+). 코드 한 벌 관리 |
| Service (Windows) | Task Scheduler (`schtasks.exe`) | macOS LaunchAgent / Linux systemd user unit과 동일 레벨 (유저 세션). Windows 내장, 관리자 권한 불필요 |
| Build | `bun-windows-x64` 타겟 추가 | `bun build --compile` Windows 지원 |

## 1. PTY Platform Abstraction

### File Structure

```
packages/runner/src/pty/
  pty-manager.ts        — factory: platform에 따라 PtyBun 또는 PtyWindows 반환
  pty-bun.ts            — macOS/Linux: Bun.spawn({ terminal }) (기존 코드 이동)
  pty-windows.ts        — Windows: Node.js subprocess로 node-pty 위임
  pty-windows-host.cjs  — Node.js에서 실행되는 node-pty 호스트 스크립트
```

### Interface (변경 없음)

```typescript
export interface PtyOptions {
  command: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  onData: (data: Uint8Array) => void;
  onExit: (exitCode: number) => void;
}

// PtyManager class: spawn, write, resize, kill, pid
```

### PtyManager Factory

`pty-manager.ts`는 현재 직접 `Bun.spawn`을 호출하는 클래스다. 이를 팩토리 패턴으로 변경:

```typescript
export function createPtyManager(): PtyManager {
  if (process.platform === "win32") {
    return new PtyWindows();
  }
  return new PtyBun();
}
```

기존 `PtyManager`를 abstract class 또는 interface로 변환하고, `PtyBun`과 `PtyWindows`가 구현한다.

### Windows PTY Architecture

```
Bun Runner ──stdio JSON──> Node.js pty-windows-host.cjs (node-pty)
                                    │
                                    ├── spawn ConPTY
                                    ├── onData → stdout JSON → Runner
                                    ├── stdin JSON → pty.write()
                                    └── resize/kill command handling
```

**Protocol (stdin/stdout JSON lines):**

Runner → Host:
```jsonl
{"type":"spawn","command":["claude","--resume"],"cwd":"/path","cols":120,"rows":40}
{"type":"write","data":"base64-encoded"}
{"type":"resize","cols":100,"rows":30}
{"type":"kill","signal":15}
```

Host → Runner:
```jsonl
{"type":"data","data":"base64-encoded"}
{"type":"exit","code":0}
{"type":"error","message":"..."}
```

- Binary data는 base64 인코딩 (JSON lines 호환)
- `pty-windows-host.cjs`는 CommonJS (node-pty가 native addon이라 CJS 필요)
- node-pty는 `packages/runner`의 `optionalDependencies`로 추가 (macOS/Linux에서는 설치 스킵)

### PtyWindows Implementation

```typescript
class PtyWindows implements PtyManager {
  private child: ChildProcess | null = null;

  spawn(opts: PtyOptions): void {
    // child_process.spawn('node', [hostScriptPath], { stdio: ['pipe','pipe','inherit'] })
    // Send spawn message via stdin JSON line
    // Listen stdout for data/exit messages
  }

  write(data: string | Uint8Array): void {
    // Send write message via stdin JSON line (base64)
  }

  resize(cols: number, rows: number): void {
    // Send resize message via stdin JSON line
  }

  kill(signal: number = 15): void {
    // Send kill message, then terminate child
  }
}
```

## 2. IPC: `node:net` Unified Transport

### socket-path.ts Changes

```typescript
export function getSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\teleprompter-${process.env.USERNAME}-daemon`;
  }
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    join("/tmp", `teleprompter-${process.getuid?.()}`);
  mkdirSync(runtimeDir, { recursive: true });
  return join(runtimeDir, "daemon.sock");
}
```

Windows Named Pipes:
- 프로세스 종료 시 자동 정리 (stale socket file cleanup 불필요)
- `USERNAME` 환경변수로 유저별 격리

### QueuedWriter Changes

`node:net` Socket의 `write()` → `boolean` 리턴에 맞게 인터페이스 변경:

```typescript
// Before
interface Writable {
  write(data: Uint8Array): number;  // bytes written
}

// After
interface Writable {
  write(data: Uint8Array): boolean;  // true = flushed, false = buffered (wait for drain)
}
```

`node:net` Socket은 내부 버퍼링을 하므로 partial write가 없다.
`write()` 반환값이 `false`면 전체 데이터가 버퍼링된 것이고, `drain` 이벤트에서 큐 처리를 재개한다.

QueuedWriter 로직 변경:
- `write(socket, data)`: `false` 반환 시 이후 데이터를 큐에 추가 (기존과 유사)
- `drain(socket)`: 큐에서 하나씩 꺼내 write, `false` 반환 시 중단 (partial subarray 로직 제거)

### IpcServer Changes (`Bun.listen` → `net.createServer`)

```typescript
import { createServer, type Server, type Socket } from "node:net";

export class IpcServer {
  private server: Server | null = null;

  start(socketPath?: string): string {
    const path = socketPath ?? getSocketPath();

    // Clean up stale socket (Unix only — named pipes auto-clean)
    if (process.platform !== "win32" && existsSync(path)) {
      unlinkSync(path);
    }

    this.server = createServer((socket: Socket) => {
      // open: create ConnectedRunner, attach decoder/writer
      // socket.on('data', ...) → decode frames → events.onMessage
      // socket.on('drain', ...) → writer.drain
      // socket.on('close', ...) → cleanup
      // socket.on('error', ...) → log
    });

    this.server.listen(path);
    return path;
  }

  stop(): void {
    this.server?.close();
  }
}
```

### IpcClient Changes (`Bun.connect` → `net.connect`)

```typescript
import { connect, type Socket } from "node:net";

export class IpcClient {
  async connect(socketPath?: string): Promise<void> {
    const path = socketPath ?? getSocketPath();

    return new Promise((resolve, reject) => {
      this.socket = connect(path, () => resolve());
      this.socket.on('data', (data) => { /* decode + dispatch */ });
      this.socket.on('drain', () => { /* writer.drain */ });
      this.socket.on('error', (err) => { /* log */ reject(err); });
    });
  }
}
```

## 3. Windows Service (Task Scheduler)

### File Structure

```
apps/cli/src/lib/
  service.ts          — win32 분기 추가
  service-windows.ts  — schtasks.exe 기반 등록/해제
```

### service.ts Changes

```typescript
if (os === "win32") {
  const { installWindows } = await import("./service-windows");
  return installWindows();
}
```

### service-windows.ts

- Task name: `TeleprompterDaemon`
- Install: `schtasks /Create /TN TeleprompterDaemon /TR "<tp.exe> daemon start" /SC ONLOGON /RL LIMITED /F`
  - `/RL LIMITED`: 일반 유저 권한
  - `/F`: 기존 동일 이름 태스크 덮어쓰기
- Uninstall: `schtasks /Delete /TN TeleprompterDaemon /F`
- Status check: `schtasks /Query /TN TeleprompterDaemon`
- Log directory: `%LOCALAPPDATA%\teleprompter\logs\`
- Binary resolution: `%LOCALAPPDATA%\Programs\tp\tp.exe`, `%USERPROFILE%\.local\bin\tp.exe` 순서 탐색

### Generated XML (schtasks internally)

schtasks CLI가 내부적으로 XML 태스크를 생성하므로 직접 XML을 다루지 않는다.
stdout/stderr 리다이렉션은 `/TR` 인자에 `> logfile 2>&1` 포함.

## 4. Build Target Addition

### scripts/build.ts Changes

```typescript
const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",   // NEW
] as const;

function outFile(name: string, target: Target): string {
  const suffix = target.replace("bun-", "").replace("-", "_");
  const ext = target.includes("windows") ? ".exe" : "";
  return `${OUT_DIR}/${name}-${suffix}${ext}`;
}
```

### CI/CD

`ci.yml`에 Windows 빌드 job 추가는 이 PR 범위 밖. 빌드 타겟만 추가하고 cross-compile로 생성.

## 5. Testing Strategy

### Existing Tests (must pass)

IPC를 `node:net`으로 변경하므로 기존 macOS/Linux 테스트가 새 구현을 직접 검증:
- `packages/daemon/src/ipc/server.test.ts`
- `packages/runner/src/ipc/client.test.ts`
- `packages/protocol/src/queued-writer.test.ts`
- `packages/protocol/src/socket-path.test.ts`
- `packages/daemon/src/integration.test.ts`
- `packages/daemon/src/e2e.test.ts`
- `apps/cli/src/full-stack.test.ts`

### New/Modified Tests

| Test | Description |
|------|-------------|
| `pty-manager.test.ts` | 기존 테스트 유지 (PtyBun 경로 실행) |
| `pty-windows.test.ts` | Windows에서만 실행, JSON protocol 검증 (process.platform guard) |
| `socket-path.test.ts` | Windows Named Pipe 경로 포맷 검증 추가 |
| `service-windows.test.ts` | schtasks 명령 생성 검증 |
| `queued-writer.test.ts` | boolean 반환 인터페이스 검증 (기존 테스트 수정) |

### Platform Guards

Windows 전용 테스트는 `describe.skipIf(process.platform !== 'win32')` 사용.
macOS/Linux에서는 기존 테스트만 실행되어 regression 없음 확인.

## 6. Dependencies

| Package | Location | Type | Note |
|---------|----------|------|------|
| `node-pty` | `packages/runner` | `optionalDependencies` | Windows에서만 사용. macOS/Linux에서는 optional이라 설치 실패해도 무시 |

`bun build --compile` 시 node-pty `.node` 파일은 번들 불가.
Windows PTY 호스트(`pty-windows-host.cjs`)는 Node.js 런타임에서 실행되므로,
Windows에서는 Node.js가 PATH에 있어야 한다 (Claude Code 자체가 Node.js 기반이므로 사전 설치 전제).
node-pty는 호스트 스크립트의 런타임 의존성으로, tp 바이너리와 별도로 `npm install` 되어야 한다.
설치 경로: `%LOCALAPPDATA%\teleprompter\pty-host\` (package.json + node_modules).

## 7. Documentation Updates

구현 완료 후 업데이트할 문서:
- `CLAUDE.md` — Windows 지원 사항 추가 (PTY, IPC, Service, Build)
- `TODO.md` — Windows PTY/IPC 항목 체크
- `ARCHITECTURE.md` — IPC 섹션에 Named Pipes, PTY 섹션에 Windows 분기 추가
- `PRD.md` — Windows 지원 상태 갱신

## Out of Scope

- Windows CI/CD (GitHub Actions Windows runner)
- Windows installer (`.msi` / Scoop / Chocolatey)
- ARM64 Windows (x64만 지원)
- WSL (이미 Linux로 동작)
