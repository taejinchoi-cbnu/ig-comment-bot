# ig-comment-bot

인스타그램 게시물에 키워드 댓글이 달리면 **자동으로 DM을 보내고, 그게 얼마나 먹혔는지 보여주는** 서비스.

사용자가 하는 일은 두 가지뿐 — 게시글 URL 붙여넣기, 보낼 DM 쓰기.
그 다음 대시보드에서 `댓글 84 → DM 79 → 답장 41 → 양식 38` 을 본다.

> 상용 자동 DM 서비스에 대한 불만은 "기능이 부족하다"가 아니라
> **"쓰기가 어렵다"와 "통계가 어렵다"** 였다. 그 둘을 해결하려고 만든다.

지인들에게 직접 쓸 수 있는 서비스를 만드는 것이 목적이라 상용화하지 않는다 — Meta App Review,
결제, 요금제가 없다. 인프라 원가는 월 $1~2.

## 현재 상태

| | |
|---|---|
| **백엔드 (Phase 1)** | ✅ 완료. webhook 수신 → 정규화 → 큐 적재 → Instagram API 발송까지 실제로 돈다 |
| **웹 대시보드 (Phase 2)** | 🚧 미착수. 지금은 `pnpm connect-account` 스크립트 + DB 직접 조회로 운영 중 |

`apps/web`은 아직 코드가 없다. 아래 아키텍처의 CloudFront/S3/SPA 부분은 설계이지 현재 배포 상태가 아니다.

## 아키텍처

```
                    CloudFront (단일 도메인, HTTPS)
                    ├── /                → S3   (React SPA, 미구현)
                    ├── /api/*           → Lambda Function URL ┐
                    └── /webhook/:slug   → Lambda Function URL ┘  같은 NestJS 앱
                                                    │
Instagram ──webhook──────────────────────────────────┤
                                                    ├──> SQS ──> Lambda (워커)
                                                    │              │
                                                    │              ├──> Instagram Graph API
                                                    ▼              ▼
                                            PostgreSQL (Neon) · Prisma
                                                    ▲
                                        Secrets Manager (마스터 암호화 키, DB URL)
```

원칙은 두 가지뿐이다.

- **webhook 경로는 Instagram API를 절대 호출하지 않는다.** 검증 → 정규화 → SQS 적재 → 200 응답만 한다.
  Meta는 non-200이 반복되면 구독을 끊는데, 그 경로에서 외부 API를 부르면 장애가 곧바로 구독 해지로 번진다.
- **바깥으로 나가는 부작용은 전부 워커(SQS 소비자)에서만 일어난다.** 그래야 SQS의 재시도·DLQ가
  실제로 안전망 역할을 한다.

멱등성은 락 테이블이나 분산 뮤텍스 없이 조건부 SQL 두 문장으로 처리한다 —
`INSERT ... ON CONFLICT DO NOTHING`(중복 댓글 차단)과 `UPDATE ... WHERE state = ... RETURNING`
(중복 메시지 차단 + 캠페인 조회를 한 쿼리로). 모든 쿼리는 `igAccountId`로 스코프돼 있어
계정 간 데이터가 섞이지 않는다.

## 하네스 구조 — 코드 하나, 진입점 세 개

NestJS 앱은 **하나**다. 어디서 실행되는지에 따라 다른 "하네스"가 그 코드를 감싼다 — 비즈니스 로직을
환경마다 새로 쓰지 않기 위한 구조다.

| 진입점 | 언제 쓰나 | 하는 일 |
|---|---|---|
| [`src/main.ts`](apps/api/src/main.ts) | 로컬 개발 / 셀프호스팅 | `AppModule`을 그대로 부팅해 HTTP 서버 하나로 전부 처리 |
| [`src/lambda/http.ts`](apps/api/src/lambda/http.ts) | webhook 수신 + API (Lambda Function URL) | 같은 `AppModule`을 [`@codegenie/serverless-express`](https://github.com/CodeGenieApp/serverless-express)로 감싸 Lambda 이벤트를 HTTP 요청으로 변환. 컨테이너가 재사용되는 동안은 부트한 앱 인스턴스를 메모이즈해 재사용 |
| [`src/lambda/sqs.ts`](apps/api/src/lambda/sqs.ts) | SQS 워커 | NestJS HTTP 계층을 아예 띄우지 않는다. Prisma·Instagram 클라이언트를 직접 만들어 [`processing/registry.ts`](apps/api/src/processing/registry.ts)의 핸들러를 호출하고, 실패한 메시지만 골라 재시도시키는 부분 배치 응답(`batchItemFailures`)을 돌려준다 |

세 진입점이 공유하는 것은 `AppModule`이 아니라 그 아래 **도메인 코드**(`webhook/normalize.ts`,
`processing/*.handler.ts`, `instagram/client.ts`, `crypto/cipher.ts`)다. `normalize.ts`처럼
테스트가 가장 중요한 모듈은 순수 함수로만 짜여 있어 Nest 데코레이터에 의존하지 않는다 — 그래서
SQS 워커(`lambda/sqs.ts`)처럼 Nest 앱 부팅 없이 직접 호출해도 그대로 동작한다.

## 스택

React + Vite + TS (웹, 미착수) · NestJS + TS (API) · PostgreSQL + Prisma · AWS Lambda + SQS + CloudFront

- **Lambda Function URL** — API Gateway 대신. 요청당 과금이 없다
- **SQS + 부분 배치 응답** — webhook은 즉시 200, 실패한 발송만 재시도
- **Prisma 7 + `@prisma/adapter-pg`** — 네이티브 바이너리 없이 순수 JS 드라이버라 esbuild로 그대로 번들링된다
- **AES-256-GCM** — Instagram 액세스 토큰/앱 시크릿은 암호화해 Postgres에 저장. 댓글·DM 본문은 아예 저장하지 않는다
- **테스트 프레임워크 없음** — Node 24 내장 `node --test` + 타입 스트리핑으로 `.ts`를 컴파일 없이 직접 실행

## 실행

```bash
pnpm install
pnpm typecheck        # tsc --noEmit
pnpm test             # node --test
pnpm -F api dev       # 로컬 API 서버 (:3000)
```

배포(`scripts/deploy.sh`)는 AWS 자격 증명과 `ops/deploy.env`(gitignore 대상, 운영자 전용)가 있어야
동작한다. SAM CLI는 설치하지 않고 `aws cloudformation deploy --capabilities CAPABILITY_AUTO_EXPAND`로
SAM transform을 서버 측에서 처리한다.

## 문서

- [`AGENTS.md`](AGENTS.md) — 아키텍처 불변식, 기여 규칙, 하지 말아야 할 것
- [`study/`](study/) — 판단 과정을 기록한 회고 (PAAR 구조)

라이선스: [CC BY-NC 4.0](LICENSE) — 상업적 사용만 제한.
