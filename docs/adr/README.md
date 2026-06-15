# Architecture Decision Records (ADR)

큰 방향/아키텍처 결정을 박제하는 곳. "왜 이렇게 정했나" 를 나중에 회고할 수 있게 하기 위함이다.

## 무엇을 ADR 로 남기나

- 되돌리기 어렵거나 코드베이스 전반에 영향을 주는 결정
- 여러 대안을 비교해 하나를 고른 결정 (기각된 대안과 이유 포함)
- 외부 의존성/런타임/언어/transport 선택

일상적 구현 결정은 ADR 이 아니라 코드 + 커밋 메시지로 충분하다.

## 규칙

- 파일명: `NNNN-kebab-title.md` (4자리 순번)
- 상태: `Proposed` → `Accepted` → (필요 시) `Superseded by NNNN` / `Deprecated`
- 결정이 바뀌면 기존 ADR 을 지우지 말고 `Superseded` 로 표시 + 후속 ADR 추가 (히스토리 보존)
- 코드가 ADR 과 어긋나면 코드가 진실 — 결정이 실제로 바뀐 것이면 후속 ADR 로 반영

## 인덱스

| # | 제목 | 상태 |
|---|---|---|
| [0001](./0001-full-native-rewrite-swift-rust.md) | 전면 네이티브 재작성 (Swift 앱 + Rust 코어) | Accepted (2026-06-15) · 플랫폼 범위 Superseded by 0002 |
| [0002](./0002-multiplatform-apple-expansion.md) | Apple 멀티플랫폼 확장 (iOS/iPadOS/macOS/visionOS 완전 + watchOS 제한) | Accepted (2026-06-15) |
