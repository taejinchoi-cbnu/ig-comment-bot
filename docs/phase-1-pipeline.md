# Phase 1 — 파이프라인 (웹 없음)

> **상태**: 코드·인프라·`/code-review medium` 반영까지 완료. **다음 세션은 Wave 4(Meta 연결 → 배포 → E2E)부터.**
> |   **선행**: Phase 0 (문서화)
>
> **완료 기준**: 두 번째 인스타 계정으로 실제 댓글을 달면 1차 DM이 오고, 답장하면 후속 DM이 오며,
> 중복·셀프 댓글·echo가 전부 걸러진다. DLQ는 비어 있다.
>
> **다음 세션 시작점**: [§8 코드 리뷰 반영](#8-코드-리뷰-반영-code-review-medium-) 을 먼저 훑고
> [§7 Meta 연결](#7-meta-연결) 3항목부터 진행한다. `pnpm verify`(169건) · `pnpm -F @ig/api test:db`(8건)
> · `pnpm -F @ig/api build:lambda` 스모크 테스트까지 전부 이 세션에서 통과 확인했다.

## 목표

**미지의 위험이 전부 여기 몰려 있다.** Meta webhook 형태, `subscribed_apps` 누락, Instagram Tester 초대,
서명 검증, echo 무한루프 — 이게 다 통과해야 그 위에 UI를 얹는 의미가 있다.

그래서 웹보다 먼저 하고, **UI 없이 SQL로 계정/캠페인을 직접 넣어서** 파이프라인만 검증한다.
버리는 코드는 없다. 처음부터 NestJS로 짓고 Phase 2에서 컨트롤러를 얹는다.

## 준비물

- [x] **두 번째 인스타 계정** — 일반 계정이면 되고 이메일만 있으면 2분. 자기 글에 자기가 댓글 달면 Private Reply가 실패하므로 필수 ([`meta-api.md`](./meta-api.md) #12)
- [x] AWS 배포 전용 IAM 유저 `ig-bot-deployer` (프로파일 `ig-bot`) + 아티팩트 버킷 `ig-comment-bot-artifacts-311912733888-ap-southeast-1` — 완료 2026-08-25
- [x] Neon 프로젝트 (무료 티어) — 완료 2026-08-25

## 할 일

### 1. 프로젝트 뼈대 ✅
- [x] pnpm 워크스페이스 + NestJS 11 + TypeScript **5.9.3** (`@nestjs/cli`가 의존하는 버전. TS 7은 네이티브 재작성판이라 `emitDecoratorMetadata` 경로가 미검증)
- [x] `pnpm verify` = typecheck → test → build
- [x] `GET /health` 부팅 확인
- [x] `packages/shared` 는 **Phase 2로 미룸** — 소비자가 web 하나 더 생겨야 의미가 있고, 지금 만들면 크로스 패키지 TS 해석 설정만 떠안는다

### 2. 데이터

**Prisma 7 기준으로 진행한다.** 6.x 예제를 따라하면 맞지 않는다 —
어댑터 필수, `datasource.url`이 `prisma.config.ts`로 이동, `directUrl` 제거,
`generator output` 필수, `dotenv` 명시적 로드. 자세히는 [`architecture.md`](./architecture.md) §Prisma 7 구성.

- [x] `prisma@7` `@prisma/client@7` `@prisma/adapter-pg` `dotenv` 설치
- [x] `prisma.config.ts` — `datasource.url` 에 **`DATABASE_URL_UNPOOLED`** (마이그레이션은 직결 필요)
- [x] `schema.prisma` — [`architecture.md`](./architecture.md) §데이터 모델 그대로
- [x] 첫 마이그레이션 `20260825010816_init` — 테이블 6 · 인덱스 7 · enum 5 확인 완료
- [x] `prisma/client.ts` — `PrismaPg` 어댑터에 **pooled** `DATABASE_URL` + `env.ts`(cwd 상향 탐색)
- [ ] `crypto/` — AES-256-GCM 암복호화 + Secrets Manager 마스터 키 조회(모듈 스코프 캐시)

> ✅ shadow 데이터베이스는 문제없었다. Neon 기본 역할(`neondb_owner`)에 `CREATE DATABASE` 권한이 있어
> `prisma migrate dev` 가 그대로 돌았다. 별도 `shadowDatabaseUrl` 불필요.

### 3. 수신 경로
- [x] `webhook/signature.ts` — HMAC, **App Secret 2종 시도**, `rawBody()` 로 base64 처리
- [x] `webhook/normalize.ts` — payload → `{ events, skipped }`. 버린 것도 `skipReason` 과 함께 반환한다
- [ ] `webhook/webhook.controller.ts` — `GET`(verify) / `POST`(서명 → normalize → SQS). **항상 200**
- [ ] `slug` → 계정 조회 (경로에서 테넌트 확정 후 서명 검증)

### 4. 처리 경로
- [ ] `instagram/` — Graph API 클라이언트 + retryable 분류
- [ ] `processing/comment.handler.ts` — 캠페인 조회 → 키워드 → `SentReply` 삽입 → Private Reply → 대화 상태 + `lastMediaId`
- [ ] `processing/message.handler.ts` — 조건부 `UPDATE ... RETURNING` → 캠페인 문구 → 발송 → `FORM_SENT`
- [ ] `processing/processor.service.ts` — 레지스트리
- [ ] **모든 분기에서 `Event` 기록** (`COMMENT_SKIPPED` + `skipReason` 포함) ← Phase 3의 원천이라 지금 빠뜨리면 안 된다
- [ ] `lambda/http.ts`, `lambda/sqs.ts` 어댑터

### 5. 테스트 (`node --test`)
- [x] `normalize` 17건 — 셀프 댓글 · is_echo/is_self · sender 동일성 · NO_TEXT · verb=remove · 다중 entry · 쓰레기 입력
- [x] `signature` 13건 — 2종 각각 통과 · 위조 · base64 · 길이 불일치 예외 없음 · 재직렬화 회귀
- [ ] 문구 3단 폴백 — 캠페인 > 계정 > 기본, 필드 단위 병합
- [ ] 멱등성 — 중복 댓글 1회만 발송, retryable 실패 시 마커 삭제 후 throw, 상태 안 맞으면 미발송

### 6. 인프라 ✅
- [x] `infra/template.yaml` — Lambda×2 · SQS + DLQ(`maxReceiveCount: 5`, visibility 180s) · Function URL · **LogGroup retention 7일**
- [x] `scripts/deploy.sh` 가 `pnpm -F @ig/api build:lambda`(esbuild 번들, [`architecture.md`](./architecture.md) §배포) 를 호출하도록 연결.
  `nest build` 산출물은 `node_modules` 를 안 담아 그대로 배포하면 콜드스타트에서 죽는다는 걸
  실제 Function URL 이벤트로 부팅해서 확인 후 고쳤다.
- [ ] 배포 후 Function URL 확보

### 7. Meta 연결 ← **다음 세션 여기부터**
- [ ] [`meta-api.md`](./meta-api.md) §4 절차 1~6 수행 (권한에 `instagram_business_manage_insights` 포함 — Phase 3에서 필요) (**6번 `subscribed_apps` 빠뜨리지 말 것**)
- [ ] 두 번째 계정을 **Instagram Tester로 초대 → 수락**
- [ ] 계정 1개 + 캠페인 2개(문구가 서로 다르게)를 SQL로 직접 삽입.
  `IgAccount.parentAppSecretEnc` 는 보통 비워둔다(§8의 #5) — 403이 계속될 때만 채운다.

### 8. 코드 리뷰 반영 (`/code-review medium`) ✅

Wave 3 직후 돌린 리뷰에서 나온 8건을 전부 확인·반영했다. **1번이 제일 심각했다** —
그대로 배포했으면 Lambda가 콜드스타트에서 바로 죽었을 것이다.

| # | 문제 | 조치 |
|---|---|---|
| 1 ★ | `nest build` 산출물엔 `node_modules` 가 없는데 `CodeUri` 가 그걸 통째로 zip 함 → 배포하면 `Cannot find module 'reflect-metadata'` | esbuild로 완전 번들링(`build:lambda`). Prisma 7 driver adapter라 네이티브 바이너리가 없어 번들 가능했다. NestJS가 선택적으로 `require()`하는 microservices/websockets/validator는 `--external`로 넘긴다(Nest 자체가 try/catch로 감싸둠). **실제 Function URL 이벤트로 부팅해서 `/health` 200 확인 완료** |
| 2 | SQS 워커가 모르는 계정의 이벤트를 로그만 남기고 버림 — `Event` 도 못 남김 | `igAccountId` 가 필수 FK라 애초에 못 씀(계정이 없으니 참조할 행이 없다). 상관관계 잡을 값을 전부 실어 `console.error` 로 격상, 이유를 주석으로 명시 |
| 3 | SQS enqueue 부분 실패 시 `Event` 기록 없음, `enqueued` 카운트가 시도 수를 돌려줌 | `FAILED` 이벤트로 기록, `enqueued` 를 실제 성공 수(`outcome.successful`)로 수정. 테스트 2건 추가 |
| 4 ★ | `message.handler.ts` 가 캠페인을 `id` 만으로 조회 — 테넌트 필터 없음 (comment.handler는 있음) | `findFirst({ id, igAccountId })` 로 방어선 추가. **필터를 빼면 실제로 남의 캠페인 문구가 새는 것**을 별도 재현 테스트로 확인 후 고쳤고, 커밋된 테스트는 고친 코드가 막아내는지 검증한다 |
| 5 | `META_APP_SECRET` 전역 환경변수를 참조하지만 `template.yaml` 어디에도 정의 안 됨 — 항상 `undefined` |애초에 전역 변수가 아키텍처와 안 맞았다(테넌트마다 다른 Meta 앱). `IgAccount.parentAppSecretEnc`(nullable) 로 계정별 필드화. 마이그레이션 `20260825114031_add_parent_app_secret` |
| 6 | webhook 경로가 쓰지도 않는 `accessToken` 을 매번 복호화 — 실패하면 정상 서명도 404 | `account.service.ts` 에서 제거. 워커(`sqs.ts`)는 원래 따로 복호화해서 발송에 쓰므로 영향 없음 |
| 7 | `deploy.sh` 가 `STACK_NAME` 과 무관하게 항상 `Environment=dev` | `ops/deploy.env` 의 `ENVIRONMENT` 를 따르도록(기본 dev, `dev\|prod` 검증) |
| 8 | "실패는 캐시 안 하는 모듈 스코프 비동기 메모이즈" 패턴이 4곳에 손카피 | `src/lib/memoize-async.ts` 로 통합, 4곳 리팩터 + 자체 테스트 5건 |

★ 표시 2건은 배포/실사용에서 실제로 터졌을 문제라 특히 중요했다.
자세한 판단 근거는 커밋 메시지(`git log --oneline` 최상단 근처)에 있다.

## 검증

```bash
aws logs tail /aws/lambda/ig-comment-bot-dev-Api    --follow &
aws logs tail /aws/lambda/ig-comment-bot-dev-Worker --follow &
```

| # | 동작 | 기대 |
|---|---|---|
| 1 | 두 번째 계정으로 게시물 A에 댓글 | webhook 200 → SQS → 워커 → **1차 DM 도착** |
| 2 | 내 계정으로 같은 글에 댓글 | 아무 일 없음. `Event(COMMENT_SKIPPED, SELF_COMMENT)` |
| 3 | 두 번째 계정에서 DM 답장 | **A의 캠페인 문구** 도착 |
| 4 | 봇이 보낸 DM의 echo webhook | skip. **무한루프 없음** |
| 5 | 게시물 B(다른 문구)로 1~3 반복 | **B의 문구** 도착 (A와 다름) |
| 6 | 캠페인 없는 게시물 C | 계정 기본 문구로 폴백 |
| 7 | 같은 댓글 payload 재전송(올바른 서명) | 재발송 없음. `skipReason=DUPLICATE` |
| 8 | 위조 서명 / 없는 slug | 403 / 404 |
| 9 | DB | `conversations.state = FORM_SENT`, `events` 행 누적 |
| 10 | DLQ | `ApproximateNumberOfMessages = 0` |

막히면 [`meta-api.md`](./meta-api.md) §6 트러블슈팅 결정 트리부터.

## 참고

[`meta-api.md`](./meta-api.md) (전부) · [`architecture.md`](./architecture.md) (데이터 모델 · 멱등성 · 코드 구조)

## 진행 기록

<!-- 작업하며 채운다. 막힌 지점 · 바꾼 결정 · 예상과 달랐던 것 -->
