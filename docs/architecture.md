# 아키텍처

> 코드를 쓸 때 참조하는 문서. Meta API 쪽 제약은 [`meta-api.md`](./meta-api.md)에 따로 있다.

## 전체 그림

```
                    CloudFront (단일 도메인, HTTPS)
                    ├── /                → S3   (React SPA)
                    ├── /api/*           → Lambda Function URL ┐
                    └── /webhook/:slug   → Lambda Function URL ┘  같은 NestJS 앱
                                                    │
Instagram ──webhook──────────────────────────────────┤
                                                    ├──> SQS ──> Lambda (SQS 어댑터)
                                                    │              │  같은 NestJS 코드
                                                    │              ├──> Instagram Graph API
                                                    ▼              ▼
                                            PostgreSQL (Neon) · Prisma
                                                    ▲
                                        Secrets Manager (마스터 암호화 키, DB URL)
```

## 결정과 근거

| 결정 | 근거 |
|---|---|
| **NestJS 앱 1개 + Lambda 진입점 2개** (`lambda/http.ts`, `lambda/sqs.ts`) | webhook·API·워커가 같은 서비스·DTO·Prisma 클라이언트를 공유한다. 배포 단위만 둘이고 코드는 하나. 로컬/셀프호스팅은 `main.ts` 하나로 전부 한 프로세스에서 실행 |
| **SQS 유지** | webhook은 즉시 200을 돌려줘야 한다(비200이 반복되면 Meta가 구독을 끊는다). Instagram API 실패는 재시도돼야 한다. Lambda 이벤트 소스 매핑 + DLQ가 코드 0줄이고 무료 티어 안에 들어간다 |
| **API Gateway 대신 Lambda Function URL** | 요청당 과금이 **없다** (API Gateway는 $1/M). 앞단은 어차피 CloudFront로 통일 |
| **CloudFront 단일 도메인** | SPA와 API가 같은 오리진 → **CORS 설정이 필요 없다**. Meta에 줄 webhook URL도 같은 도메인 |
| **PostgreSQL + Prisma** | 데이터가 관계형이고, 대시보드/퍼널 쿼리가 SQL 한 줄로 끝난다. 멱등성도 `ON CONFLICT` / `UPDATE ... RETURNING`으로 단순해진다. Neon 무료 티어 + scale-to-zero, serverless driver라 Lambda 커넥션 풀링 문제가 없다 |
| **자체 JWT 인증** (passport-local + `@nestjs/jwt`) | 사용자가 25명 이하이고 어차피 운영자가 수동 승인(Instagram Tester 초대)한다. Cognito/Clerk는 이 규모에 과하다 |
| **리전 `ap-southeast-1`(싱가포르)** | Neon과 같은 리전에 둔다. 아래 §리전 참고 |
| **VPC 미사용** | 전부 서버리스라 VPC 밖에서 동작한다. VPC에 넣으면 아웃바운드용 NAT Gateway가 **월 ~$32** 붙고 콜드스타트만 늘어난다. 순손실 |
| **고객별 IAM 유저 안 만듦** | 고객은 AWS를 호출하지 않는다(모든 호출은 우리 Lambda가 한다) → 귀속될 요청이 0건. 게다가 **AWS 청구에는 IAM 주체별 비용 축이 없다**. 사용량은 `Event` 테이블로 센다 |

**콜드스타트**: NestJS 부트는 ~300~600ms. Meta webhook 응답에 충분하다. 문제가 되면 provisioned concurrency 한 줄이므로 지금 최적화하지 않는다.

---

## Prisma 7 구성

Prisma 7은 **드라이버 어댑터가 필수**다. PrismaClient가 더 이상 자체적으로 DB에 연결하지 않고,
`datasource.url`은 스키마가 아니라 `prisma.config.ts`로 옮겨갔으며 **`directUrl`은 제거**됐다.
6.x 기준 예제를 그대로 따라하면 맞지 않는다.

결과적으로 **CLI와 런타임이 서로 다른 URL을 쓰도록 분리**됐는데, Neon 구성에 오히려 잘 맞는다.

| | 쓰는 URL | 이유 |
|---|---|---|
| `prisma migrate` (CLI) | `DATABASE_URL_UNPOOLED` | 마이그레이션은 PgBouncer를 지원하지 않는다 |
| `PrismaClient` (런타임) | `DATABASE_URL` (pooled) | 짧은 연결이 많은 서버리스에 적합 |

```ts
// prisma.config.ts — CLI 전용
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL_UNPOOLED') },  // 예전의 directUrl 자리
});
```

```ts
// 런타임 — 어댑터에 pooled URL
import { PrismaClient } from '../generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

**어댑터는 `@prisma/adapter-pg`를 쓴다.** Neon 전용 `@prisma/adapter-neon`(WebSocket)도 있지만,
그 장점인 "TCP 핸드셰이크 회피"는 원거리 연결에서 나온다. 우리는 Lambda와 DB가 같은 리전이라
효과가 작고, `adapter-pg`는 어떤 Postgres에서도 그대로 동작해 이식성이 남는다.
콜드스타트 실측에서 연결 설정이 병목으로 잡히면 그때 교체한다.

주의할 것:
- **환경변수가 자동 로드되지 않는다.** `dotenv`를 명시적으로 import해야 한다
- `generator client`의 `output`이 **필수**가 됐다. 더 이상 `node_modules`에 생성되지 않는다
- **테스트 대상 순수 함수는 생성된 Prisma 코드를 import하지 않는다.** `normalize` `signature` `trigger`는
  평범한 인자만 받는다 — 타입 스트리핑이 못 다루는 문법이 딸려 들어오는 것을 막고,
  테스트에서 DB를 흉내 낼 필요도 없어진다

---

## 데이터 모델

```prisma
enum UserStatus        { PENDING ACTIVE }
enum AccountStatus     { DRAFT CONNECTED ERROR }
enum ConversationState { WAITING_USER_MESSAGE USER_REPLIED FORM_SENT }

enum EventType {
  COMMENT_RECEIVED  COMMENT_SKIPPED  PRIVATE_REPLY_SENT
  USER_REPLIED      FOLLOW_UP_SENT   FAILED
}

enum SkipReason {
  SELF_COMMENT  NO_KEYWORD_MATCH  DUPLICATE
  CAMPAIGN_DISABLED  ECHO  NO_TEXT  ACCOUNT_MISMATCH
}

model User {
  id           String     @id @default(cuid())
  email        String     @unique
  passwordHash String
  status       UserStatus @default(PENDING)   // 운영자가 수동 승인
  igAccounts   IgAccount[]
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
}

model IgAccount {
  id       String  @id @default(cuid())
  userId   String
  user     User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  igUserId String  @unique          // Meta webhook 의 entry[].id
  username String?
  slug     String  @unique          // webhook 경로 /webhook/:slug

  accessTokenEnc String              // AES-256-GCM 암호문
  appSecretEnc   String
  verifyToken    String

  status         AccountStatus @default(DRAFT)
  subscribedAt   DateTime?           // subscribed_apps 호출 성공 시각
  tokenExpiresAt DateTime?           // 60일 만료 경고용
  lastCheckedAt  DateTime?

  defaultPrivateReplyText String?     // 캠페인에 없을 때 폴백
  defaultFollowUpText     String?

  campaigns     Campaign[]
  conversations Conversation[]
  sentReplies   SentReply[]
  events        Event[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

/// UI에서는 "자동 DM"이라고 부른다 (why.md 원칙 1)
model Campaign {
  id          String    @id @default(cuid())
  igAccountId String
  igAccount   IgAccount @relation(fields: [igAccountId], references: [id], onDelete: Cascade)

  mediaId      String
  permalink    String
  thumbnailUrl String?
  caption      String?                       // 목록에서 어느 글인지 알아보게
  label        String?

  triggerKeywords  String[] @default([])     // 비면 모든 댓글
  privateReplyText String?                   // null 이면 계정 기본값
  followUpText     String                    // 사용자가 입력하는 "보낼 DM"
  enabled          Boolean  @default(true)

  events Event[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([igAccountId, mediaId])
}

model Conversation {
  id          String    @id @default(cuid())
  igAccountId String
  igAccount   IgAccount @relation(fields: [igAccountId], references: [id], onDelete: Cascade)
  igsid       String

  state          ConversationState
  lastCommentId  String?
  lastMediaId    String?             // ← 게시물별 문구가 성립하는 이유
  lastCampaignId String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([igAccountId, igsid])     // 조건부 UPDATE 의 키
}

/// Private Reply 멱등성 마커. 행의 존재 자체가 "이미 보냄"을 뜻한다
model SentReply {
  igAccountId String
  igAccount   IgAccount @relation(fields: [igAccountId], references: [id], onDelete: Cascade)
  commentId   String
  createdAt   DateTime  @default(now())

  @@id([igAccountId, commentId])
}

/// ★ 활동 피드 + 퍼널 분석의 원천. 기록하지 않은 과거는 복원되지 않는다
model Event {
  id          String    @id @default(cuid())
  igAccountId String
  igAccount   IgAccount @relation(fields: [igAccountId], references: [id], onDelete: Cascade)

  campaignId String?
  campaign   Campaign? @relation(fields: [campaignId], references: [id], onDelete: SetNull)
  mediaId    String?                 // 비정규화 — 캠페인을 지워도 통계가 남는다

  igsid    String?
  username String?                   // 활동 피드/CSV 실용성. 본문은 저장하지 않는다

  type       EventType
  skipReason SkipReason?             // "왜 DM이 안 갔지?" 에 답하는 열
  errorCode  String?
  latencyMs  Int?
  isFollower Boolean?                // Phase 3. 반응 시점 값을 박제 — 나중에 조회하면 변한다

  createdAt DateTime @default(now())

  @@index([igAccountId, createdAt])          // 활동 피드
  @@index([igAccountId, mediaId, type])      // 퍼널 GROUP BY
}
```

### 지금 확정해야 하는 것과 나중에 해도 되는 것

가르는 기준은 **"나중에 붙일 때 과거 데이터를 버려야 하는가"** 다.

| | |
|---|---|
| **지금** | `Event`의 열 전부 (`skipReason` `mediaId` `latencyMs` `isFollower`). 기록하지 않은 과거는 소급 생성이 불가능하다 |
| **지금** | 모든 테이블의 `igAccountId` 스코프. 나중에 넣으면 키 설계를 통째로 바꿔야 한다 |
| 나중 | Phase 3의 계정 인사이트 스냅샷 — **새 테이블**이라 백필 문제가 없다 |
| 나중 | 온보딩 UI·결제·OAuth — 데이터 모델이 바뀌지 않는다 |

### 개인정보 원칙

**댓글 작성자의 `username`은 저장하고, 댓글·DM 본문은 저장하지 않는다.**
활동 피드와 CSV의 실용성은 username에서 나오고, 위험은 본문에서 나온다. 로그도 마찬가지다.

---

## 멱등성 — SQL 두 문장이 전부

외부 webhook은 중복 전달을 전제해야 하고, Private Reply는 댓글당 1회뿐이라 중복이 치명적이다.
원본 설계의 별도 멱등성 아이템 + lease 방식은 **쓰지 않는다.** 조건부 SQL이 같은 보장을 더 단순하게 한다.

```sql
-- 댓글: 중복 webhook 차단
INSERT INTO sent_replies (ig_account_id, comment_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;
-- 영향 행 0 = 이미 보냄 → skip
-- 발송이 retryable 에러로 실패하면 이 행을 DELETE 하고 throw (SQS 재시도가 다시 잡는다)

-- 메시지: 중복 차단 + 캠페인 조회를 한 문장으로
UPDATE conversations SET state = 'USER_REPLIED'
 WHERE ig_account_id = $1 AND igsid = $2
   AND state = 'WAITING_USER_MESSAGE'
RETURNING last_media_id, last_campaign_id;
-- 0 rows = 대화 없음 / 이미 발송 / 중복 → skip
-- 발송 실패(retryable) 시 state를 WAITING_USER_MESSAGE로 롤백하고 throw
```

`RETURNING` 덕분에 **중복 방지와 캠페인 조회가 한 번의 쿼리로** 끝난다. 별도 SELECT가 없다.

> 외부 API 부작용을 완벽한 exactly-once로 만들 수는 없다. 목표는 **중복 발송 시도를 시스템 내부에서 최소화**하는 것이다.

---

## 게시물별 문구

**문제**: 후속 DM은 MESSAGE 이벤트에서 발송되는데, 그 시점엔 IGSID만 있고 **어느 게시물에서 시작된 대화인지 알 수 없다.**

**해결**: 댓글 처리 시 `lastMediaId` / `lastCampaignId`를 대화에 저장해두고, 위 `UPDATE ... RETURNING`으로 되찾는다.

```
COMMENT  → value.media.id 를 conversations.last_media_id 에 저장
MESSAGE  → UPDATE ... RETURNING last_media_id → 그 게시물의 문구로 발송
```

**문구 해석 = 3단 폴백 (필드 단위)**
```
Campaign.followUpText  →  IgAccount.defaultFollowUpText  →  시스템 기본값
```
캠페인을 안 만든 게시물은 자동으로 계정 기본 문구로 떨어진다. `privateReplyText`, `triggerKeywords`도 같은 폴백을 탄다.

**엣지 케이스**: 같은 사람이 게시물 A에 댓글 → 답장 전에 B에도 댓글 → **B가 이긴다(last-wins).**
대기 중인 컨텍스트를 큐로 쌓지 않는다. 이대로 두고 문서에 명시한다.

---

## 토큰 암호화

Secrets Manager에 **마스터 키 1개**만 두고(월 $0.40), 토큰/앱시크릿은 Node 내장 `crypto`의
**AES-256-GCM(레코드별 랜덤 IV)** 으로 암호화해 Postgres에 저장한다. 계정마다 시크릿을 만들지 않는다.

DB가 유출돼도 남의 인스타 토큰이 평문으로 나가지 않는다. 키 회전/감사가 필요해지면 KMS로 교체한다.

---

## 코드 구조

```
ig-comment-bot/                     (private repo)
├── pnpm-workspace.yaml
├── AGENTS.md                       에이전트/기여자 규칙 (CLAUDE.md는 심볼릭 링크)
├── docs/
├── infra/template.yaml             SAM 문법 — SAM CLI 없이 배포
├── ops/                            .gitignore. 운영자 전용
├── ops.example/
├── packages/shared/                API DTO 타입 (빌드 없음, src 직접 참조)
├── apps/web/                       React + Vite + TS + Tailwind
│   └── src/{pages,components,api}/
└── apps/api/                       NestJS + TS
    └── src/
        ├── main.ts                 로컬/셀프호스팅: HTTP + 인라인 워커
        ├── lambda/http.ts          Function URL 어댑터
        ├── lambda/sqs.ts           SQS 어댑터 → createApplicationContext()
        ├── auth/                   passport-local + JWT
        ├── accounts/               연결 마법사 · subscribed_apps · 토큰 검증
        ├── campaigns/              CRUD · 게시글 URL 해석
        ├── webhook/
        │   ├── webhook.controller.ts
        │   ├── signature.ts        HMAC (App Secret 2종 시도)
        │   └── normalize.ts        payload → BotEvent[]   ★순수 함수, 테스트 핵심
        ├── processing/
        │   ├── processor.service.ts  eventType → handler 레지스트리  ★기능 추가 지점
        │   ├── comment.handler.ts
        │   └── message.handler.ts
        ├── instagram/              Graph API 클라이언트 + 에러 분류
        ├── crypto/                 AES-256-GCM 토큰 암복호화
        └── prisma/
```

### 기능 추가 방법 (프레임워크 없이)

1. `normalize.ts`에 새 이벤트 케이스 추가
2. `processing/`에 핸들러 파일 추가
3. 레지스트리에 한 줄

```ts
export const handlers = {
  COMMENT: handleComment,
  MESSAGE: handleMessage,
} satisfies Record<BotEvent["eventType"], Handler>;
```
`satisfies`가 누락을 **컴파일 타임에** 잡는다. 핸들러는 `(event, ctx: AccountContext) => Promise<void>` 형태로,
`ctx = { account, instagram, prisma }` 를 평범한 객체로 주입받는다 → 테스트에서 mocking 라이브러리가 필요 없다.

**웹 스타일링**: 디자인이 아직 없으므로 Tailwind로 시작하고 마크업을 의미 있게 유지한다.
Claude Design 결과가 나오면 클래스만 교체하면 되도록.

---

## 빌드와 테스트

테스트 프레임워크를 넣지 않는다. Node 24 내장 `node --test` + 타입 스트리핑으로 **컴파일 없이 `.ts`를 직접** 돌린다.

```jsonc
// tsconfig.base.json — 이 두 줄이 핵심
"allowImportingTsExtensions": true,     // 테스트가 './trigger.ts' 를 직접 import
"rewriteRelativeImportExtensions": true // 빌드 시 './trigger.js' 로 자동 재작성
```

`rewriteRelativeImportExtensions`(TS 5.7+)가 없으면 둘 중 하나를 포기해야 한다 —
`.ts` import는 `allowImportingTsExtensions`가 필요한데 그건 원래 emit을 막기 때문이다.
실측으로 확인한 결과 `nest build` 산출물에 `require("./trigger.js")`로 정확히 나온다.

**순수 함수에는 데코레이터를 쓰지 않는다.** 타입 스트리핑은 타입만 지우고
데코레이터·파라미터 프로퍼티는 변환하지 못한다. `normalize` `signature` `trigger` 같은
테스트 핵심 모듈이 NestJS 데코레이터를 물면 그 순간 `node --test`가 깨진다.

- 테스트는 `tsconfig.build.json`에서 제외되어 빌드 산출물에 섞이지 않는다
- 경고 두 개(`ExperimentalWarning`, `MODULE_TYPELESS_PACKAGE_JSON`)는 원인을 알고
  `--disable-warning`으로 억제한다. 테스트는 ESM, 빌드 산출물은 CJS라
  `package.json`에 `type`을 박을 수 없다 (`"commonjs"`로 두면 Node가 ESM 문법을 거부)

---

## 배포

SAM CLI를 설치하지 않는다. SAM transform은 CloudFormation이 서버 측에서 처리하므로 `CAPABILITY_AUTO_EXPAND`면 충분하다.

**Lambda 코드는 `nest build`가 아니라 esbuild로 번들링한다.** `nest build`는 컴파일만 하고
`node_modules`를 담지 않는데, `CodeUri`가 가리키는 디렉터리 전체가 그대로 zip 되므로
그 상태로 배포하면 콜드스타트에서 `Cannot find module 'reflect-metadata'` 로 죽는다.

```bash
# apps/api/package.json 의 build:lambda 스크립트
esbuild src/lambda/http.ts src/lambda/sqs.ts \
  --bundle --platform=node --target=node24 --format=cjs \
  --outdir=dist-lambda --entry-names='[name]' \
  --external:@nestjs/microservices --external:@nestjs/websockets \
  --external:class-validator --external:class-transformer
```

`--external` 네 개는 코드가 필요로 하는 게 아니라 **NestJS 자신이** 마이크로서비스·웹소켓·
검증 파이프를 선택적으로 지원하려고 내부에서 `require()`로 찔러보는 패키지들이다.
우리는 설치조차 안 했으므로 esbuild가 정적 분석 시점에 못 찾아 죽는데, Nest 쪽이 이미
그 호출을 try/catch로 감싸두었으니 `--external`로 넘겨 런타임에 도달하지 않게 두면 된다.

번들링이 가능한 이유는 Prisma 7의 driver adapter(`@prisma/adapter-pg`) 방식이 네이티브
바이너리(`libquery_engine.*.node`)를 쓰지 않는 순수 JS 경로라서다. 네이티브 바이너리가 있었다면
esbuild 번들 안에 안 들어가 별도 처리가 필요했을 것이다.

```bash
pnpm -F @ig/api build:lambda   # apps/api/dist-lambda 에 http.js / sqs.js 생성

aws cloudformation package --template-file infra/template.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" --output-template-file packaged.yaml

aws cloudformation deploy --template-file packaged.yaml \
  --stack-name ig-comment-bot-dev \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides Environment=dev

# Phase 2 이후 — 웹 배포
aws s3 sync apps/web/dist "s3://$WEB_BUCKET" --delete
aws cloudfront create-invalidation --distribution-id "$CF_ID" --paths '/*'
```

`scripts/deploy.sh` 가 위 흐름을 그대로 실행한다. `Environment` 은 `ops/deploy.env` 의
`ENVIRONMENT` 값을 따른다 (기본 `dev`) — `STACK_NAME` 을 prod로 바꿨는데 `Environment`
을 안 바꾸면 prod 스택이 dev의 Secrets Manager 항목을 참조하게 된다.

IAM은 배포 전용 유저 `ig-bot-deployer` 1개 + CI용 OIDC Role 1개.

---

## 리전 — 싱가포르 (`ap-southeast-1`)

**Neon에는 서울·도쿄 리전이 없다.** 아시아는 싱가포르와 시드니뿐이고,
**기존 프로젝트의 리전은 변경할 수 없다.** 그래서 DB는 싱가포르로 고정이고,
남는 결정은 "Lambda를 어디 둘 것인가" 하나다.

로컬(한국)에서 Neon 싱가포르로 실측한 값:

```
select 1 왕복   76.4 ms   (5회 평균, pooled/direct 동일)
최초 연결       ~500 ms   (scale-to-zero 에서 깨어날 때 +@)
```

76ms는 서울↔싱가포르 RTT다. 이 값을 어디서 내느냐가 갈린다.

| | Lambda 서울 | **Lambda 싱가포르** |
|---|---|---|
| Worker 1건 (쿼리 5회) | 5 × 76ms = **380ms** | 5 × 2ms = **10ms** |
| 대시보드 (한국 사용자) | 10ms + 380ms = **~390ms** | 70ms + 10ms = **~150ms** |

**직관과 반대로 한국 사용자 체감도 싱가포르가 빠르다.**
사용자↔API 왕복은 **한 번**만 내면 되는데, API↔DB 왕복은 **쿼리 수만큼 곱해진다.**
76ms를 다섯 번 내는 것보다 70ms를 한 번 내는 쪽이 낫다.

> 개인정보 소재지는 이 선택과 무관하다. 데이터는 어느 쪽이든 Neon 싱가포르에 있고,
> 설계상 **사전예약 양식 본문은 저장하지 않는다** (username과 이벤트 메타데이터만).

### 알아둘 것 — scale-to-zero 콜드스타트

Neon 무료 티어는 유휴 시 컴퓨트를 0으로 내린다. 깨어나는 데 **~500ms**가 붙는다.
webhook 경로는 `slug → 계정` 조회 한 번이 임계 경로에 있으므로, 오래 조용하다가 첫 댓글이 오면
그만큼 느리다. Meta의 webhook 타임아웃은 넉넉해서 동작에는 문제가 없다.
문제가 되면 그때 계정 조회를 Lambda 메모리에 캐시한다. **지금은 하지 않는다.**

---

## 비용 (월 ~$1~2)

| 항목 | 비용 |
|---|---|
| Lambda | 무료 티어 내 |
| Lambda Function URL | 요청당 과금 **없음** |
| CloudFront | 무료 티어 내 (1TB 전송 / 10M 요청) |
| SQS | 무료 티어 내 (1M 요청) |
| S3 | 몇 센트 |
| Neon PostgreSQL | 무료 티어 |
| Secrets Manager | $0.40 (마스터 키 1개) |
| **CloudWatch Logs** | **유일한 비용 리스크.** retention을 7일로 템플릿에 명시 |

로그를 헤프게 남기면 이게 나머지 전부보다 비싸진다. 본문을 안 남기는 이유가 개인정보만은 아니다.
