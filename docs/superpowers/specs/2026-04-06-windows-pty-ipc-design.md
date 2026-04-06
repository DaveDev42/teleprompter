# Windows PTY & IPC Support Design

## Overview

Teleprompter의 Runner/Daemon이 Windows에서 동작하도록 PTY, IPC, 서비스 관리, 빌드를 확장한다.
macOS/Linux 기존 동작을 유지하면서 플랫폼 분기를 추가한다.

## Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| PTY (Windows) | Node.js subprocess + `@aspect-build/node-pty` | Bun `Bun.spawn({ terminal })` Windows 미지원 (#25565, 타임라인 없음). Bun N-API vtable 크래시 (#27471)로 Bun 내 node-pty 직접 사용 불가. `@aspect-build/node-pty`는 prebuilt 바이너리 제공 (node-gyp 불필요), node-pty API 호환 |
| PTY (macOS/Linux) | 기존 `Bun.spawn({ terminal })` 유지 | 변경 불필요 |
| IPC (macOS/Linux) | 기존 `Bun.listen({ unix })` / `Bun.connect({ unix })` 유지 | 안정적, 검증됨. `node:net` 호환 레이어에 open 이슈 다수 (#28731 좀비소켓, #27790 segfault, #23911 크래시) |
| IPC (Windows) | `Bun.listen({ unix: named_pipe })` 시도, fallback `node:net` | Bun 내부에 `WindowsNamedPipe.zig` 구현 있음 (#13042 closed). Named Pipe 경로로 `Bun.listen({ unix })` 동작 가능성 있음. 미동작 시 `node:net` fallback |
| Service (Windows) | Task Scheduler (`schtasks.exe`) | macOS LaunchAgent / Linux systemd user unit과 동일 레벨 (유저 세션). Windows 내장, 관리자 권한 불필요 |
| Build | `bun-windows-x64` 타겟 추가 | `bun build --compile` Windows 지원 |

## 1. PTY Platform Abstraction

### File Structure

```
packages/runner/src/pty/
  pty-manager.ts        — factory: platform에 따라 PtyBun 또는 PtyWindows 반환
  pty-bun.ts            — macOS/Linux: Bun.spawn({ terminal }) (기존 코드 이동)
  pty-windows.ts        — Windows: Node.js subprocess로 @aspect-build/node-pty 위임
  pty-windows-host.cjs  — Node.js에서 실행되는 PTY 호스트 스크립트
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
Bun Runner ──stdio JSON──> Node.js pty-windows-host.cjs (@aspect-build/node-pty)
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
{"type":"pid","pid":12345}
```

- Binary data는 base64 인코딩 (JSON lines 호환)
- `pty-windows-host.cjs`는 CommonJS (`@aspect-build/node-pty`가 native addon이라 CJS 필요)
- `@aspect-build/node-pty`는 `packages/runner`의 `optionalDependencies`로 추가 (macOS/Linux에서는 설치 스킵)

### PtyWindows Implementation

```typescript
class PtyWindows implements PtyManager {
  private child: ChildProcess | null = null;

  spawn(opts: PtyOptions): void {
    // child_process.spawn('node', [hostScriptPath], { stdio: ['pipe','pipe','inherit'] })
    // Send spawn message via stdin JSON line
    // Listen stdout for data/exit/pid messages
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

## 2. IPC: Platform-Specific Transport

### Strategy

macOS/Linux와 Windows의 IPC 전송 레이어를 분리한다.
기존 macOS/Linux 코드를 변경하지 않고, Windows 전용 분기만 추가한다.

- **macOS/Linux**: `Bun.listen({ unix })` / `Bun.connect({ unix })` (기존 그대로)
- **Windows**: `Bun.listen({ unix: named_pipe_path })` 시도 → 실패 시 `node:net` fallback

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

### IpcServer Changes

```typescript
export class IpcServer {
  start(socketPath?: string): string {
    const path = socketPath ?? getSocketPath();

    if (process.platform === "win32") {
      return this.startWindows(path);
    }
    return this.startUnix(path);
  }

  private startUnix(path: string): string {
    // 기존 Bun.listen({ unix: path }) 코드 그대로
  }

  private startWindows(path: string): string {
    // 1차: Bun.listen({ unix: path }) with named pipe path
    // catch → fallback: node:net createServer().listen(path)
  }
}
```

### IpcClient Changes

```typescript
export class IpcClient {
  async connect(socketPath?: string): Promise<void> {
    const path = socketPath ?? getSocketPath();

    if (process.platform === "win32") {
      return this.connectWindows(path);
    }
    return this.connectUnix(path);
  }

  private async connectUnix(path: string): Promise<void> {
    // 기존 Bun.connect({ unix: path }) 코드 그대로
  }

  private async connectWindows(path: string): Promise<void> {
    // 1차: Bun.connect({ unix: path }) with named pipe path
    // catch → fallback: node:net connect(path)
  }
}
```

### QueuedWriter

macOS/Linux 경로에서는 **변경 없음** (기존 `write(): number` 인터페이스 유지).

Windows `node:net` fallback 경로에서만 어댑터가 필요:
- `node:net` Socket의 `write(): boolean`을 `write(): number` 인터페이스로 래핑
- 또는 Windows 전용 `QueuedWriterNet` 클래스 생성

Bun Named Pipe가 동작하면 어댑터 불필요 (Bun 소켓 인터페이스 동일).

### Stale Socket Cleanup

```typescript
// Unix: 기존 unlinkSync 유지
if (process.platform !== "win32" && existsSync(path)) {
  unlinkSync(path);
}
// Windows: Named Pipes는 프로세스 종료 시 OS가 자동 정리 — cleanup 불필요
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

### Existing Tests (must pass — no changes)

macOS/Linux IPC는 변경 없으므로 기존 테스트가 그대로 regression 검증:
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
| `pty-manager.test.ts` | 기존 테스트 유지 (PtyBun 경로 실행). factory 함수 테스트 추가 |
| `pty-windows.test.ts` | Windows에서만 실행, JSON protocol 검증 (process.platform guard) |
| `socket-path.test.ts` | Windows Named Pipe 경로 포맷 검증 추가 |
| `service-windows.test.ts` | schtasks 명령 생성 검증 |

### Platform Guards

Windows 전용 테스트는 `describe.skipIf(process.platform !== 'win32')` 사용.
macOS/Linux에서는 기존 테스트만 실행되어 regression 없음 확인.

## 6. Dependencies

| Package | Location | Type | Note |
|---------|----------|------|------|
| `@aspect-build/node-pty` | `packages/runner` | `optionalDependencies` | Windows PTY 전용. prebuilt 바이너리 제공 (node-gyp 불필요). macOS/Linux에서는 optional이라 설치 실패해도 무시 |

`bun build --compile` 시 node-pty `.node` 파일은 번들 불가.
Windows PTY 호스트(`pty-windows-host.cjs`)는 Node.js 런타임에서 실행되므로,
Windows에서는 Node.js가 PATH에 있어야 한다 (Claude Code 자체가 Node.js 기반이므로 사전 설치 전제).

**macOS/Linux에서는 추가 설치 없음** — PTY는 `Bun.spawn({ terminal })` 내장.

### Windows PTY 호스트 자동 설치

`@aspect-build/node-pty`는 tp 바이너리에 번들 불가하므로 별도 설치가 필요하다.
유저가 수동으로 `npm install` 하지 않도록, **자동 설치 메커니즘**을 제공한다.

**설치 경로:** `%LOCALAPPDATA%\teleprompter\pty-host\`

**자동 설치 트리거:**
1. **최초 PTY spawn 시** — `PtyWindows.spawn()`이 호출될 때 pty-host 디렉토리 존재 여부 확인. 없으면 자동 설치 후 spawn 진행
2. **`tp upgrade` 시** — tp 바이너리 업그레이드 시 pty-host도 함께 갱신
3. **`tp doctor` 시** — pty-host 상태 진단 + 누락 시 설치 안내

**설치 과정:**
```
1. mkdirSync('%LOCALAPPDATA%\teleprompter\pty-host\')
2. package.json 생성 ({"dependencies":{"@aspect-build/node-pty":"*"}})
3. child_process.execSync('npm install --production', { cwd: ptyHostDir })
4. pty-windows-host.cjs 복사 (tp 바이너리에 임베드된 텍스트로부터)
```

**버전 관리:**
- pty-host 디렉토리에 `.version` 파일로 tp 버전 기록
- `PtyWindows.spawn()` 시 `.version`과 현재 tp 버전 비교, 불일치 시 재설치

**설치 실패 시:**
- 에러 메시지 출력 + `tp doctor` 실행 안내
- Node.js 미설치 시: "Node.js가 필요합니다. https://nodejs.org 에서 설치하세요." 안내

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
