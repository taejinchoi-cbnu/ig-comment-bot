# Phase 1 — 파이프라인 (웹 없음)

> **상태**: 대기   |   **선행**: Phase 0 (문서화)
>
> **완료 기준**: 두 번째 인스타 계정으로 실제 댓글을 달면 1차 DM이 오고, 답장하면 후속 DM이 오며,
> 중복·셀프 댓글·echo가 전부 걸러진다. DLQ는 비어 있다.

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
- [ ] `webhook/signature.ts` — HMAC, **App Secret 2종 시도**, `isBase64Encoded` 처리
- [ ] `webhook/normalize.ts` — payload → `BotEvent[]`. **순수 함수로 유지** (테스트 핵심)
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
- [ ] `normalize` — 정상 댓글 / **셀프 댓글** / **is_echo** / 텍스트 없는 메시지 / 다중 entry·changes
- [ ] `signature` — App Secret 2종 각각 통과, 위조 실패, base64 body
- [ ] 문구 3단 폴백 — 캠페인 > 계정 > 기본, 필드 단위 병합
- [ ] 멱등성 — 중복 댓글 1회만 발송, retryable 실패 시 마커 삭제 후 throw, 상태 안 맞으면 미발송

### 6. 인프라
- [ ] `infra/template.yaml` — Lambda×2 · SQS + DLQ(`maxReceiveCount: 5`, visibility 180s) · Function URL · **LogGroup retention 7일**
- [ ] 배포 후 Function URL 확보

### 7. Meta 연결
- [ ] [`meta-api.md`](./meta-api.md) §4 절차 1~6 수행 (권한에 `instagram_business_manage_insights` 포함 — Phase 3에서 필요) (**6번 `subscribed_apps` 빠뜨리지 말 것**)
- [ ] 두 번째 계정을 **Instagram Tester로 초대 → 수락**
- [ ] 계정 1개 + 캠페인 2개(문구가 서로 다르게)를 SQL로 직접 삽입

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
