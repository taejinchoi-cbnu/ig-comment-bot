# Phase 1 — 파이프라인 (웹 없음)

> **상태**: ✅ **완료 기준 충족.** 배포·Meta 연결·실계정 E2E 전부 통과.
> 앱에 역할이 없는 **제3 계정에서도 동작 확인** → [`meta-api.md`](./meta-api.md) §4 모델 B 성립.
> |   **선행**: Phase 0 (문서화)
>
> **완료 기준**: 두 번째 인스타 계정으로 실제 댓글을 달면 1차 DM이 오고, 답장하면 후속 DM이 오며,
> 중복·셀프 댓글·echo가 전부 걸러진다. DLQ는 비어 있다. → **전부 확인됨**
>
> **다음 세션 시작점**: [§7-3 캠페인](#7-3-캠페인-2개-sql) — 게시물별 문구(검증 #5)만 남았다.
> 그 뒤 [Phase 2](./phase-2-web.md). 미해결 항목은 [§남은 것](#남은-것) 참고.
>
> 실전 기록: [`study/2026-09-04-1.md`](../study/2026-09-04-1.md) (배포·연결) ·
> [`study/2026-09-04-2.md`](../study/2026-09-04-2.md) (실사용이 깬 설계 가정)

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
- [x] `crypto/` — AES-256-GCM 암복호화 + Secrets Manager 마스터 키 조회(모듈 스코프 캐시)

> ✅ shadow 데이터베이스는 문제없었다. Neon 기본 역할(`neondb_owner`)에 `CREATE DATABASE` 권한이 있어
> `prisma migrate dev` 가 그대로 돌았다. 별도 `shadowDatabaseUrl` 불필요.

### 3. 수신 경로
- [x] `webhook/signature.ts` — HMAC, **App Secret 2종 시도**, `rawBody()` 로 base64 처리
- [x] `webhook/normalize.ts` — payload → `{ events, skipped }`. 버린 것도 `skipReason` 과 함께 반환한다
- [x] `webhook/webhook.controller.ts` — `GET`(verify) / `POST`(서명 → normalize → SQS). **항상 200**
- [x] `slug` → 계정 조회 (경로에서 테넌트 확정 후 서명 검증)

### 4. 처리 경로
- [x] `instagram/` — Graph API 클라이언트 + retryable 분류
- [x] `processing/comment.handler.ts` — 캠페인 조회 → 키워드 → `SentReply` 삽입 → Private Reply → 대화 상태 + `lastMediaId`
- [x] `processing/message.handler.ts` — 조건부 `UPDATE ... RETURNING` → 캠페인 문구 → 발송 → `FORM_SENT`
- [x] `processing/processor.service.ts` — 레지스트리
- [x] **모든 분기에서 `Event` 기록** (`COMMENT_SKIPPED` + `skipReason` 포함) ← Phase 3의 원천이라 지금 빠뜨리면 안 된다
- [x] `lambda/http.ts`, `lambda/sqs.ts` 어댑터

### 5. 테스트 (`node --test`)
- [x] `normalize` 17건 — 셀프 댓글 · is_echo/is_self · sender 동일성 · NO_TEXT · verb=remove · 다중 entry · 쓰레기 입력
- [x] `signature` 13건 — 2종 각각 통과 · 위조 · base64 · 길이 불일치 예외 없음 · 재직렬화 회귀
- [x] 문구 3단 폴백 — 캠페인 > 계정 > 기본, 필드 단위 병합
- [x] 멱등성 — 중복 댓글 1회만 발송, retryable 실패 시 마커 삭제 후 throw, 상태 안 맞으면 미발송

### 6. 인프라 ✅
- [x] `infra/template.yaml` — Lambda×2 · SQS + DLQ(`maxReceiveCount: 5`, visibility 180s) · Function URL · **LogGroup retention 7일**
- [x] `scripts/deploy.sh` 가 `pnpm -F @ig/api build:lambda`(esbuild 번들, [`architecture.md`](./architecture.md) §배포) 를 호출하도록 연결.
  `nest build` 산출물은 `node_modules` 를 안 담아 그대로 배포하면 콜드스타트에서 죽는다는 걸
  실제 Function URL 이벤트로 부팅해서 확인 후 고쳤다.
- [x] 배포 후 Function URL 확보 → §7-1

### 7. 배포 · Meta 연결 ← **다음 세션 여기부터**

> **원래 계획을 하나 고쳤다.** "계정을 SQL로 직접 삽입"은 불가능하다 —
> `accessTokenEnc` / `appSecretEnc` 는 AES-256-GCM 암호문이라 SQL로 만들 수 없다.
> 그래서 `scripts/connect-account.ts` 가 생겼다. **캠페인은 암호화 필드가 없으므로 SQL 그대로 간다.**

**7-1. 배포**
```bash
pnpm verify                 # typecheck → test → build
scripts/create-secret.sh    # ops/deploy.env → Secrets Manager (MASTER_KEY 32바이트·pooled URL 검증)
scripts/deploy.sh           # → Outputs 의 ApiFunctionUrl 확보
```
- [x] Secrets Manager `ig-comment-bot/dev/app` 생성
- [x] 스택 배포 + Function URL 확보

> `MASTER_KEY` 는 `ops/deploy.env`(스크립트가 암호화할 때)와 Secrets Manager(Lambda가 복호화할 때)
> 사이에서 바이트 단위로 같아야 한다. `create-secret.sh` 가 한 파일에서 둘 다 파생시키므로
> 불일치라는 버그 종류 자체가 없다.

**7-2. Meta 앱 → 계정 등록**
- [x] [`meta-api.md`](./meta-api.md) §4 1~3단계 + **[§4.1 대시보드 화면 위치](./meta-api.md#41-대시보드-어디를-누르는가)**
  로 토큰(60일)·Instagram app secret 확보. 권한에 `instagram_business_manage_insights` 포함(Phase 3)
- [x] `ops.example/accounts/example.json` → `ops/accounts/<slug>.json` 으로 복사해 채우기
- [x] `pnpm connect-account ops/accounts/<slug>.json`
  → 토큰 검증(`getMe`) · **`subscribed_apps` 호출(§4 6단계)** · 암호화 저장 · verify token 발급까지 한 번에.
  `igUserId` 는 손으로 찾지 않는다 — `getMe()` 가 돌려준다
- [x] 출력된 Callback URL / Verify Token 을 Meta Webhooks 에 입력 → *Verify and Save* → `comments`, `messages` 구독
- [x] 두 번째 계정을 **Instagram Tester로 초대 → 수락** (Stage B 에 필요)
- [x] **연동할 본인 계정도 Instagram 테스터여야 한다** — 토큰 발급 목록에 테스터만 뜬다
- [x] **앱을 라이브 모드로 전환** ← 실제 관문. 개발 모드에서는 수동 테스트 페이로드만 배달되고
  실제 이벤트가 발생하지 않는다. 라이브 전환은 App Review 와 무관하다 (Standard Access 유지)
- [x] 라이브 전환 요건인 **개인정보처리방침 URL** — `apps/api/src/legal.controller.ts` 의 `/privacy`

`parentAppSecret` 은 보통 `null` 로 둔다(§8의 #5) — 서명이 계속 403일 때만 채운다.

**7-3. 캠페인 2개 (SQL)**

게시물 목록은 새 코드 없이 (토큰이 히스토리에 남지 않게 명령 치환을 쓴다):
```bash
curl -s -H "Authorization: Bearer $(jq -r .accessToken ops/accounts/<slug>.json)" \
  'https://graph.instagram.com/v25.0/me/media?fields=id,permalink,caption,media_type&limit=50' | jq
```
- [ ] 게시물 A·B 로 캠페인 2행 INSERT. **`followUpText` 를 서로 다르게** — 검증 #5가 이걸로 판별된다
- [ ] 게시물 C 는 일부러 캠페인을 만들지 않는다 (검증 #6 폴백)

> permalink shortcode 매칭([`meta-api.md`](./meta-api.md) §5)은 **Phase 2로 미룬다.** 지금은 목록에서
> 눈으로 고르면 되고, URL 붙여넣기 UI가 생길 때 `instagram/client.ts` 에 `listMedia()` 로 승격시킨다.

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
AWS="aws --profile ig-bot --region ap-southeast-1"
$AWS logs tail /aws/lambda/ig-comment-bot-dev-Api    --follow &
$AWS logs tail /aws/lambda/ig-comment-bot-dev-Worker --follow &
```

**두 단계로 나눈다.** 두 번째 계정과 Tester 초대 없이도 파이프라인의 절반 —
그것도 **미지의 위험이 몰려 있는 절반** — 이 검증되기 때문이다. 셀프 댓글은
`normalize.ts` 가 버리지만 그 전까지의 Function URL → HMAC → slug → normalize →
`Event` 기록이 전부 돌고 `COMMENT_SKIPPED` 행이 남는다.

### Stage A — 계정 하나로 지금 (배포 직후)

| # | 동작 | 기대 | 결과 |
|---|---|---|---|
| A1 | Meta Webhooks *Verify and Save* | 200 + challenge 반향 | ✅ |
| A2 | 없는 slug 로 `GET /webhook/nope` | 404 | ✅ |
| A3 | 위조 서명으로 `POST /webhook/<slug>` | 403 | ✅ 헤더 없음·짧은 서명 포함, 예외 없이 |
| A4 | **내 계정으로 내 글에 댓글** | `Event(COMMENT_SKIPPED, SELF_COMMENT)` 행 | ✅ |

A4 가 통과하면 **`subscribed_apps` 성공 + 서명 검증 성공**이 동시에 증명된다 —
[`meta-api.md`](./meta-api.md) §6 결정 트리의 1·2순위 의심 항목이 둘 다 걷힌다.

### Stage B — 두 번째 계정 + Instagram Tester 수락 후

발송 경로는 여기서만 검증된다. 셀프 댓글로는 불가능하다: normalize 가 버리고,
버리지 않더라도 Private Reply 가 자기 자신에게 DM 하는 셈이라 400 이며
(§1-12), Standard Access 에서는 상대 계정이 앱 role 을 가져야 발송된다 (§1-11).
두 번째 계정은 이메일만 있으면 2분, Tester 초대는 App Roles → 초대 → 해당 계정에서 수락.

| # | 동작 | 기대 | 결과 |
|---|---|---|---|
| 1 | 두 번째 계정으로 게시물 A에 댓글 | webhook 200 → SQS → 워커 → **1차 DM 도착** | ✅ 4500ms |
| 3 | 두 번째 계정에서 DM 답장 | 후속 문구 도착 | ✅ 1201ms, `FORM_SENT` |
| 4 | 봇이 보낸 DM의 echo webhook | skip. **무한루프 없음** | ✅ Event 기록도 안 함 |
| 5 | 게시물 B(다른 문구)로 1~3 반복 | **B의 문구** 도착 (A와 다름) | ⬜ **캠페인이 없어 미검증** |
| 6 | 캠페인 없는 게시물 | 폴백 문구 | ✅ 3단 폴백의 마지막 단(시스템 기본)까지 |
| 7 | 같은 사람이 같은 글에 댓글 또 | 재발송 없음. `skipReason=DUPLICATE` | ✅ |
| 9 | DB | `conversations.state = FORM_SENT`, `events` 행 누적 | ✅ |
| 10 | DLQ | `ApproximateNumberOfMessages = 0` | ✅ |
| **11** | **앱에 역할이 없는 제3 계정으로 댓글** | 동작해야 모델 B 성립 | ✅ **성립** |
| **12** | 팔로워로 확인된 사람이 새 게시물에 댓글 | 확인 단계 건너뛰고 양식 바로 | ✅ 30초 → **1초** |

> **#5 만 남았다.** 나머지는 실계정에서 전부 통과했다. 게시물별 문구는 캠페인 2개를
> 넣어야 판별되므로 §7-3 이 남은 이유이기도 하다.

막히면 [`meta-api.md`](./meta-api.md) §6 트러블슈팅 결정 트리부터.

## 남은 것

Phase 1 완료 기준은 충족했다. 아래는 **Phase 2 착수를 막지는 않는** 잔여 항목이다.

| 항목 | 언제 해야 하나 |
|---|---|
| **캠페인 2개 → 게시물별 문구 검증(#5)** | 지금. §7-3. 캠페인은 암호화 필드가 없어 SQL 로 넣으면 된다 |
| 비대칭 TTL 실사용 검증 | 언팔 → 댓글 → 1시간 내 재팔로우 → 새 게시물 댓글 |
| 게이트 재발송 루프 (`ConversationState.GATE_SENT`) | **팔로워 게이트를 켜기 전에.** 지금은 기본 꺼짐이라 무해하다 |
| 게이트의 `COMMENT_SKIPPED`+`mediaId` 이중 집계 | Phase 3 퍼널 만들기 전에 |
| `USER_REPLIED` 없는 `FOLLOW_UP_SENT` (빠른 경로) | 위와 같이. 답장→양식 전환율이 100% 를 넘는다 |
| 대댓글이 만드는 `SELF_COMMENT` Event 노이즈 | Phase 3 전에. `ECHO`·`ACCOUNT_MISMATCH` 와 같은 판단이 필요하다 |

> `ACCOUNT_MISMATCH` 는 **해결됐다.** 정체는 같은 Meta 앱의 Instagram 테스터로 등록된
> 다른 계정 앞으로 발사된 웹훅이었고([`meta-api.md`](./meta-api.md) §1-4.1),
> `ECHO` 와 같이 Event 기록에서 제외했다. 로그는 남긴다.

## 참고

[`meta-api.md`](./meta-api.md) (전부) · [`architecture.md`](./architecture.md) (데이터 모델 · 멱등성 · 코드 구조)

## 진행 기록

<!-- 작업하며 채운다. 막힌 지점 · 바꾼 결정 · 예상과 달랐던 것 -->

### 2026-09-04 — 팔로워 캐시 + 게이트(옵션)

같은 사람이 다음 게시글에 댓글을 달 때마다 "팔로워인지 확인할게요" 가 또 나갔다.
우리가 기억을 못 한다는 뜻이지 사용자 문제가 아니다.

**KV 저장소를 새로 두자는 제안이었는데 두지 않았다.** `Conversation` 이 이미
`@@unique([igAccountId, igsid])` 라 사람당 한 행이고, 그 행이 곧 key-value 다.
컬럼 두 개(`isFollower`, `followerCheckedAt`)로 값과 만료 시점이 다 들어가고
TTL 은 만료 배치가 아니라 읽는 시점의 비교 한 줄이다. 저장할 데이터가 계정당 수백 행인데
Redis/DynamoDB 는 인프라·비용·장애 지점만 늘린다.

`is_user_follow_business` 를 **그때까지 아무 데서도 조회하지 않고 있었다** — Phase 3 항목이
문서에만 있었다. 답장 시점에 찍는 코드를 넣으면서 Phase 3 의 그 항목도 같이 닫혔고,
`Event.isFollower` 박제도 함께 동작한다.

**팔로워 게이트는 옵션으로 넣되 기본은 껐다.** `nonFollowerText` 가 null 이면 아무도
막지 않는다. 켜는 순간 사용자가 "게이트" 라는 개념을 배워야 하고(원칙 1), 무엇보다
**잘못 막는 비용이 비대칭**이다 — 게이트가 없으면 비팔로워가 양식을 받을 뿐이지만
잘못 막으면 진짜 고객을 놓친다. 팔로워 여부를 모를 때(`null`)도 막지 않는다.
근거는 [`why.md`](./why.md) §팔로워 관련 제품 결정에 적었다.

막힌 대화는 `FORM_SENT` 가 아니라 `WAITING_USER_MESSAGE` 로 되돌린다 — 팔로우한 뒤
다시 답장하면 그때 양식을 받는다. 굳히면 팔로우해도 영영 못 받는다.

**댓글 좋아요는 API 에 없다.** 댓글에 가능한 쓰기는 대댓글·숨기기·삭제 셋뿐이다
(공식 문서 확인). 하트를 누르는 엔드포인트는 존재하지 않는다.

테스트 183 → **212건**.

### 2026-09-03 — 모델 B 성립 확인 + 중복 키 교정 + 공개 대댓글

**앱에 아무 역할이 없는 제3 계정에서도 정상 동작했다.** 라이브 모드 + Standard Access 면
테스터가 아닌 일반 사용자의 댓글에도 자동 DM 이 나간다 — **[`meta-api.md`](./meta-api.md)
§4 모델 B 의 전제("각 앱이 자기 계정만 다루므로 Standard Access 로 충분")가 성립한다.**
Phase 2 를 막고 있던 가장 큰 불확실성이 해소됐다. §1-11 의 경고는 *App Review 없이 Advanced
Access 를 쓰려는 경우*에 대한 것이지 이 구조에는 걸리지 않는다.

**DM 은 "요청(Requests)" 탭으로 간다.** §6 결정 트리 마지막 줄에 적혀 있던 항목인데
실제로 걸렸다 — 발송은 성공했는데 안 왔다고 판단할 뻔했다.

#### 중복 방지 키를 (계정, 사람, 게시물) 로 교정

**실사용에서 원래 키가 틀렸다는 게 드러났다.** `commentId` 로 잡으면 같은 사람이 같은 글에
댓글을 또 달 때마다 새 ID 라 DM 이 다시 나간다. Meta 의 "댓글당 1회" 제한(§1-9)은 새 댓글을
새로 허용하므로 막아주지 않는다. 근거와 대안 비교는
[`architecture.md`](./architecture.md) §멱등성에 표로 남겼다.

마이그레이션은 손으로 썼다 — `igsid`/`mediaId` 를 NOT NULL 로 추가하려면 기존 행에 채울 값이
있어야 하는데 없어서 `DELETE FROM "SentReply"` 를 앞에 넣었다. 마커는 본래 휘발성이라
지워져도 "그 사람이 그 글에 한 번 더 받을 수 있다"가 전부다. 이유를 마이그레이션 파일에 적었다.

#### 공개 대댓글 (opt-in)

`IgAccount.defaultCommentReplyText` 하나만 추가했다. **null 이면 안 단다** — 설정하지 않은
사용자의 동작은 그대로고 새로 배울 개념이 없다([`why.md`](./why.md) 원칙 1).
캠페인별 override 는 요구가 생기면 그때 `templates.ts` 3단 폴백에 얹는다.

발송 실패해도 **던지지 않는다.** 거기 도달했다는 건 DM 이 이미 나갔다는 뜻이라, 던지면
SQS 재시도가 `DUPLICATE` 스킵만 쌓는다. `Event` 도 남기지 않는다 — `FAILED` 로 쓰면
"DM 발송 실패"와 섞여 Phase 3 퍼널이 오염된다.

테스트 169 → **183건**(+14), DB 멱등성 테스트 8 → **9건**.

#### 미해결: `ACCOUNT_MISMATCH` 노이즈

발송 직후마다 1건씩 쌓이는데 원인을 모른다. 페이로드를 로그에 남기지 않기 때문이다.
**추측으로 고치지 않고** 실제 `entry.id` 를 남기는 `console.warn` 만 넣었다
(`webhook.service.ts`). `normalize.ts` 는 불변식 #4 때문에 순수 함수로 둬야 해서 거기 넣지 않았다.
다음 실사용 한 번으로 특정되면 그때 고친다.

### 2026-09-03 — 관통 ✅ 원인은 **앱이 개발 모드**였다

```
02:27:49  COMMENT_RECEIVED      @xowls0002026  media=18128361763670546
02:27:53  PRIVATE_REPLY_SENT    @xowls0002026  media=18128361763670546  4500ms
```

`SentReply` 마커 1건, `Conversation(WAITING_USER_MESSAGE)` 생성, `lastMediaId` 기록,
DLQ 0. 댓글 → webhook → SQS → 워커 → Instagram API 발송까지 실전에서 관통했다.

**원인**: 앱이 **개발 모드**면 실제 활동 이벤트가 아예 발생하지 않는다. 역할·구독·서명이
전부 맞아도 그렇다. 반면 **Webhooks 패널의 [테스트] 버튼은 수동 발송이라 모드와 무관하게
배달된다** — 이 비대칭이 진단을 오래 끌었다. "테스트는 오는데 실제만 안 온다" 가
개발 모드의 지문이다.

**라이브 전환은 App Review 와 무관하다.** 이 둘을 묶어서 보고 "게시하지 마세요" 라고
판단했던 게 틀렸다. 라이브 모드는 토글이고, App Review 는 Advanced Access 를 받기 위한
심사다. **Standard Access 그대로 라이브로 갈 수 있고, 모델 B 에는 그게 필요하다.**
§1-11 의 "Live 로 바꿔도 App Review 없이는 안 됨" 은 *비테스터에게 DM 을 보내는 것*에
대한 서술이지, 웹훅 발생 자체와는 다른 층위다.

**라이브 전환의 실제 관문은 개인정보처리방침 URL 이었다.** 외부 호스팅을 새로 붙이는
대신 이미 공개 HTTPS 로 떠 있는 API Lambda 에 `GET /privacy` 라우트를 달았다
(`legal.controller.ts`, 데이터 삭제 안내는 `/data-deletion`). 새 계정도 새 인프라도 없다.
**한 번 거부당한 건 라우트를 만들고 배포를 안 해서** 그 URL 이 404 였기 때문이다 —
Meta 는 URL 을 실제로 가져와서 검증한다. Phase 2 에서 웹앱이 생기면 그쪽으로 옮긴다.

> 페이지 내용은 코드가 실제로 하는 일과 일치시켰다(본문 미저장 · 토큰 AES-256-GCM ·
> 로그 7일). **동작을 바꾸면 이 페이지도 같이 고쳐야 한다.**

**남은 미해결 질문은 그대로다** — 역할 없는 제3 계정에서도 웹훅이 오는가.
지금 통과한 건 테스터(`xowls0002026`) 기준이다. 아래 항목 참조.

### 2026-09-03 — Meta 연결: 우리 쪽은 전부 통과, 이벤트만 안 온다

**우리 코드·인프라는 실전에서 검증됐다.** Meta Webhooks 의 [테스트] 버튼이 쏜 요청이
`COMMENT_SKIPPED / ACCOUNT_MISMATCH` 행을 남겼다. 이 한 줄이 증명한 것:
Function URL 도달 → slug 조회 → App Secret 복호화 → **HMAC 서명 검증 통과** →
normalize → Event 기록. 서명이 이 프로젝트의 가장 큰 미지수였는데 저장된 Instagram
app secret 하나로 통과했다 — `parentAppSecret` 은 필요 없었다 (#7).

`ACCOUNT_MISMATCH` 는 정상이다. 테스트 페이로드의 `entry.id` 가 샘플 값이라 normalize 가
올바르게 걸렀다.

**삽질 1 — 토큰을 엉뚱한 계정으로 발급했다.** `GET /me` 가 `xowls0002026`(테스터로 쓰려던
부계정)을 돌려주는 걸 한참 뒤에 알았다. 연동 대상은 `hi_im_taetae` 였다. 대시보드의
"API setup with Instagram business login" 계정 목록에는 **Instagram 테스터 역할이 있는
계정만** 뜨는데, 그때 테스터는 부계정 하나뿐이었다. 그래서 그것만 보였고 그걸 눌렀다.
→ **연동할 본인 계정도 Instagram 테스터여야 한다.** 개발 모드에서 App Review 없이
Standard Access 로 도는 구조(§4 모델 B)의 필연적 결과다. 관리자(Meta 계정) 역할과는
완전히 별개 체계라 헷갈리기 쉽다.

**삽질 2 — `subscribed_apps` 가 조용히 절반만 성공했다.** [`meta-api.md`](./meta-api.md)
§1.1 에 따로 적었다. 되읽기 검증을 코드에 넣었고, 재연결 때 실제로 작동했다.

**남은 벽 — 실제 이벤트가 한 건도 오지 않는다.**

계정(`hi_im_taetae`, BUSINESS)·구독(`comments`,`messages`)·게시물·댓글이 전부 실재하는데
webhook 은 0건이다. 동시에 API 응답도 이상하다:

| 호출 | 응답 |
|---|---|
| `GET /{media}/comments` | `comments_count=1` 인데 `data: []` |
| `GET /me/conversations` | `data: []` 인데 **`next` 커서는 존재** |

빈 배열인데 페이지네이션 봉투는 살아 있다 — **행을 찾았지만 응답에서 걸러냈다**는 뜻이다.
개발 모드에서 앱에 권한을 주지 않은 사용자의 데이터를 가리는 동작과 일치한다.
테스트 페이로드는 오는데 실제 활동만 안 오는 것도 같은 그림이다.

**이게 §1-11 이 경고한 벽일 가능성이 있다** — "앱을 Live 로 바꿔도 App Review 없이는 안 됨".
그렇다면 §4 모델 B 의 전제("각 앱이 자기 계정만 다루므로 Standard Access 로 충분")와
충돌한다. 댓글을 다는 사람은 "자기 계정"이 아니라 제3자이기 때문이다.

**판정 실험**: 앱에 아무 역할이 없는 제3 계정으로 댓글을 달아본다.
- 온다 → 모델 B 성립, 예정대로 진행
- 안 온다 → **테스터에게만 동작. Phase 2 착수 전에 제품 방향을 재검토해야 한다**

UI 를 얹기 전에 반드시 답이 나와야 하는 질문이라 완료 기준에 포함한다.

### 2026-09-03 — 배포 후 AWS 전수 점검

`/health` 200 이후, 인프라가 템플릿대로 섰는지와 **각 Lambda 가 실제로 부팅되는지**를 따로 확인했다.

| 확인 | 결과 |
|---|---|
| Lambda×2 | `nodejs24.x` · arm64 · 512MB · 30s |
| Worker 이벤트 소스 매핑 | `Enabled` · BatchSize 10 · `ReportBatchItemFailures` |
| 큐 | visibility 180s · `maxReceiveCount: 5` · DLQ 연결 · 양쪽 깊이 0 |
| 로그 그룹 | 둘 다 **7일 보존** (비용 통제가 실제로 걸렸는지) |
| API DB 경로 | `GET/POST /webhook/nope` → 404. `/health` 는 DB 를 안 건드려서 따로 확인해야 했다 |
| Worker 부팅 | 합성 SQS 이벤트로 직접 invoke |

**Worker 는 그때까지 한 번도 실행된 적이 없었다.** API 와 부팅 경로가 다르다
(Secrets Manager → 마스터 키 → Prisma → Neon). 여기서 실패하면 실제 댓글이 올 때
5번 재시도 후 DLQ 로 가고, 그제서야 알게 된다. 그래서 **없는 `igUserId`** 를 담은 합성
이벤트를 만들어 invoke 했다 — `buildContext` 가 null 을 돌려주는 경로라 DB 쓰기도
Instagram 호출도 없이 부팅 체인만 검증된다. `{"batchItemFailures":[]}` + §8 #2 에서
넣은 `console.error` 로그가 그대로 찍혔다 (콜드스타트 444ms, 총 2.4s).

**부수 발견 — `sslmode` 가 나중에 조용히 강등된다.** Worker 로그에 node-postgres 경고가
있었다: 지금은 `require` 를 `verify-full` 의 별칭으로 처리하지만(= 인증서 완전 검증),
**pg v9 부터 libpq 의미로 바뀌어 검증이 꺼진다.** 고객의 Instagram 토큰이 든 DB라
의존성 범프 한 번에 연결이 MITM 에 열리는 건 받아들일 수 없다. `verify-full` 을 명시하면
오늘 동작은 완전히 동일하면서 그 변화를 건너뛴다 — `ops.example/deploy.env.example` 을
고쳤고, **각자의 `ops/deploy.env` 에도 같이 반영한 뒤 `scripts/create-secret.sh` 를
다시 돌려야 한다** (Lambda 는 다음 콜드스타트에 반영. 재배포 불필요).

### 2026-09-03 — 첫 배포에서 502 (Node 24 콜백 핸들러)

스택은 `CREATE_COMPLETE` 인데 **모든 요청이 502** 였다. 로그의 원인:
`Runtime.CallbackHandlerDeprecated` — **Node.js 24 Lambda 런타임은 콜백 방식 핸들러 지원을
제거했고, `handler.length === 3` 이면 콜백 방식으로 판정해 초기화 자체를 거부한다.**

```ts
// 죽던 코드 — callback 을 받아서 arity 가 3
export const handler: Handler = async (event, context, callback) => {
  const server = await appCache.run();
  return server(event, context, callback);
};
```

넘기던 `callback` 은 `@codegenie/serverless-express` 가 쓰지도 않았다
(`src/configure.js` 의 실제 구현은 `async function handler (event, context)`).
파라미터를 지우는 것으로 끝났다. 다만 이 라이브러리의 **타입 선언이 실제 구현과 달라**
3번째 인자를 요구하므로, 호출부에는 무시되는 no-op 을 넘겨 타입만 맞췄다.

**§8 #1과 같은 종류의 두 번째 사고다.** 그때는 `nest build` 산출물에 `node_modules` 가 없어
콜드스타트에서 죽었고, 이번엔 핸들러 시그니처였다. 둘 다 **타입체크·테스트·번들이 전부
초록불인데 실제 Lambda 런타임에서만 죽는다.** 그래서 이번엔 개별 버그를 고치는 데서 멈추지
않고 `scripts/deploy.sh` 끝에 `GET /health` 가 200 인지 확인하는 스모크 체크를 넣었다 —
초기화 실패라는 **종류 전체**를 배포 시점에 잡는다. 실패하면 로그 tail 명령까지 찍고 exit 1.

### 2026-09-03 — Wave 4 준비 (배포 전)

**§7의 "계정을 SQL로 직접 삽입"이 애초에 불가능했다.** `accessTokenEnc`/`appSecretEnc` 는
AES-256-GCM 암호문이고 마스터 키가 필요하다 — 순수 SQL로 만들 수 없다. 계획 단계에서
발견해서 `scripts/connect-account.ts` 로 대체했다. **캠페인은 암호화 필드가 없으므로
원래대로 SQL 그대로 간다** — 필요한 곳에만 스크립트를 만들었다.

**새 API 코드는 한 줄도 안 썼다.** 필요한 게 이미 전부 있었다 — `getMe()`, `subscribeApp()`,
`encrypt()`, `getMasterKey()`, `getPrisma()`. 스크립트는 이것들의 호출 순서일 뿐이다.
게시물 목록도 `client.ts` 에 `listMedia()` 를 추가하는 대신 `curl` 한 줄로 끝냈다 —
Phase 2에서 URL 붙여넣기 UI가 생길 때 승격시킨다.

**IG User ID를 사용자가 찾을 필요가 없다는 걸 뒤늦게 알았다.** `getMe()` 가 `user_id` 를
돌려주므로 온보딩 입력은 토큰과 app secret 두 개면 된다. 대시보드에서 헤매는 단계 하나가
통째로 사라졌다. 화면 위치는 공식 문서로 재확인해 [`meta-api.md`](./meta-api.md) §4.1 에 적었다.

**검증을 Stage A/B로 쪼갰다.** "두 번째 계정 없이 그냥 내 계정으로 테스트하면 안 되나?"라는
질문에서 나왔다. 답은 "절반은 된다" — 발송은 안 되지만(§1-11, §1-12) 수신 경로는 전부 돌고
`COMMENT_SKIPPED(SELF_COMMENT)` 행이 남는다. 그 절반이 하필 `subscribed_apps` 누락과
서명 불일치, 즉 **실패 확률이 가장 높은 두 지점**을 덮는다. 그래서 두 번째 계정을 만들기
전에 Stage A만 먼저 돌려 위험을 걷어내는 순서가 됐다.

**두 스크립트에 자체 테스트를 붙이지 않았다.** 로직이 전부 이미 테스트된 함수의 호출
순서고, "두 번 연속 실행해서 `verifyToken` 이 안 바뀌는지" 확인하는 게 실질적인 체크다.
값을 넣는 즉시 결과가 눈에 보이는 일회성 운영 도구라 목 DB/목 fetch 비용이 얻는 것보다 크다.
