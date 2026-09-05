# ig-comment-bot

인스타그램 게시물에 **키워드 댓글이 달리면 자동으로 DM을 보내고, 그게 얼마나 먹혔는지 보여주는** 웹 서비스.

지인들이 상용 자동 DM 서비스를 쓰면서 말한 불만은 두 가지였다 — **쓰기가 어렵다**, **통계가 어렵다**.
자동 DM 기능 자체는 아무도 문제 삼지 않았다.

> **자동 DM은 만드는 물건이 아니라 데이터를 모으는 장치다. 만드는 물건은 "쉬운 사용"과 "쉬운 분석"이다.**

사용자가 하는 일: 게시글 URL 붙여넣기 + 보낼 DM 쓰기. **끝.**
그 다음 대시보드에서 `댓글 84 → DM 79 → 답장 41 → 양식 38` 을 본다.

수익이 아니라 지인 대상 서비스 + 포트폴리오가 목적이다. → [`why.md`](./why.md)

## 아키텍처

```
                    CloudFront (단일 도메인, HTTPS)
                    ├── /                → S3   (React SPA)
                    ├── /api/*           → Lambda Function URL ┐
                    └── /webhook/:slug   → Lambda Function URL ┘  같은 NestJS 앱
                                                    │
Instagram ──webhook──────────────────────────────────┤
                                                    ├──> SQS ──> Lambda (SQS 어댑터)
                                                    │              ├──> Instagram Graph API
                                                    ▼              ▼
                                            PostgreSQL (Neon) · Prisma
```

React + Vite + TS / NestJS + TS / PostgreSQL + Prisma / AWS Lambda + SQS + CloudFront · **월 ~$1~2**

## 진행 현황

| Phase | 내용 | 상태 | 완료 기준 |
|---|---|---|---|
| 0 | 문서화 + repo 준비 | ✅ 완료 | 이 문서만 보고 Phase 1을 시작할 수 있다 |
| [1](./phase-1-pipeline.md) | 파이프라인 (웹 없음) | ✅ **완료** — 배포·Meta 연결·실계정 E2E 통과. 잔여: 게시물별 문구 검증 | 실제 댓글 → 1차 DM → 답장 → 후속 DM. 중복·셀프·echo 전부 걸러짐 |
| [2](./phase-2-web.md) | 웹 | 🟡 **다음 단계** | **지인 1명이 나 없이 자기 게시글에 자동 DM을 건다** |
| [3](./phase-3-analytics.md) | 성과 분석 ★ | ⬜ 대기 | 지인이 "이 게시글 효과 있었어?"에 대시보드만 보고 답한다 |
| [4](./phase-4-later.md) | 그 다음 | ⬜ 대기 | — |

Phase 1이 미지의 위험(Meta 함정 · Tester 초대 · `subscribed_apps`)이 전부 몰린 구간이라 UI보다 먼저다.
버리는 코드는 없다 — 처음부터 NestJS로 짓고 Phase 2에서 컨트롤러를 얹는다.

> **Phase 1에서 확인된 것 (2026-09-05)**: 앱에 역할이 없는 **제3 계정에서도 자동 DM이 나간다.**
> 라이브 모드 + Standard Access면 일반 사용자에게 동작하므로 [`meta-api.md`](./meta-api.md) §4
> **모델 B의 전제가 성립한다** — Phase 2를 막고 있던 가장 큰 불확실성이 해소됐다.
> 실전 기록은 [`../study/2026-09-04-1.md`](../study/2026-09-04-1.md) · [`-2.md`](../study/2026-09-04-2.md).

## 문서

| 문서 | 내용 | 언제 보나 |
|---|---|---|
| [`why.md`](./why.md) | 배경 · 시장 조사 · **제품 원칙 2개** | 한 번 읽으면 됨. 기능 추가를 고민할 때 다시 |
| [`architecture.md`](./architecture.md) | 스택 결정 근거 · 데이터 모델 · 멱등성 · 코드 구조 · 비용 | 코드 쓸 때 |
| [`meta-api.md`](./meta-api.md) | Meta/Instagram **검증된 제약과 함정 14개** · 연결 절차 · 트러블슈팅 | ★가장 자주. 뭔가 안 되면 여기부터 |
| [`phase-*.md`](./phase-1-pipeline.md) | 단계별 할 일 · 검증 · 진행 기록 | 해당 단계 작업 중 |
| [`archive/`](./archive/) | 원본 설계 (오류 5개 포함, 이력용) | 참조하지 말 것 |
| [`../study/`](../study/) | 회고 (PAAR) — 왜 그렇게 결정했고 무엇이 틀렸는가 | 단계가 끝날 때 작성 |

각 Phase는 **해당 문서 하나만 열어서** 진행하고, 끝나면 `진행 기록`과 위 현황 표를 갱신한다.

## 두 가지 원칙 (기능 추가 판단 기준)

1. **개념을 늘리지 않는다** — 사용자가 배울 개념은 "게시글 하나 = 자동 DM 하나" 하나뿐. 입력 필드 2개.
   화면에 "캠페인/트리거/시퀀스" 같은 말이 나오면 안 된다.
2. **질문에 바로 답하는 화면** — 숫자 나열 대신 사용자가 실제로 묻는 질문에 답한다. 차트보다 표와 문장.

자세히는 [`why.md`](./why.md).

## 알아둘 제약

- **테스트에 두 번째 인스타 계정이 필요하다.** 자기 글에 자기가 댓글 달면 Private Reply가 실패한다
- **앱이 라이브 모드여야 실제 이벤트가 발생한다.** 개발 모드에서는 대시보드의 수동 테스트
  페이로드만 배달된다. 라이브 전환은 App Review와 무관하고 개인정보처리방침 URL만 요구한다
- 연동할 계정과 테스트용 상대 계정 **둘 다 Instagram Tester**여야 한다 (최대 25명).
  토큰 발급 목록에는 테스터 역할이 있는 계정만 뜬다
- Meta App Review는 가지 않는다. 대신 사용자가 **자기 Meta 앱**을 만들어 자격증명을 준다
- 액세스 토큰은 60일마다 만료된다

## 명령어

```bash
pnpm install
pnpm typecheck            # tsc --noEmit
pnpm test                 # node --test
pnpm -F api dev           # 로컬 API (HTTP + 인라인 워커)
pnpm -F web dev           # 로컬 SPA
scripts/deploy.sh         # 빌드 → CFN package/deploy → S3 sync (SAM CLI 불필요)
```

## 보안

- 실제 자격증명은 **Secrets Manager와 DB(AES-256-GCM 암호화)** 에만. repo에는 이름만
- 운영자 전용 파일은 전부 `ops/` 아래 → `.gitignore`에 `/ops/` 한 줄
- `scripts/precommit-check.sh` 가 스테이지에서 토큰·AWS 키 패턴을 찾으면 커밋을 막는다 (`core.hooksPath`로 등록됨)
- **댓글·DM 본문은 저장하지도 로깅하지도 않는다.** username까지만
