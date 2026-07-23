---
paths:
  - ".claude/workflows/**"
  - ".claude/wf/**"
---

# Workflow Authoring Discipline

멀티 에이전트 워크플로우(`Workflow` 도구)를 작성할 때의 규율. **핵심 한 줄: agent
에게 건네는 BRIEF/CONTEXT 안에 *미검증 과거 서술*을 ground truth 로 박지 말 것.**
규율을 글로만 두면 또 어긴다 — 그래서 가드가 구조에 내장된 재사용 템플릿
`.claude/workflows/fact-grounded-fix.js` 을 기본값으로 쓴다.

## 왜 이 규율이 있나 (wf_0f537a63 사후분석)

libsodium-Hermes rejection 을 풀던 워크플로우가 **틀린 결론(올바른 fix 를 기각)**
을 냈다. 원인은 agent 가 아니라 **BRIEF 설계 결함**이었다:

1. **stale commit body 를 HEAD 로 오인** — 작성자가 fix 머지 *이전* commit
   (`91b50b5`) 의 body 에 적힌 "이미 on-device 에서 두 번 실패함" 서술을, 그게
   *현재* HEAD 인 줄 알고 BRIEF 의 `WHAT WE ALREADY DISPROVED` 에 사실로 박았다.
2. **재검증을 명시적으로 금지** — 같은 BRIEF 가 `"do not re-derive"`,
   `"do NOT propose these; they are dead"` 로 agent 가 그 주장을 실파일로
   확인하는 걸 막았다. 오류를 잡을 유일한 행위를 차단한 것.

agent 는 독이 든 BRIEF 를 충실히 따랐을 뿐이다. 이후 on-device A/B 테스트가
기각된 후보(tracker 재등록)가 **실제로는 정답**임을 입증했다.

## 규칙

1. **HEAD 워킹트리 실파일만 ground truth.** commit/PR body, CHANGELOG,
   "이전 세션이 그랬다"식 서술은 전부 hearsay. agent 가 인용하면 반드시 실파일
   file:line 으로 재확인하게 시킬 것.
2. **과거 결론을 axiom 으로 주입 금지.** "이미 시도했고 실패함" / "이미 머지된
   정답임" 같은 inherited claim 은 BRIEF 에 *사실*이 아니라 *재검증 대상(claim)*
   으로 넣는다. `fact-grounded-fix.js` 의 `args.inheritedClaims` 가 정확히 이 용도 —
   Reverify phase 가 HEAD 로 confirmed/contradicted/stale/unverifiable 판정 후에만
   다운스트림이 사실로 취급한다.
3. **"재유도 금지" 류 레버를 BRIEF 에 절대 넣지 말 것.** (`do not re-derive`,
   `these are dead, do not propose`, `do not re-check` …) 재유도가 곧 일이다.
4. **adversarial verify 는 기본값 REFUTED**, 그리고 **commit body 인용 금지 —
   file:line 만**. 불확실하면 reject.
5. **KEEP-AS-IS 도 정당한 결론.** 뭔가 하려고 억지 변경을 만들지 말 것.
6. **모든 `agent()` 호출에 `model:` 명시.** 생략하면 부모(보통 Opus)를 상속해
   단순 grep 도 Opus 로 돈다 — CLAUDE.md "Subagent Dispatch" 와 동일 정책.
   haiku = 탐색/grep/짧은 요약, sonnet = 코드 작업/리뷰/검증, opus = 어려운
   설계·추론만. 예: `fact-grounded-fix.js` 는 reverify/verify 가 sonnet,
   enumerate/synthesize 가 opus.

## 기본 도구: `fact-grounded-fix` 템플릿

코드 fix/답을 "검증된 사실 위에서" 찾는 워크플로우는 새로 BRIEF 를 쓰지 말고
이 템플릿을 호출한다 (가드가 구조에 박혀 있어 위 1–5 를 자동 강제):

```js
Workflow({
  scriptPath: "<repo>/.claude/workflows/fact-grounded-fix.js",
  args: {
    repo: "<abs repo path>",
    question: "the precise fix/answer being sought",   // REQUIRED
    targetFiles: ["src/foo.ts:120"],                   // 변경이 떨어질 곳
    establishedFacts: ["…(cite file)"],                // CLAIM 으로 취급됨
    inheritedClaims: ["X 는 '이미 실패했다더라' (재검증, 가정 금지)"],
    constraints: ["web 에서 no-op 유지", …],
    onDeviceSignals: ["WebAssembly.RuntimeError", …],  // 0 으로 유지돼야 할 신호
  },
})
```

> `Workflow({name})` 로 saved workflow 를 이름 호출하는 건 이 환경에서 매핑이
> 공식 확인되지 않았다. **`scriptPath` 로 직접 부르는 경로가 항상 동작**하므로
> 그걸 쓴다. 새 fix-탐색 워크플로우가 이 템플릿으로 안 풀리는 구조(예: 대규모
> 마이그레이션, 순수 탐색)면 직접 작성하되 위 1–5 를 BRIEF 에 반영할 것.
