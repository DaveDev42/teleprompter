Teleprompter PRD

1. 제품 개요

1.1 한줄 요약

Teleprompter는 Expo(React Native + RN Web) Frontend에서 원격의 Daemon(Windows/macOS/Linux)을 통해 Claude Code Session을 제어하는 제품이다. 핵심은 hooks + PTY 하이브리드 Chat UI, PTY terminal streaming, git worktree 직접 관리, QR 기반 E2EE 페어링, ciphertext-only relay, 그리고 음성 친화 Chat UI다.

1.2 문제 정의

기존 원격 Claude Code 사용 방식은 다음 문제가 있다.
	•	로컬/원격 전환 시 사용 흐름이 끊긴다
	•	재구동과 연결 관리가 번거롭다
	•	worktree 중심 작업 관리가 1급 기능이 아니다
	•	모바일/태블릿에서 읽기 쉬운 요약형 UI가 부족하다
	•	relay/server를 신뢰하지 않는 zero-trust 구조가 부족하다

1.3 해결하려는 핵심

Teleprompter는 다음을 제공한다.
	•	원격 Claude Code Session의 안정적인 시작/복구/전환
	•	동일 Session 안에서 Chat UI ↔ Terminal UI 전환
	•	git worktree 중심의 작업 단위 관리 (Daemon이 직접 관리)
	•	서버/relay가 내용을 모르는 E2EE 구조
	•	음성 입력/출력을 통한 모바일 친화적 사용성

⸻

2. 목표와 비목표

2.1 목표
	•	원격 Claude Code Session을 쉽게 시작, 복구, 전환할 수 있다
	•	좌측 Chat / 우측 Terminal 구조의 일관된 UX를 제공한다
	•	git worktree를 1st-class로 통합한다 (Daemon이 직접 관리)
	•	zero-trust E2EE를 제공한다 (libsodium 기반 X25519 + XChaCha20-Poly1305, per-frontend 독립 세션 키)
	•	N:N 연결을 지원한다 — 하나의 앱이 여러 Daemon에, 하나의 Daemon이 여러 앱에 동시 연결 (relay protocol v2, frontendId 기반 멀티플렉싱)
	•	relay 교체 및 다중 relay 사용이 가능하다 (공식 호스팅 + 셀프 호스팅, self-registration)
	•	Expo 기반으로 모바일, 태블릿, 웹을 지원한다
	•	Chat UI에서 음성 입력과 음성 요약 출력을 지원한다 (OpenAI Realtime API)

2.2 비목표
	•	Claude Code 자체 기능 개선
	•	초기 버전의 팀 협업, 공유, 권한 관리
	•	초기 버전의 IDE 플러그인 수준 통합
	•	Chat UI에서 Claude CLI 입력기의 모든 인터랙션을 완전 복제
	•	Claude Code channels 의존 기능

⸻

3. 타겟 사용자
	•	원격 환경에서 Claude Code를 자주 사용하는 개발자
	•	여러 저장소/브랜치/worktree를 병렬 운영하는 사용자
	•	relay/server 운영자도 신뢰하지 않는 보안 모델이 필요한 사용자
	•	모바일/태블릿/웹에서 Claude Code를 다루고 싶은 사용자
	•	음성 기반으로 현재 상태를 파악하고 간단한 상호작용을 하고 싶은 사용자

⸻

4. 핵심 가치 제안
	•	원격 Claude Code를 항상 켜져 있는 도구처럼 사용
	•	worktree 중심 운영
	•	zero-trust E2EE
	•	듀얼 서피스 UX
	•	Terminal: 원본 CLI 경험
	•	Chat: 구조화/요약/음성 친화 경험

⸻

5. Terminology

5.1 컴포넌트
	•	Frontend: Expo(React Native + RN Web) 기반 UI
	•	Daemon: PC side(Windows/macOS/Linux) 상주 에이전트. bun build --compile 단일 바이너리로 배포.
	•	Runner: Claude Code를 실제로 실행하는 Session 단위 실행기. Session당 1개 프로세스.
	•	Relay Server: ciphertext-only 중계 서버. 공식 호스팅 + 셀프 호스팅 지원.
	•	Vault: Daemon이 소유하는 로컬 저장소

5.2 실행 단위
	•	Session: 하나의 Claude Code TTY
	•	SID: Session ID

5.3 데이터 단위
	•	Record.kind = io | event | meta
	•	io: PTY 입출력 스트림 조각
	•	event: 구조화 이벤트
	•	meta: Teleprompter 내부 운영 이벤트
	•	Session Log: io 레코드들의 집합
	•	Session Event: event 레코드들의 집합
	•	Activity: Frontend가 event 중심으로 구성하는 Chat/활동 뷰

5.4 기술 스택

5.4.1 런타임 및 언어
	•	언어: TypeScript 단일 스택 (모든 컴포넌트)
	•	런타임: Bun v1.3.5+ (Runner, Daemon, Relay)
	•	Frontend: Expo (React Native + RN Web)
	•	배포: bun build --compile 으로 단일 바이너리 생성

5.4.2 PTY
	•	macOS/Linux: Bun.spawn({ terminal }) — Bun v1.3.5+ 네이티브 PTY
	•	Windows: `@aspect-build/node-pty` via Node.js subprocess (ConPTY). Node.js 필요. pty-host 자동 설치 (`%LOCALAPPDATA%\teleprompter\pty-host\`)

5.4.3 Frontend 기술
	•	상태 관리: Zustand
	•	UI 스타일: NativeWind (Tailwind for RN)
	•	터미널 렌더링: xterm.js (웹 네이티브, iOS/Android는 WebView 브릿지)

5.4.4 암호화
	•	libsodium (X25519 키 교환 + XChaCha20-Poly1305 대칭 암호화)

5.4.5 모노레포
	•	도구: Turborepo + pnpm
	•	구조:

teleprompter/
├── apps/
│   ├── app/          # @teleprompter/app — Expo (RN + Web)
│   └── cli/          # @teleprompter/cli — 통합 CLI (`tp` 바이너리)
├── packages/
│   ├── daemon/       # @teleprompter/daemon — Bun 장기 실행 서비스
│   ├── runner/       # @teleprompter/runner — Bun PTY 관리
│   ├── relay/        # @teleprompter/relay — Bun WebSocket 중계
│   ├── protocol/     # @teleprompter/protocol — 공유 타입 + framed JSON 프로토콜
│   ├── tsconfig/     # 공유 TS 설정
│   └── eslint-config/
├── turbo.json
├── pnpm-workspace.yaml
└── package.json

5.4.6 플랫폼 우선순위
	•	iOS > Web > Android
	•	iPad/태블릿/데스크톱에서 반응형 레이아웃 지원

⸻

6. UX 원칙

6.1 기본 화면 구조
	•	하나의 Session 화면 안에서 동작
	•	좌측 탭 = Chat(Activity)
	•	우측 탭 = Terminal
	•	동일 Session 문맥을 공유

6.2 Terminal UI 목표
	•	실제 Claude Code CLI와 가능한 한 동일한 경험 제공
	•	PTY raw bytes를 그대로 xterm.js에 전달하여 ANSI escape 시퀀스(색상, 커서, 대체 화면 버퍼 등) 완벽 재현
	•	slash command, /effort, /config, 자동완성, 히스토리, 키 입력 등은 Claude Code 자체 동작을 그대로 따른다
	•	Teleprompter는 원격 PTY 경험을 충실하게 전달하는 데 집중한다

6.3 Chat UI 목표
	•	hooks + PTY 하이브리드로 Session의 구조화된 상태와 스트리밍 메시지를 렌더링
	•	사용자 선택/승인/입력 요구 상황을 카드형 UI로 표시
	•	assistant 최종 응답을 요약형 TTS로 재생 가능
	•	음성 입력 모드에서 OpenAI Realtime API를 활용해 프롬프트를 점진적으로 다듬을 수 있어야 함
	•	Chat 중심으로 동작하되, 필요 시 Terminal 문맥을 참조

6.4 Chat UI 비목표
	•	Claude CLI 입력기의 모든 인터랙션을 완전 복제하지 않음
	•	모든 질문/선택 상황이 hook만으로 구조화된다고 가정하지 않음
	•	구조화가 부족한 상호작용은 Frontend 해석 규칙 또는 Terminal fallback으로 처리

⸻

7. 시스템 아키텍처

7.1 컴포넌트 구조

Runner -> Daemon -> Relay Server -> Frontend

7.2 역할 분해

Frontend
	•	Session 목록/선택
	•	Chat(Activity) 렌더링
	•	Terminal 렌더링 (xterm.js)
	•	QR 페어링
	•	relay 설정/선택 UI
	•	음성 입력 모드 UI (OpenAI Realtime API)
	•	사용자별 API key 입력/관리

Daemon
	•	Session 관리
	•	Vault 저장
	•	E2EE 처리 (libsodium)
	•	relay 연결 및 다중 relay 관리
	•	Frontend sync 요청 처리
	•	git worktree 직접 관리 (add/remove/list)
	•	Frontend의 worktree 생성 요청 수신 → 지정 디렉토리에 worktree 생성 후 Session 시작

Runner
	•	Session당 하나의 Claude Code 프로세스 실행
	•	Bun.spawn({ terminal }) 기반 PTY 생성 및 io 수집
	•	claude --settings <json> 플래그로 hooks 설정을 CLI 인라인 주입 (settings.local.json 수정 불필요)
	•	Claude Code hooks 원본 이벤트 수집 (stdin JSON → event Record)
	•	worktree별 실행 컨텍스트 적용
	•	Daemon과 로컬 IPC 통신 (Unix domain socket)

Relay Server
	•	암호화된 데이터 중계
	•	평문 내용 접근 불가
	•	교체 가능, 다중 사용 가능
	•	공식 호스팅 + 셀프 호스팅 + 동시 다중 사용 지원
	•	source of truth가 아님
	•	세션별 최근 10개 ciphertext frame과 현재 연결 상태만 유지

⸻

8. Transport / IPC / Sync

8.1 전송 구조
	•	Runner -> Daemon: 로컬 IPC
	•	Daemon <-> Relay <-> Frontend: 사용자 단위 multiplexed transport
	•	backlog의 source of truth는 Daemon의 Vault

8.2 Transport 원칙
	•	기본 transport는 WebSocket
	•	WebTransport는 당분간 제외
	•	대상 환경은 최신 브라우저 / RN Web / React Native
	•	범용 하위호환성보다 최신 환경 최적화를 우선하되, WebSocket의 폭넓은 지원성과 구현 단순성을 활용

8.3 Runner ↔ Daemon IPC
	•	cross-platform local socket abstraction 사용
	•	macOS/Linux: Unix domain socket
	•	Windows: Named Pipes (`\\.\pipe\teleprompter-{username}-daemon`)
	•	backpressure 처리 필수: Bun socket.write()가 버퍼 가득 시 0을 반환하며 데이터를 버림 → write queue + drain 기반 flow control 구현

8.4 Relay 상태 모델

Relay는 세션별로 아래를 유지한다.
	•	recent 10 ciphertext frame
	•	online/offline 수준의 연결 상태
	•	last seen 관련 메타
	•	attached 상태 메타

⸻

9. 데이터 모델

9.1 공통 Record 스키마
	•	sid
	•	seq
	•	kind
	•	ts
	•	payload

seq는 Session 내에서 io, event, meta 전체를 통틀어 단일 증가값으로 관리한다.

9.2 저장 원칙
	•	Daemon이 Vault에 append-only 방식으로 저장 (세션 단위 삭제/정리는 가능)
	•	Frontend는 마지막 seq 기준으로 resume
	•	Relay는 source of truth가 아니며 recent 10만 캐시

9.3 Chat UI 구성 원칙
	•	Chat은 event 중심으로 재구성하되, PTY 파싱으로 스트리밍 보강
	•	Terminal은 io 중심으로 재구성
	•	이벤트 정규화는 저장 시점이 아니라 Frontend에서만 수행
	•	hook만으로 충분하지 않은 경우 Terminal fallback 허용

⸻

10. 상위 프로토콜

10.1 형식

length-prefixed framed JSON protocol 사용
	•	u32_be length
	•	utf-8 json payload

이 프로토콜은 WebSocket과 로컬 IPC 모두에서 동일하게 사용한다.

10.2 Envelope 필드
	•	t: frame type
	•	sid: session id
	•	seq: sequence
	•	k: kind (io|event|meta)
	•	ns: namespace
	•	n: name
	•	d: data/payload
	•	c: cursor
	•	ts: timestamp
	•	e: error code
	•	m: message

10.3 최소 frame type
	•	hello
	•	attach
	•	detach
	•	resume
	•	rec
	•	batch
	•	in.chat
	•	in.term
	•	state
	•	ping
	•	pong
	•	err

⸻

11. Claude Code 통합 전략

11.1 하이브리드 Chat 데이터 전략

Chat UI의 데이터 소스는 두 가지를 병행한다.

	•	Primary: Claude Code hooks 기반 구조화 이벤트 → 메시지 카드로 렌더링
	•	Secondary: PTY output 파싱 → ANSI 스트리핑 후 순수 텍스트를 Chat 버블로 렌더링

동작 흐름:
	1.	hooks 이벤트가 도착하면 구조화된 메시지 카드로 즉시 렌더링
	2.	hooks 이벤트 사이 구간에서 PTY output을 ANSI 스트리핑 → 순수 텍스트로 Chat 버블 표시
	3.	hooks Stop 이벤트가 도착하면 해당 응답을 최종 확정 (last_assistant_message 필드 활용)
	4.	구조화가 불충분한 상호작용은 Terminal fallback으로 처리

ANSI 처리 원칙:
	•	Terminal 탭: PTY raw bytes를 xterm.js에 그대로 전달 (ANSI 완벽 재현)
	•	Chat 탭: ANSI escape regex로 제거 후 순수 텍스트만 표시

11.2 Chat 재구성 매핑
	•	UserPromptSubmit → user message
	•	Stop → assistant final message
	•	PreToolUse → tool pending
	•	PostToolUse → tool result
	•	PostToolUseFailure → tool error
	•	StopFailure → assistant error
	•	PermissionRequest, SessionStart, SessionEnd, SubagentStart, SubagentStop, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Notification, Elicitation 등 → Activity row / state badge

11.3 한계와 보완
	•	PTY output 파싱은 Claude Code 출력 포맷에 의존하므로, 버전 변경 시 파싱 규칙 업데이트 필요
	•	hooks + PTY 두 소스 간 타이밍 불일치 시 hooks 이벤트를 신뢰하고 PTY 스트리밍은 보조로 취급
	•	질문형/선택지형 응답은 hook 타입 + 텍스트 휴리스틱으로 카드화
	•	구조화가 부족한 경우 Terminal 탭으로 이관
	•	Claude Code 버전별 hooks API 변경이 있을 경우 버전 기반 분기로 대응

11.4 Hooks 주입 전략
	•	Runner는 claude --settings <json> 플래그로 hooks를 CLI 인라인 주입
	•	--settings는 프로젝트 레벨 hooks를 대체할 수 있으므로, Runner 시작 시 기존 .claude/settings.local.json의 hooks를 읽어 merge한 후 주입
	•	hook 스크립트의 IPC 전송은 Bun 원라이너 또는 컴파일된 Bun 바이너리 사용 (nc/socat 같은 플랫폼 의존 도구 회피)

⸻

12. 이벤트 네임스페이스

12.1 원본 저장 원칙
	•	event.ns = "claude"
	•	event.name = <hook_event_name>
	•	event.data = <hook stdin JSON 원본>

12.2 Teleprompter 내부 이벤트
	•	event.ns = "tp"
	•	event.name는 dot 표기
	•	예: relay.switched, session.reconnected, security.pairing.completed

12.3 진단용 네임스페이스
	•	runner
	•	daemon

기본 UI에는 숨기고, 진단 모드에서 노출

⸻

13. Worktree 통합

13.1 목표

Daemon이 git worktree를 직접 관리한다. 외부 도구에 의존하지 않는다.

13.2 관리 구조
	•	Daemon이 git worktree add / remove / list 를 직접 실행
	•	Frontend가 Daemon에게 특정 디렉토리에 worktree 생성을 요청할 수 있다
	•	Daemon은 worktree 생성 후 해당 디렉토리에서 Session을 시작한다

13.3 Session 관계
	•	N:1 관계: 하나의 worktree에 여러 Session을 바인딩할 수 있다
	•	기본 정책은 worktree당 Session 1개이나, 사용자가 명시적으로 추가 Session 생성 가능

13.4 MVP 범위
	•	worktree 생성 (git worktree add)
	•	worktree 삭제 (git worktree remove)
	•	worktree 목록 조회 (git worktree list)
	•	worktree별 Session 바인딩 및 다중 Session 지원

⸻

14. 보안(E2EE)

14.1 보안 모델
	•	서버/relay 운영자를 신뢰하지 않음
	•	네트워크 중간자도 신뢰하지 않음
	•	내용은 E2EE로 보호

14.2 페어링 프로토콜

QR 기반 E2EE 페어링 흐름은 다음과 같다.

	1.	Daemon이 X25519 키쌍 + 32바이트 랜덤 pairing secret 생성
	2.	QR 코드에 포함되는 정보:
		•	pairing secret (32B)
		•	Daemon public key (32B)
		•	relay endpoint URL
		•	Daemon ID
	3.	Frontend가 QR 스캔 → Daemon pubkey를 offline으로 획득 → 자체 X25519 키쌍 생성
	4.	pairing secret에서 relay token 파생 (BLAKE2b), relay를 경유해 Frontend pubkey를 Daemon에게 전달
	5.	양쪽 ECDH (X25519 `crypto_kx`) → session keys (tx/rx) 유도
	6.	모든 프레임을 XChaCha20-Poly1305로 암호화
	7.	키 로테이션: 각 Session 시작 시 새로운 ephemeral key ratchet 수행 (BLAKE2b 기반)

Note: Daemon pubkey는 QR 코드(offline)로 전달, Frontend pubkey는 relay 경유. Relay는 pairing secret 파생 token으로 세션 라우팅 접근 제어만 수행하며, 암호학적 인증의 주체가 아님.

14.2.1 페어링 정책
	•	새 Daemon 추가 시마다 QR 페어링
	•	새 Frontend 디바이스 추가 시마다 QR 페어링
	•	멀티 디바이스, 멀티 Daemon 지원
	•	기존 신뢰 기기를 모두 잃으면 복구 불가

14.2.2 암호화 라이브러리
	•	libsodium 사용 (X25519 + XChaCha20-Poly1305)
	•	Bun 환경: libsodium-wrappers
	•	Expo 환경: libsodium-wrappers 또는 react-native-libsodium

14.3 저장 정책
	•	기본 저장은 PC side(Vault)에서 수행
	•	Frontend는 이를 resume/sync
	•	relay는 부담 최소화
	•	서버는 암호화된 blob만 취급

⸻

15. 음성 UX

15.1 기본 방향

OpenAI Realtime API(WebSocket 기반)를 사용해 단일 세션에서 STT + TTS + 프롬프트 정제를 처리한다. 별도의 STT/TTS 파이프라인을 조합하지 않는다.

15.2 음성 입력 모드
	•	ChatGPT 앱 스타일의 연속 청취 모드
	•	VAD(Voice Activity Detection) 자동 감지로 발화 시작/종료를 인식
	•	발화 종료 시 자동으로 텍스트 변환 후 전송
	•	TTS 응답 자동 재생
	•	입력창이 확장된 상태에서 동작
	•	Terminal 문맥 참조 토글을 함께 제공 (기본값 OFF)

15.3 프롬프트 생성 수준
	•	기본은 B: 가벼운 정리
	•	사용자의 추가 음성 지시에 따라 C: 적극적 재작성 으로 확장 가능
	•	Realtime API의 모델(GPT-4o)이 프롬프트 정제까지 수행

15.4 컨텍스트 주입
	•	Realtime API의 system prompt에 다음을 주입:
		•	최근 Chat 요약
		•	Terminal 현재 상태
	•	Terminal 참조 범위:
		•	최근 몇 줄
		•	최근 명령 1개와 그 출력
		•	사용자가 선택한 구간

15.5 비용 추정
	•	예상 비용: 하루 100회 상호작용 기준 약 $0.30/월

15.6 API Key 관리
	•	사용자가 자신의 OpenAI API key를 직접 관리
	•	iOS/Android: OS secure storage (Keychain / Keystore)
	•	웹: 별도 암호화 저장 방식 사용
	•	최초 1회 잠금 해제 후 세션 동안 유지

⸻

16. 오프라인 세션 가시성

16.1 기본 원칙

Session이 오프라인이어도 Frontend는 이미 확보한 최근 레코드와 상태 정보를 바탕으로 기본 정보를 계속 표시할 수 있어야 한다.

16.2 최소 표시 정보
	•	online / offline
	•	last seen
	•	last activity time
	•	worktree name
	•	directory path
	•	Claude Code version

시간 표기는 상대시간 + 절대시간 둘 다 제공

16.3 recent 10의 용도

recent 10 frame은:
	•	단순 복기용 메타데이터
	•	실제 UI 일부 복원
둘 다에 사용한다.

16.4 오프라인 복원
	•	Chat 탭에서는 마지막 메시지/이벤트 일부 복원
	•	Terminal 탭에서는 마지막 화면 일부 복원
	•	사용자는 오프라인 상태에서도 탭 전환을 통해 마지막 Chat/Terminal 상태 일부를 확인할 수 있어야 한다

⸻

17. 기능 요구사항

17.1 Session / 연결
	•	Daemon 등록 및 QR 페어링
	•	Session 생성/종료/재연결
	•	다중 relay 설정 및 선택 (공식 호스팅 + 셀프 호스팅)
	•	네트워크 단절 후 Session 복구

17.2 UI / UX
	•	Chat(Activity) 탭
	•	Terminal 탭
	•	Session 목록 및 전환
	•	Chat/Terminal 동일 Session 문맥 공유

17.3 Claude Code 통합
	•	Runner가 Claude Code를 Bun PTY에서 실행
	•	hooks 원본 이벤트 전부 수집
	•	Terminal io stream 수집
	•	hooks + PTY 하이브리드 Chat 재구성

17.4 Worktree
	•	git worktree 생성 (Daemon 직접 관리)
	•	git worktree 삭제
	•	worktree 목록 조회
	•	worktree와 Session 바인딩 (N:1, 다중 Session 허용)
	•	Frontend에서 worktree 생성 요청

17.5 음성 UX
	•	OpenAI Realtime API 기반 음성 입력/출력
	•	연속 청취 모드 + VAD 자동 감지 + 자동 전송
	•	TTS 응답 자동 재생
	•	PermissionRequest, Elicitation, Notification, 질문형 assistant 응답을 카드형 액션 UI로 렌더링
	•	Chat UI에서 처리 불충분한 상호작용은 Terminal 탭으로 자연스럽게 이관
	•	Chat 요약 + Terminal 상태를 Realtime API system prompt로 주입
	•	음성 입력 모드 제공
	•	Terminal 참조 토글 및 문맥 참조 범위 지원
	•	기본 B, 확장 C 프롬프트 생성 지원
	•	사용자별 OpenAI API key 저장/관리 (OS secure storage, 웹 암호화 저장)

17.6 보안 / 운영
	•	E2EE 키 교환 및 회전 (libsodium)
	•	메시지/터미널 스트림 암호화
	•	ciphertext-only relay
	•	상세 진단 모드
	•	버전/호환성 관리

⸻

18. 상세 진단 모드

진단 모드는 상세 수준을 지원해야 하며, 최소한 아래를 보여줄 수 있어야 한다.
	•	relay 연결 상태
	•	daemon 연결 상태
	•	runner 연결 상태
	•	active sessions
	•	attached frontends
	•	session별 recent 10 frame 메타
	•	reconnect history
	•	seq / cursor 상태
	•	frame drop / retry 수
	•	relay RTT
	•	IPC 연결 상태
	•	last error
	•	worktree 상태
	•	directory path
	•	Claude Code version
	•	hook 수집 누락 카운트

진단 정보의 밀도는 RN/RN Web 구분이 아니라 모바일 / 태블릿 / PC 반응형 레이아웃에 따라 조정한다.

⸻

19. 비기능 요구사항
	•	Terminal 스트림 지연이 사용 가능 수준이어야 함
	•	Session 재연결이 신뢰 가능해야 함
	•	Vault 손상 시 최소 복구 전략이 있어야 함
	•	RN Web 포함 환경에서 터미널 렌더링과 입력 품질 확보 (xterm.js)
	•	hooks 스키마 변화에 대한 호환 전략 (Claude Code 버전별 분기)
	•	음성 입출력은 모바일 환경에서도 실용적이어야 함
	•	bun build --compile 바이너리의 크로스 플랫폼 배포 지원

⸻

20. 경쟁/대안
	•	happy: E2E와 원격 사용 가능하나 사용 흐름상 번거로움 존재
	•	원격 터미널/ssh + 로컬 UI: Session/보안/worktree/Chat 재구성 기능 부족
	•	공식 원격 접속류: 오픈소스, relay 교체, worktree 중심 운영, E2EE 측면에서 차별화 필요

⸻

21. MVP 단계 정의

Stage 0: Foundation
	•	모노레포 설정 (Turborepo + pnpm)
	•	packages/protocol: 공유 타입 + framed JSON 프로토콜 정의
	•	Runner: Bun.spawn({ terminal }) 기반 PTY 실행, io/hooks 이벤트 수집
	•	Daemon 기본 구조: Runner IPC 연결, Vault 저장, Session 관리
	•	Runner ↔ Daemon Unix domain socket IPC

Stage 1: Local UI
	•	Expo 프로젝트 초기화 (React Native + RN Web)
	•	Terminal 탭: xterm.js 기반 터미널 렌더링
	•	Chat 탭: hooks 이벤트 기반 메시지 카드 + PTY 파싱 스트리밍 텍스트
	•	Zustand 상태 관리, NativeWind 스타일링
	•	로컬 WebSocket으로 Daemon ↔ Frontend 직접 연결 (relay 미사용)

Stage 2: Relay + E2EE
	•	Relay 서버 구현 (Bun WebSocket, ciphertext-only 중계)
	•	X25519 + XChaCha20-Poly1305 E2EE 구현 (libsodium)
	•	QR 기반 페어링 프로토콜 구현
	•	다중 relay 설정/선택 UI
	•	공식 호스팅 relay + 셀프 호스팅 + 동시 다중 relay 사용

Stage 3: Worktree + Session 관리
	•	Daemon의 git worktree 직접 관리 (add/remove/list)
	•	다중 Session 지원 (worktree당 N개 Session)
	•	Session 목록 UI, Session 전환
	•	Frontend에서 worktree 생성 요청 → Daemon이 생성 후 Session 시작

Stage 4: Voice UX
	•	OpenAI Realtime API 연동 (WebSocket)
	•	연속 청취 모드, VAD 자동 감지, 자동 전송
	•	TTS 응답 자동 재생
	•	컨텍스트 주입 (Chat 요약 + Terminal 상태)
	•	API key 저장/관리 UI

Stage 5: Mobile + Responsive
	•	iOS 빌드 및 배포
	•	iPad/태블릿/데스크톱 반응형 레이아웃
	•	상세 진단 모드 강화
	•	오프라인 상태 복원 강화
	•	네트워크 단절 후 Session 복구 안정화

⸻

22. 성공 지표
	•	Session 재연결 성공률
	•	평균 재연결 시간
	•	사용자 작업당 재구동 체감 빈도 감소
	•	Chat UI 구성 성공률
	•	relay 전환 환경에서의 연결 안정성
	•	음성 입력/요약 기능 사용률
	•	오프라인 세션 복원 성공률

⸻

23. 남은 오픈 질문

검증 완료:
	•	[해결] Bun PTY로 Claude Code 실행 — 정상 동작 확인 (spike)
	•	[해결] terminal.write() 인터랙티브 입력 — 정상 동작 확인 (spike)
	•	[해결] hooks 수집 — --settings 플래그로 인라인 주입 가능 확인 (spike)
	•	[해결] ANSI escape 시퀀스 — xterm.js가 네이티브 처리, Chat은 regex 기반 ANSI strip

추가 해결:
	•	[해결] Bun Unix socket backpressure — QueuedWriter 구현 (packages/protocol/src/queued-writer.ts)
	•	[해결] --settings hooks merge 전략 — settings-builder.ts에서 기존 hooks와 merge 후 주입
	•	[해결] hook 스크립트 IPC 전송 — Bun 원라이너 방식 채택 (capture-hook.ts)
	•	[해결] framed JSON protocol 최종 필드 스펙 — Envelope 타입 확정 (packages/protocol/src/types/envelope.ts)
	•	[해결] key ratchet 프로토콜 — ephemeral per-session, BLAKE2b 기반 (crypto.ts ratchetSessionKeys)
	•	[해결] 자동 업데이트 — `tp upgrade` 명령어 구현

미해결:
	•	Hermes(iOS/Android)에서 libsodium-wrappers WASM 미지원 — react-native-libsodium 대안 검증 필요
	•	웹 환경 API key 암호화 저장의 구체 암호화 방식 (IndexedDB + Web Crypto API 조합 등)
	•	음성 입력 모드에서 토글/옵션의 최종 레이아웃
	•	모바일/태블릿/PC 반응형에서 디버그 패널 정보 밀도 상세 설계
	•	hook 기반 카드 휴리스틱의 실제 규칙 테이블
	•	PTY output 파싱 규칙의 Claude Code 버전별 분기 전략 상세
	•	xterm.js WebView 브릿지의 iOS/Android 성능 최적화 방안
	•	공식 호스팅 relay의 운영 정책 (SLA, 리전, 요금)
