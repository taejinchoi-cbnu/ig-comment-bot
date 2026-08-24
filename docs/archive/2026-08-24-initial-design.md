> ## ⚠️ 보관용 — 참조하지 말 것
>
> **작성일 2026-08-24. 현재 설계로 대체됨.** 최신 내용은 [`../architecture.md`](../architecture.md)와
> [`../meta-api.md`](../meta-api.md)를 볼 것.
>
> 이 문서를 Meta 공식 문서와 대조한 결과 **아래 5개가 사실과 다르다.** 그대로 구현하면 동작하지 않는다.
>
> | 위치 | 문서 내용 | 실제 |
> |---|---|---|
> | §5.2 | 댓글 payload가 `entry[].field` | `entry[].changes[].field`. IGSID는 `value.from.id` — 그대로 짜면 파싱 실패 |
> | §5.4 · §17 | echo 필터 없음 | 봇이 보낸 DM이 `message.is_echo`로 되돌아옴 → **무한루프** |
> | §26 | 계정 구독 단계 없음 | `POST /me/subscribed_apps` 없으면 **webhook이 아예 안 온다** |
> | §23.1 | webhook Lambda 권한이 `sqs:SendMessage`뿐 | HMAC 검증에 App Secret 필요 → 시크릿 조회 권한 |
> | §5.5 | "팔로워 판별 API가 없다" | `is_user_follow_business` **존재함**. 단 대화 성립 후에만 조회 가능 |
>
> 그 밖에 대체된 결정: 단일 계정 → 멀티 계정 / DynamoDB → PostgreSQL / 별도 멱등성 아이템 + lease →
> 조건부 SQL 2문장 / headless 스크립트 → 웹 서비스 / 상용화 → 지인 대상·포트폴리오.
>
> **남겨두는 이유**: 초기 설계를 공식 문서로 검증해 오류를 잡아낸 이력 자체가 기록할 가치가 있다.

---

# Instagram Comment → DM 자동화 시스템 최종 설계

> 상태: Implementation Ready
>
> 기준일: 2026-08-24
>
> 대상: 단일 Instagram Professional 계정 기반 MVP
>
> 구현: TypeScript + Node.js 24 + AWS Lambda
>
> AWS Region 예시: `ap-northeast-2` (Seoul)
>
> IaC/배포: AWS SAM + AWS CLI + GitHub Actions(OIDC)

---

## 1. 목적

Instagram 게시물 댓글을 트리거로 자동 DM을 보내고, 사용자가 답장하면 후속 메시지로 사전예약 양식을 안내하는 서버리스 시스템을 구축한다.

### 1.1 실제 사용자 플로우

**첫 번째 메시지 — 댓글 작성 시 발동**

> 팔로워인지 확인할게요! 아무 메시지나 보내주세요 💬

**두 번째 메시지 — 사용자가 DM으로 답장한 후 발송**

> ❤️사전예약 양식❤️  
> 성함 :  
> 생년월일 :  
> 연락처 :  
> 통신사 :  
> 희망기종 :  
> 거주지역 :  
> 위 양식 작성해주시면 업무 조회 후 상담도와드리겠습니다😃

### 1.2 Meta API 관점의 정확한 의미

첫 번째 메시지는 댓글의 `comment_id`를 대상으로 하는 **Private Reply**다. Meta 공식 문서상 댓글에 대한 Private Reply는 댓글 1개당 1회만 가능하고, 게시물/Reel의 경우 댓글 후 7일 이내에 보낼 수 있다. 후속 메시지는 사용자가 응답한 뒤에만 가능하며, 응답 이후 24시간 내에 보내야 한다. 따라서 두 번째 메시지는 일반 메시지 전송으로 분리하여 구현한다. [Meta Instagram API 공식 컬렉션](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) 참조.

---

# 2. 요구사항

## 2.1 Functional Requirements

| ID | 요구사항 |
|---|---|
| FR-01 | Instagram 댓글 webhook을 수신한다. |
| FR-02 | 댓글 이벤트를 SQS에 enqueue하고 webhook 요청은 빠르게 성공 응답한다. |
| FR-03 | 댓글당 최대 한 번의 Private Reply를 시도한다. |
| FR-04 | 첫 메시지는 고정 문구를 사용한다. |
| FR-05 | 사용자의 DM 답장을 webhook으로 수신한다. |
| FR-06 | 사용자가 답장한 경우 두 번째 사전예약 안내 메시지를 보낸다. |
| FR-07 | 이벤트 중복 수신을 멱등적으로 처리한다. |
| FR-08 | Instagram API의 일시적 실패는 SQS retry로 재처리한다. |
| FR-09 | 반복 실패 이벤트는 DLQ에 보존한다. |
| FR-10 | 처리 상태를 DynamoDB에 기록한다. |
| FR-11 | Instagram access token 등의 secret은 GitHub가 아닌 Secrets Manager에 저장한다. |
| FR-12 | 코드와 AWS 인프라 정의를 Git으로 버전 관리한다. |
| FR-13 | PR에서 lint/typecheck/test/build를 자동 실행한다. |
| FR-14 | `main` merge 후 GitHub Actions에서 OIDC 기반 AWS 배포가 가능해야 한다. |

## 2.2 Non-Functional Requirements

- Webhook handler는 외부 Instagram API를 직접 호출하지 않는다.
- Worker는 재실행될 수 있다고 가정한다.
- 모든 외부 이벤트는 idempotency key를 갖는다.
- 메시지 중복 발송을 방지한다.
- 장애 이벤트를 DLQ에서 추적할 수 있어야 한다.
- AWS Console 수동 설정을 최소화한다.
- 개발 환경과 운영 환경은 분리할 수 있어야 한다.
- 개인정보는 최소한만 저장한다.

---

# 3. 최종 아키텍처

```text
                              ┌───────────────────────────────┐
                              │ Instagram Professional       │
                              │ Account                      │
                              └───────────────┬───────────────┘
                                              │
                                  comments / messages webhook
                                              │
                                              ▼
                                   ┌────────────────────┐
                                   │ API Gateway HTTP API│
                                   └──────────┬─────────┘
                                              │
                                              ▼
                                   ┌────────────────────┐
                                   │ Webhook Lambda      │
                                   │                    │
                                   │ verify             │
                                   │ validate           │
                                   │ normalize          │
                                   │ enqueue             │
                                   └──────────┬─────────┘
                                              │
                                              ▼
                                   ┌────────────────────┐
                                   │ SQS Standard Queue  │
                                   │ instagram-events    │
                                   └──────────┬─────────┘
                                              │
                                   event source mapping
                                              │
                                              ▼
                                   ┌────────────────────┐
                                   │ Worker Lambda       │
                                   │                    │
                                   │ idempotency        │
                                   │ state transition   │
                                   │ Instagram API      │
                                   │ outbound message   │
                                   └──────┬───────┬─────┘
                                          │       │
                                          │       ▼
                                          │  ┌────────────────────┐
                                          │  │ Instagram Graph API│
                                          │  │ Private Reply      │
                                          │  │ Send Message       │
                                          │  └────────────────────┘
                                          │
                                          ▼
                                   ┌────────────────────┐
                                   │ DynamoDB            │
                                   │                    │
                                   │ event idempotency  │
                                   │ conversation state │
                                   └────────────────────┘

                         반복 실패
                            │
                            ▼
                     ┌──────────────────┐
                     │ SQS DLQ          │
                     └──────────────────┘

 Secrets Manager ───────────────► Worker Lambda
 CloudWatch Logs/Metrics ──────► 관측성
 GitHub Actions ──OIDC─────────► AWS Deploy Role
```

---

# 4. 서비스 선택 근거

| 컴포넌트 | 선택 | 선택 이유 |
|---|---|---|
| API Gateway | HTTP API | 단순 webhook endpoint이며 REST API의 추가 기능이 불필요 |
| Webhook Lambda | Lambda | 짧은 검증/큐잉 작업, 상시 서버 불필요 |
| SQS | Standard | retry/backpressure/DLQ가 핵심이며 전체 시스템에 강한 순서 보장이 필수는 아님 |
| Worker Lambda | Lambda | 이벤트 기반 외부 API 호출, idle cost 최소화 |
| DynamoDB | On-Demand | 상태/멱등성 저장에 적합, 소규모/가변 트래픽 |
| DLQ | SQS | 반복 실패 이벤트 보존 |
| Secrets Manager | Secrets Manager | access token 및 app secret 보호 |
| CloudWatch | CloudWatch | 로그/metric/alarm |
| GitHub | GitHub | 코드/설계/IaC/CI 형상관리 |
| AWS SAM | SAM | Lambda 중심 서버리스 리소스 정의가 단순 |
| EventBridge | 초기 제외 | 현재는 단일 pipeline이라 필요 이상으로 복잡해짐 |
| Kinesis | 제외 | stream processing 수준의 처리량/다중 consumer 요구가 없음 |
| Step Functions | 초기 제외 | 현재 상태 전이는 짧고 DynamoDB + Lambda로 충분 |
| ECS/EC2 | 제외 | webhook 기반 이벤트 처리에 상시 서버 불필요 |

---

# 5. Meta / Instagram API 설계

## 5.1 계정 요구사항

Instagram 자동화 대상은 Professional 계정(Business/Creator)을 전제로 한다.

Instagram API with Instagram Login에서 관련 권한은 다음과 같다.

```text
instagram_business_basic
instagram_business_manage_comments
instagram_business_manage_messages
```

Meta 공식 Instagram API 컬렉션은 Professional 계정의 댓글 webhook과 메시징 기능을 제공한다.

## 5.2 댓글 webhook

댓글 이벤트에는 최소한 다음과 같은 정보가 들어올 수 있다.

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "<APP_USER_IG_ID>",
      "time": 1760000000000,
      "field": "comments",
      "value": {
        "id": "<COMMENT_ID>",
        "from": {
          "username": "example"
        },
        "text": "참여",
        "media": {
          "id": "<MEDIA_ID>",
          "media_product_type": "FEED"
        }
      }
    }
  ]
}
```

Meta 공식 payload reference: [Comment webhook](https://www.postman.com/meta/instagram/request/23987686-db99ce99-bf76-475c-8b76-718576c11cae).

## 5.3 Private Reply

댓글 작성자에게 첫 메시지를 보내는 API:

```http
POST https://graph.instagram.com/{api-version}/{ig-user-id}/messages
Authorization: Bearer {INSTAGRAM_ACCESS_TOKEN}
Content-Type: application/json

{
  "recipient": {
    "comment_id": "{COMMENT_ID}"
  },
  "message": {
    "text": "팔로워인지 확인할게요! 아무 메시지나 보내주세요 💬"
  }
}
```

Meta 공식 문서에서 확인되는 제약은 다음과 같다.

- 댓글당 Private Reply 1회
- 게시물/Reel 댓글은 생성 후 7일 이내
- Live는 방송 중에만 Private Reply 가능
- 후속 메시지는 상대방이 응답한 뒤에만 가능
- 상대방 응답 후 24시간 이내 follow-up 필요

따라서 Worker는 `COMMENT_RECEIVED -> PRIVATE_REPLY_SENT -> WAITING_USER_MESSAGE` 상태를 저장한다.

## 5.4 후속 메시지

사용자가 DM을 보내면 `messages` webhook으로 수신한다.

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "<APP_USER_IG_ID>",
      "time": 1760000000000,
      "messaging": [
        {
          "sender": {
            "id": "<USER_IG_SCOPED_ID>"
          },
          "recipient": {
            "id": "<APP_USER_IG_ID>"
          },
          "timestamp": 1760000000000,
          "message": {
            "mid": "<MESSAGE_ID>",
            "text": "네"
          }
        }
      ]
    }
  ]
}
```

사용자 응답 후 Worker는 다음 메시지를 발송한다.

```text
❤️사전예약 양식❤️
성함 :
생년월일 :
연락처 :
통신사 :
희망기종 :
거주지역 :
위 양식 작성해주시면 업무 조회 후 상담도와드리겠습니다😃
```

일반 메시지 요청은 recipient의 Instagram-scoped ID를 사용한다.

```http
POST https://graph.instagram.com/{api-version}/{ig-user-id}/messages
Authorization: Bearer {INSTAGRAM_ACCESS_TOKEN}
Content-Type: application/json

{
  "recipient": {
    "id": "{IGSCID}"
  },
  "message": {
    "text": "❤️사전예약 양식❤️\n성함 :\n생년월일 :\n연락처 :\n통신사 :\n희망기종 :\n거주지역 :\n위 양식 작성해주시면 업무 조회 후 상담도와드리겠습니다😃"
  }
}
```

## 5.5 팔로워 여부

본 시스템에서는 다음과 같은 미지원 가정을 두지 않는다.

```ts
// 사용하지 않음
await instagram.isFollower(userId);
```

Meta 공식 문서상 Private Reply의 전달 위치는 팔로워 여부에 따라 Inbox/Request로 달라질 수 있지만, 그것이 앱에 `isFollower` boolean을 제공하는 일반 API endpoint를 의미하는 것은 아니다.

따라서 **팔로워 여부 자체를 API로 판별하는 로직을 시스템의 필수 전제로 삼지 않는다.** 현재 사용자 플로우에서는 댓글 -> Private Reply -> 사용자 DM 응답 -> 후속 DM으로 처리한다.

---

# 6. 상태 머신

```text
                     ┌──────────────────────┐
                     │ COMMENT_RECEIVED      │
                     └──────────┬───────────┘
                                │
                         Private Reply
                                │
                                ▼
                     ┌──────────────────────┐
                     │ PRIVATE_REPLY_SENT   │
                     └──────────┬───────────┘
                                │
                       wait for user DM
                                │
                                ▼
                     ┌──────────────────────┐
                     │ WAITING_USER_MESSAGE  │
                     └──────────┬───────────┘
                                │
                         message webhook
                                │
                                ▼
                     ┌──────────────────────┐
                     │ USER_REPLIED         │
                     └──────────┬───────────┘
                                │
                         send follow-up
                                │
                                ▼
                     ┌──────────────────────┐
                     │ FORM_SENT            │
                     └──────────┬───────────┘
                                │
                         optional: form parse
                                │
                                ▼
                     ┌──────────────────────┐
                     │ COMPLETED            │
                     └──────────────────────┘
```

## 6.1 상태 전이 규칙

| 현재 상태 | 이벤트 | 다음 상태 |
|---|---|---|
| 없음 | comment webhook | PRIVATE_REPLY_PENDING |
| PRIVATE_REPLY_PENDING | send success | WAITING_USER_MESSAGE |
| WAITING_USER_MESSAGE | user message | USER_REPLIED |
| USER_REPLIED | follow-up send success | FORM_SENT |
| FORM_SENT | form data | COMPLETED |
| 어느 상태 | duplicated event | 상태 변경 없음 |
| 어느 상태 | transient Instagram error | SQS retry |
| 어느 상태 | permanent error | DLQ/FAILED |

---

# 7. DynamoDB 설계

## 7.1 Table

Table name:

```text
instagram-auto-dm-${Environment}
```

Partition key:

```text
pk: S
```

예:

```text
USER#17841234567890
EVENT#comment_12345
EVENT#mid_12345
```

## 7.2 Item 유형

### 사용자 상태

```json
{
  "pk": "USER#17841234567890",
  "entityType": "CONVERSATION",
  "state": "WAITING_USER_MESSAGE",
  "lastCommentId": "18000123456789000",
  "privateReplyMessageId": "mid.private.123",
  "lastInboundMessageId": "mid.in.123",
  "updatedAt": "2026-08-24T21:00:00.000Z",
  "expiresAt": 1798190000
}
```

### 이벤트 멱등성 item

```json
{
  "pk": "EVENT#comment_12345",
  "entityType": "IDEMPOTENCY",
  "status": "COMPLETED",
  "processedAt": "2026-08-24T21:00:00.000Z",
  "expiresAt": 1798190000
}
```

## 7.3 TTL

이벤트/상태가 영구 보관될 필요가 없다면 `expiresAt` TTL을 사용한다.

단, 고객 상담/예약 정보와 같이 실제 업무 데이터가 되면 별도의 개인정보 보존 정책을 적용해야 한다. DynamoDB TTL은 즉시 삭제를 보장하는 기능이 아니므로 법적 보존 정책의 대체 수단으로 사용하지 않는다.

---

# 8. SQS 설계

## 8.1 Queue

```text
instagram-auto-dm-events-${Environment}
```

### 메시지

```json
{
  "eventId": "comment:18000123456789000",
  "eventType": "COMMENT",
  "receivedAt": "2026-08-24T21:00:00.000Z",
  "payload": {
    "igUserId": "17840000000000",
    "commentId": "18000123456789000",
    "instagramScopedUserId": "17850000000000",
    "username": "example",
    "text": "참여",
    "mediaId": "17990000000000"
  }
}
```

## 8.2 Standard SQS 선택 이유

현재 서비스에서 전역적인 strict ordering은 필요하지 않다.

대신 Worker가 DynamoDB를 이용해:

- 현재 conversation state 확인
- 중복 이벤트 확인
- 발송 여부 확인
- 잘못된 상태의 이벤트 무시

를 수행한다.

향후 사용자별 순서가 엄격하게 필요해질 경우 SQS FIFO + `MessageGroupId=instagramScopedUserId`를 검토한다.

## 8.3 Visibility Timeout

SQS visibility timeout은 Worker Lambda timeout보다 충분히 길게 잡는다. AWS Lambda의 SQS event source mapping에서는 일반적으로 queue visibility timeout을 함수 timeout의 최소 6배 수준으로 구성하는 것이 권장된다.

예:

```text
Worker Lambda timeout: 30s
SQS visibility timeout: 180s 이상
```

## 8.4 DLQ

```text
instagram-auto-dm-events-dlq-${Environment}
```

`maxReceiveCount`는 초기값 5를 사용한다.

```text
process
  -> fail
  -> retry
  -> fail
  -> retry
  -> fail
  -> retry
  -> fail
  -> retry
  -> fail
  -> DLQ
```

---

# 9. Lambda 설계

## 9.1 Webhook Lambda 책임

Webhook Lambda에서는 다음만 수행한다.

1. GET verification 처리
2. POST signature 검증
3. webhook payload validation
4. event normalization
5. SQS enqueue
6. 2xx response

**Instagram API 메시지 발송은 하지 않는다.**

## 9.2 Worker Lambda 책임

1. SQS event batch 처리
2. 이벤트 멱등성 확인
3. conversation state 조회
4. 이벤트 유형별 비즈니스 로직 수행
5. Instagram API 호출
6. DynamoDB 상태 갱신
7. 실패 시 throw하여 SQS retry 유도

---

# 10. TypeScript 프로젝트 구조

```text
instagram-auto-dm/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
│
├── docs/
│   └── instagram-auto-dm-design.md
│
├── src/
│   ├── webhook/
│   │   ├── handler.ts
│   │   ├── verify.ts
│   │   └── normalize.ts
│   │
│   ├── worker/
│   │   ├── handler.ts
│   │   ├── comment.ts
│   │   └── message.ts
│   │
│   ├── instagram/
│   │   ├── client.ts
│   │   └── types.ts
│   │
│   ├── repository/
│   │   └── conversation-repository.ts
│   │
│   ├── queue/
│   │   └── producer.ts
│   │
│   ├── config/
│   │   └── secrets.ts
│   │
│   └── types/
│       └── events.ts
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── infrastructure/
│   └── template.yaml
│
├── scripts/
│   ├── package.sh
│   └── smoke-test.sh
│
├── package.json
├── package-lock.json
├── tsconfig.json
├── eslint.config.js
├── README.md
├── .env.example
├── .gitignore
└── samconfig.toml.example
```

---

# 11. 고정 메시지 관리

메시지는 코드 내부 상수로 시작하되 추후 관리 화면/DB 설정으로 이동 가능하게 한다.

```ts
export const PRIVATE_REPLY_TEXT =
  "팔로워인지 확인할게요! 아무 메시지나 보내주세요 💬";

export const RESERVATION_FORM_TEXT =
  "❤️사전예약 양식❤️\n" +
  "성함 :\n" +
  "생년월일 :\n" +
  "연락처 :\n" +
  "통신사 :\n" +
  "희망기종 :\n" +
  "거주지역 :\n" +
  "위 양식 작성해주시면 업무 조회 후 상담도와드리겠습니다😃";
```

문구는 계정/캠페인별로 달라질 가능성이 있으므로 도메인 코드와 분리한다.

---

# 12. Instagram Client

```ts
const GRAPH_HOST = "https://graph.instagram.com";

export interface InstagramClientOptions {
  apiVersion: string;
  igUserId: string;
  accessToken: string;
}

export class InstagramClient {
  constructor(private readonly options: InstagramClientOptions) {}

  private get endpoint() {
    return `${GRAPH_HOST}/${this.options.apiVersion}/${this.options.igUserId}/messages`;
  }

  async sendPrivateReply(commentId: string, text: string) {
    return this.post({
      recipient: { comment_id: commentId },
      message: { text },
    });
  }

  async sendMessage(recipientId: string, text: string) {
    return this.post({
      recipient: { id: recipientId },
      message: { text },
    });
  }

  private async post(body: unknown) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new InstagramApiError(response.status, bodyText);
    }

    return response.json() as Promise<{
      recipient_id?: string;
      message_id?: string;
    }>;
  }
}

export class InstagramApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`Instagram API error: ${status}`);
  }

  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}
```

---

# 13. Webhook Lambda

## 13.1 GET verification

Meta webhook verification 시 query parameter를 검증한다.

```ts
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

const ok = (body = "OK"): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 200,
  body,
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const query = event.queryStringParameters ?? {};

  if (query["hub.mode"] !== "subscribe") {
    return { statusCode: 400, body: "invalid mode" };
  }

  const expected = process.env.WEBHOOK_VERIFY_TOKEN;
  if (!expected || query["hub.verify_token"] !== expected) {
    return { statusCode: 403, body: "forbidden" };
  }

  return ok(query["hub.challenge"] ?? "");
};
```

## 13.2 POST signature 검증

Webhook endpoint가 인터넷에 노출되므로 요청 body의 진위를 검증한다.

Meta webhook payload에는 signature header가 사용될 수 있으므로 HMAC 검증 구현을 별도 모듈로 둔다.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const received = signatureHeader.slice("sha256=".length);

  if (expected.length !== received.length) return false;

  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(received, "utf8"),
  );
}
```

## 13.3 SQS enqueue

```ts
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

export async function enqueueEvent(event: unknown) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.EVENT_QUEUE_URL,
      MessageBody: JSON.stringify(event),
    }),
  );
}
```

Webhook Lambda는 enqueue 성공 후 즉시 200을 반환한다.

---

# 14. 이벤트 normalize

Webhook payload을 worker가 직접 해석하게 만들지 말고 내부 이벤트 모델로 정규화한다.

```ts
export type BotEvent =
  | {
      eventId: string;
      eventType: "COMMENT";
      payload: {
        igUserId: string;
        commentId: string;
        instagramScopedUserId: string;
        username?: string;
        text?: string;
        mediaId?: string;
      };
    }
  | {
      eventId: string;
      eventType: "MESSAGE";
      payload: {
        igUserId: string;
        messageId: string;
        instagramScopedUserId: string;
        text?: string;
      };
    };
```

### eventId 규칙

```text
COMMENT:{commentId}
MESSAGE:{messageId}
```

이벤트의 외부 고유 ID를 idempotency key로 사용한다.

---

# 15. Worker Lambda

## 15.1 SQS partial batch response

한 batch 중 특정 메시지만 실패했을 때 전체 batch를 다시 처리하지 않기 위해 partial batch response를 사용한다.

```ts
import type { SQSEvent, SQSBatchResponse } from "aws-lambda";

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const botEvent = JSON.parse(record.body);
      await processBotEvent(botEvent);
    } catch (error) {
      console.error("worker failed", {
        messageId: record.messageId,
        error,
      });

      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return {
    batchItemFailures: failures,
  };
}
```

SAM/Lambda Event Source Mapping에서 `FunctionResponseTypes: [ReportBatchItemFailures]`를 활성화한다.

## 15.2 공통 처리

```ts
async function processBotEvent(event: BotEvent) {
  const acquired = await repository.tryAcquireEvent(event.eventId);

  if (!acquired) {
    console.info("duplicate event ignored", event.eventId);
    return;
  }

  switch (event.eventType) {
    case "COMMENT":
      await handleComment(event);
      break;

    case "MESSAGE":
      await handleMessage(event);
      break;
  }

  await repository.markEventCompleted(event.eventId);
}
```

주의: `markEventCompleted` 전에 외부 API가 성공했는지 반드시 확인한다.

---

# 16. 댓글 처리

```ts
async function handleComment(event: Extract<BotEvent, { eventType: "COMMENT" }>) {
  const {
    igUserId,
    commentId,
    instagramScopedUserId,
  } = event.payload;

  const conversation = await repository.getConversation(
    instagramScopedUserId,
  );

  // 이미 Private Reply를 보낸 댓글이면 재발송하지 않는다.
  if (conversation?.lastPrivateReplyCommentId === commentId) {
    return;
  }

  const result = await instagram.sendPrivateReply(
    commentId,
    PRIVATE_REPLY_TEXT,
  );

  await repository.markWaitingForUserMessage({
    instagramScopedUserId,
    commentId,
    privateReplyMessageId: result.message_id,
  });
}
```

## 16.1 댓글 텍스트 필터

선택적으로 특정 keyword만 자동화할 수 있다.

예:

```ts
const TRIGGER_KEYWORDS = ["참여", "예약", "자료"];

function shouldTrigger(text?: string) {
  if (!text) return false;
  return TRIGGER_KEYWORDS.some((keyword) =>
    text.toLowerCase().includes(keyword.toLowerCase()),
  );
}
```

MVP에서는 모든 댓글을 트리거할지, `예약` 등 특정 키워드만 처리할지 운영 정책으로 결정한다.

---

# 17. 메시지 처리

```ts
async function handleMessage(
  event: Extract<BotEvent, { eventType: "MESSAGE" }>,
) {
  const { instagramScopedUserId, messageId } = event.payload;

  const conversation = await repository.getConversation(
    instagramScopedUserId,
  );

  if (!conversation) {
    console.info("message without known conversation", {
      instagramScopedUserId,
      messageId,
    });
    return;
  }

  if (conversation.lastInboundMessageId === messageId) {
    return;
  }

  if (conversation.state !== "WAITING_USER_MESSAGE") {
    return;
  }

  await repository.markUserReplied({
    instagramScopedUserId,
    messageId,
  });

  await instagram.sendMessage(
    instagramScopedUserId,
    RESERVATION_FORM_TEXT,
  );

  await repository.markFormSent(instagramScopedUserId);
}
```

중요: 사용자 메시지를 받았다고 해서 임의로 follower boolean을 조회하지 않는다. **이 플로우에서는 사용자가 응답한 사실을 후속 메시지 발송 조건으로 사용한다.**

---

# 18. Idempotency 설계

외부 webhook은 중복 전달될 수 있다는 전제로 설계한다.

## 18.1 문제 상황

```text
COMMENT:123
    ↓
Private Reply 전송 성공

COMMENT:123  (중복 webhook)
    ↓
Private Reply 재전송 시도
```

댓글당 Private Reply가 1회라는 제약이 있으므로 중복 처리는 치명적이다.

## 18.2 해결책

DynamoDB conditional write를 이용한다.

```ts
await ddb.send(
  new PutCommand({
    TableName: tableName,
    Item: {
      pk: `EVENT#${eventId}`,
      status: "PROCESSING",
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }),
);
```

`ConditionalCheckFailedException`이면 중복 이벤트로 보고 무시한다.

---

# 19. 멱등성 처리의 한계와 개선

`PROCESSING` item을 쓰고 Lambda가 죽으면 영구적으로 처리된 것으로 보이는 문제가 생길 수 있다.

따라서 실제 구현에서는 다음 중 하나를 선택한다.

### Option A — lease

```text
status=PROCESSING
leaseUntil=<timestamp>
```

lease 만료 후 다른 worker가 재획득할 수 있게 한다.

### Option B — 상태별 idempotency key

메시지 발송 단위를 별도로 저장한다.

```text
SEND_PRIVATE_REPLY#<commentId>
SEND_FORM#<messageId>
```

권장 MVP는 **Option B + 대화 state**다.

---

# 20. Retry 정책

## 20.1 retryable

다음은 일반적으로 일시적 장애로 보고 SQS retry를 허용한다.

```text
429 Too Many Requests
5xx Instagram API
네트워크 오류
AWS SDK transient error
```

## 20.2 non-retryable

다음과 같은 잘못된 요청은 반복해도 성공하지 않을 가능성이 높으므로 코드 레벨에서 분류한다.

```text
400 malformed request
401/403 invalid token or permission issue
정책상 전송 불가
만료된 Private Reply window
잘못된 comment_id
```

다만 실제 Meta error code를 확인한 후 `retryable` 분류 테이블을 운영 환경에서 보정한다.

---

# 21. 개인정보 / 사전예약 데이터

두 번째 메시지는 이름, 생년월일, 전화번호, 통신사, 거주지역 등 개인정보를 요청한다.

중요 원칙:

1. 현재 MVP에서는 **양식 텍스트 자체를 장기 저장하지 않는다.**
2. Instagram user ID 등 필요한 최소 식별자만 저장한다.
3. CloudWatch log에 이름/전화번호/생년월일 등의 원문을 남기지 않는다.
4. 향후 양식 파싱/저장 기능을 추가하면 개인정보 보존기간과 접근통제를 별도로 설계한다.
5. 운영 목적상 실제 예약 데이터를 저장한다면 DynamoDB item을 별도의 개인정보 데이터 모델로 분리한다.
6. 앱 로그에서 `message.text`를 그대로 출력하지 않는다.

예:

```ts
console.info("message received", {
  instagramScopedUserId,
  messageId,
  // text는 로그에 저장하지 않음
});
```

이 시스템은 단순 마케팅 자동화가 아니라 개인정보 처리 시스템이 될 수 있으므로, 실제 운영 전 개인정보 처리방침/보존 정책/접근 권한을 별도로 검토한다.

---

# 22. Secrets Manager

Secret 예시:

```json
{
  "INSTAGRAM_ACCESS_TOKEN": "...",
  "INSTAGRAM_APP_SECRET": "...",
  "WEBHOOK_VERIFY_TOKEN": "...",
  "INSTAGRAM_ACCOUNT_ID": "..."
}
```

Secret 이름:

```text
instagram-auto-dm/${Environment}/credentials
```

Lambda 환경변수에는 secret 자체가 아니라 secret ARN/name을 넣는다.

```text
INSTAGRAM_SECRET_ID=instagram-auto-dm/prod/credentials
```

---

# 23. IAM

## 23.1 Webhook Lambda

최소 권한:

```text
sqs:SendMessage
```

대상은 특정 queue ARN으로 제한한다.

## 23.2 Worker Lambda

```text
sqs:ReceiveMessage
sqs:DeleteMessage
sqs:GetQueueAttributes

secretsmanager:GetSecretValue

dynamodb:GetItem
 dynamodb:PutItem
 dynamodb:UpdateItem
 dynamodb:ConditionCheckItem
```

실제 배포에서는 리소스 ARN을 구체적으로 제한한다.

## 23.3 GitHub Actions

GitHub OIDC provider를 사용한다.

```text
GitHub Actions
    ↓ OIDC token
AWS IAM Role
    ↓
SAM deploy
```

장기 AWS Access Key를 GitHub Secrets에 저장하지 않는다.

---

# 24. AWS SAM

## 24.1 template.yaml 개략

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Parameters:
  Environment:
    Type: String
    AllowedValues:
      - dev
      - prod

Resources:
  EventDlq:
    Type: AWS::SQS::Queue

  EventQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 180
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt EventDlq.Arn
        maxReceiveCount: 5

  EventTable:
    Type: AWS::DynamoDB::Table
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
      TimeToLiveSpecification:
        AttributeName: expiresAt
        Enabled: true

  HttpApi:
    Type: AWS::Serverless::HttpApi

  WebhookFunction:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs24.x
      Handler: src/webhook/handler.handler
      Timeout: 10
      MemorySize: 256
      Events:
        Webhook:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /instagram/webhook
            Method: ANY
      Policies:
        - SQSSendMessagePolicy:
            QueueName: !GetAtt EventQueue.QueueName

  WorkerFunction:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs24.x
      Handler: src/worker/handler.handler
      Timeout: 30
      MemorySize: 512
      Environment:
        Variables:
          EVENT_TABLE_NAME: !Ref EventTable
          INSTAGRAM_SECRET_ID: instagram-auto-dm/prod/credentials
      Policies:
        - SQSPollerPolicy:
            QueueName: !GetAtt EventQueue.QueueName
        - DynamoDBCrudPolicy:
            TableName: !Ref EventTable
        - Statement:
            - Effect: Allow
              Action:
                - secretsmanager:GetSecretValue
              Resource: arn:aws:secretsmanager:ap-northeast-2:*:secret:instagram-auto-dm/*
      Events:
        Queue:
          Type: SQS
          Properties:
            Queue: !GetAtt EventQueue.Arn
            BatchSize: 10
            FunctionResponseTypes:
              - ReportBatchItemFailures

Outputs:
  HttpApiUrl:
    Value: !Sub https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com
  EventQueueUrl:
    Value: !Ref EventQueue
  EventTableName:
    Value: !Ref EventTable
```

> 실제 production template에서는 API Gateway route, secret ARN, environment mapping, IAM resource restriction 등을 환경별 parameter와 stack output으로 엄격히 정리한다.

---

# 25. AWS CLI 기반 초기 작업

SAM을 최종 source of truth로 두되, 아래 CLI는 계정 준비/검증/운영 작업에 사용한다.

## 25.1 AWS CLI 로그인 확인

```bash
aws sts get-caller-identity
aws configure get region
```

서울 리전 설정 예:

```bash
aws configure set region ap-northeast-2
```

## 25.2 SQS queue 확인

```bash
aws sqs list-queues
```

## 25.3 Secret 생성

```bash
aws secretsmanager create-secret \
  --name instagram-auto-dm/prod/credentials \
  --secret-string '{
    "INSTAGRAM_ACCESS_TOKEN":"REDACTED",
    "INSTAGRAM_APP_SECRET":"REDACTED",
    "WEBHOOK_VERIFY_TOKEN":"REDACTED",
    "INSTAGRAM_ACCOUNT_ID":"REDACTED"
  }'
```

실제 secret 값은 shell history에 남길 위험이 있으므로 운영에서는 CLI history 노출에도 주의한다. 자동화 환경에서는 GitHub Actions OIDC와 별도 secret injection 전략을 사용한다.

## 25.4 SAM build

```bash
sam build
```

## 25.5 첫 배포

```bash
sam deploy --guided
```

프로덕션에서는 `samconfig.toml`을 환경별로 명시한다.

```bash
sam deploy \
  --stack-name instagram-auto-dm-prod \
  --region ap-northeast-2 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides Environment=prod
```

## 25.6 CloudFormation stack 확인

```bash
aws cloudformation describe-stacks \
  --stack-name instagram-auto-dm-prod
```

## 25.7 Lambda 확인

```bash
aws lambda list-functions \
  --region ap-northeast-2
```

## 25.8 SQS 상태 확인

```bash
aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names All
```

## 25.9 DLQ 확인

```bash
aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages
```

---

# 26. Meta Webhook 등록 절차

1. Meta Developer App 생성
2. Instagram Professional 계정 연결
3. 필요한 Instagram permissions 설정
4. Webhook callback URL 등록
5. Verification token 설정
6. `comments`, `messages`, 필요 시 `messaging_postbacks` 구독
7. 테스트 이벤트 수신
8. 실제 댓글 → Private Reply → DM 응답 → follow-up 테스트

Webhook URL 예:

```text
https://{api-id}.execute-api.ap-northeast-2.amazonaws.com/instagram/webhook
```

운영 환경에서는 custom domain을 사용할 수 있다.

---

# 27. 테스트 전략

## 27.1 Unit Test

대상:

```text
normalizeCommentEvent()
normalizeMessageEvent()
shouldTrigger()
verifySignature()
state transition
retry classification
```

## 27.2 Integration Test

```text
Webhook Lambda
  ↓
SQS
  ↓
Worker Lambda
  ↓
DynamoDB Local / AWS test table
```

Instagram API는 mocking한다.

## 27.3 E2E

실제 테스트 Instagram Professional 계정을 사용한다.

### Test Case 01 — 정상 댓글

```text
댓글 작성
→ comments webhook
→ queue
→ worker
→ Private Reply
```

Expected:

```text
팔로워인지 확인할게요! 아무 메시지나 보내주세요 💬
```

### Test Case 02 — 사용자 응답

```text
사용자 DM: "네"
→ messages webhook
→ queue
→ worker
→ sendMessage
```

Expected:

```text
❤️사전예약 양식❤️
성함 :
생년월일 :
연락처 :
통신사 :
희망기종 :
거주지역 :
위 양식 작성해주시면 업무 조회 후 상담도와드리겠습니다😃
```

### Test Case 03 — 동일 comment 중복

Expected:

```text
Private Reply 1회만 전송
```

### Test Case 04 — 동일 message 중복

Expected:

```text
사전예약 양식 1회만 전송
```

### Test Case 05 — Instagram 429

Expected:

```text
Worker 실패
→ SQS retry
→ 반복 실패 시 DLQ
```

### Test Case 06 — Instagram 400

Expected:

```text
retry 정책상 non-retryable 처리
```

### Test Case 07 — DLQ

의도적으로 Worker가 실패하도록 만들어 DLQ 이동을 확인한다.

---

# 28. Observability

## 28.1 CloudWatch Logs

로그에는 다음 정도만 남긴다.

```json
{
  "level": "INFO",
  "event": "message_processed",
  "messageId": "mid.123",
  "instagramUserIdHash": "sha256:...",
  "state": "FORM_SENT"
}
```

이름/전화번호/생년월일/양식 원문은 로그에 남기지 않는다.

## 28.2 Metrics

권장 metric:

```text
WebhookReceived
QueueEnqueued
WorkerSuccess
WorkerFailure
PrivateReplySuccess
PrivateReplyFailure
FollowUpSuccess
FollowUpFailure
DLQMessages
Instagram429
Instagram5xx
```

## 28.3 Alarm

최소 다음을 알람화한다.

```text
DLQ > 0
Worker error rate 증가
SQS ApproximateAgeOfOldestMessage 증가
Instagram 429 증가
```

---

# 29. 형상관리

## 29.1 GitHub Repository

Repository 예:

```text
instagram-auto-dm
```

저장 대상:

```text
src/
tests/
infrastructure/
docs/
scripts/
.github/
package.json
package-lock.json
README.md
.env.example
```

저장하지 않는 대상:

```text
.env
실제 access token
App secret
Webhook secret
AWS access key
배포용 개인 credential
```

## 29.2 Branch 전략

개인 프로젝트에서는 다음 정도가 충분하다.

```text
main
  ├── feature/webhook
  ├── feature/sqs-worker
  ├── feature/instagram-client
  ├── feature/dynamodb-state
  └── chore/ci
```

`main`은 항상 배포 가능한 상태를 유지한다.

## 29.3 Commit 규칙

Conventional Commits를 권장한다.

```text
feat: add instagram comment webhook
feat: add private reply worker
feat: add follow-up reservation message
feat: add dynamodb idempotency
fix: prevent duplicate private replies
chore: configure github oidc deploy

test: add webhook signature tests
docs: update deployment guide
```

## 29.4 PR 정책

PR merge 조건:

```text
lint        ✅
typecheck   ✅
unit test   ✅
build       ✅
```

---

# 30. GitHub Actions

## 30.1 CI

```yaml
name: CI

on:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

## 30.2 Deploy

GitHub OIDC를 이용하여 AWS IAM Role을 Assume한다.

```yaml
name: Deploy

on:
  push:
    branches:
      - main

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - run: npm ci
      - run: npm test
      - run: npm run build

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-northeast-2

      - run: sam build
      - run: |
          sam deploy \
            --stack-name instagram-auto-dm-prod \
            --region ap-northeast-2 \
            --capabilities CAPABILITY_IAM \
            --no-confirm-changeset \
            --no-fail-on-empty-changeset \
            --resolve-s3 \
            --parameter-overrides Environment=prod
```

> `AWS_DEPLOY_ROLE_ARN` 자체는 secret로 보관하거나 repository/environment variable 정책에 맞게 관리한다. 장기 AWS access key는 사용하지 않는다.

---

# 31. Environment 분리

```text
AWS Account
├── dev stack
│   ├── instagram-auto-dm-dev
│   ├── SQS dev
│   └── DynamoDB dev
│
└── prod stack
    ├── instagram-auto-dm-prod
    ├── SQS prod
    └── DynamoDB prod
```

Instagram 실제 계정이 하나뿐이라면 초기에는 `dev`에서 별도의 테스트 Professional 계정을 사용하고, production 계정은 `prod`에서만 연결한다.

---

# 32. 보안 설계

## 32.1 금지

```text
❌ Instagram access token Git commit
❌ .env commit
❌ AdministratorAccess를 Lambda에 부여
❌ GitHub Actions AWS access key
❌ webhook body 전체를 무제한 로그 출력
❌ 사용자 개인정보를 CloudWatch에 출력
```

## 32.2 필수

```text
✅ Secrets Manager
✅ IAM Least Privilege
✅ OIDC
✅ webhook signature validation
✅ idempotency
✅ SQS DLQ
✅ 개인정보 로그 마스킹
```

---

# 33. AWS CLI + SAM 운영 명령

## 최근 Lambda 로그

```bash
aws logs tail "/aws/lambda/instagram-auto-dm-prod-WorkerFunction" \
  --follow \
  --region ap-northeast-2
```

## Lambda 최근 설정

```bash
aws lambda get-function-configuration \
  --function-name instagram-auto-dm-prod-WorkerFunction \
  --region ap-northeast-2
```

## Queue URL

```bash
aws sqs get-queue-url \
  --queue-name instagram-auto-dm-events-prod \
  --region ap-northeast-2
```

## DLQ 메시지 확인

운영 중 DLQ 메시지 샘플은 민감정보가 포함될 수 있으므로 반드시 마스킹하여 확인한다.

```bash
aws sqs receive-message \
  --queue-url "$DLQ_URL" \
  --max-number-of-messages 1 \
  --region ap-northeast-2
```

---

# 34. 배포 파이프라인

```text
Developer
   │
   ├── feature branch
   │
   ▼
GitHub PR
   │
   ▼
CI
 ├─ lint
 ├─ typecheck
 ├─ unit test
 └─ build
   │
   ▼
merge main
   │
   ▼
GitHub Actions
   │
   ▼
OIDC
   │
   ▼
AWS IAM Deploy Role
   │
   ▼
SAM build/deploy
   │
   ▼
CloudFormation
   │
   ├─ API Gateway
   ├─ Lambda
   ├─ SQS/DLQ
   └─ DynamoDB
```

---

# 35. 운영상 중요한 실패 시나리오

## 35.1 Private Reply 성공 후 DynamoDB 저장 실패

```text
Instagram API 성공
      ↓
DynamoDB 실패
      ↓
SQS retry
      ↓
중복 Private Reply 위험
```

따라서 `send -> persist`만으로 완전한 exactly-once를 만들 수 없다.

대응책:

- 외부 API 발송 단위를 idempotency key로 모델링
- 발송 성공 응답의 `message_id` 저장
- 동일 comment의 Private Reply가 이미 성공했는지 상태로 확인
- 재처리 시 먼저 상태를 검사

Instagram API 자체가 같은 Private Reply를 중복으로 받아주지 않을 수 있으므로, **외부 부작용을 완벽히 exactly-once로 만드는 것이 아니라 시스템 내부에서 중복 발송 시도를 최소화하는 설계**로 간주한다.

## 35.2 사용자 응답 후 Worker 장애

```text
message webhook
 ↓
SQS
 ↓
Worker
 ↓
Instagram follow-up
 ↓
DynamoDB update 실패
```

다시 처리할 때 `messageId` 기반 상태 및 `FORM_SENT` 상태를 이용해 동일 양식을 재발송하지 않도록 한다.

---

# 36. 메시지 상태와 타이밍

댓글 Private Reply와 후속 DM은 서로 다른 시간 조건을 가진다.

```text
T0 = comment received
T0 ~ T0+7d
└── Private Reply 가능

사용자 응답 = T1
T1 ~ T1+24h
└── Follow-up 메시지 가능
```

Worker가 오래된 이벤트를 실행하기 전에 `receivedAt`, `message timestamp`, 현재 시간을 비교하여 발송 가능 여부를 검사하는 것을 권장한다.

---

# 37. MVP 구현 순서

## Phase 1 — Meta PoC

```text
[ ] Professional 계정 확인
[ ] Meta App 생성
[ ] access token 발급
[ ] comments webhook 연결
[ ] messages webhook 연결
[ ] Private Reply 수동 API 호출 성공
[ ] 일반 message API 호출 성공
```

## Phase 2 — AWS 기본 인프라

```text
[ ] AWS account/region 준비
[ ] SQS + DLQ
[ ] DynamoDB
[ ] Secrets Manager
[ ] API Gateway
[ ] Webhook Lambda
[ ] Worker Lambda
```

## Phase 3 — 자동화

```text
[ ] comment -> private reply
[ ] message webhook -> follow-up
[ ] state machine
[ ] idempotency
[ ] retry
[ ] DLQ
```

## Phase 4 — 배포 자동화

```text
[ ] GitHub repository
[ ] SAM template
[ ] CI
[ ] GitHub OIDC
[ ] production deploy
```

## Phase 5 — 운영 안정화

```text
[ ] CloudWatch alarm
[ ] DLQ alarm
[ ] 429 metric
[ ] token expiration strategy
[ ] 개인정보 로그 점검
[ ] 장애 재처리 runbook
```

---

# 38. 완료 기준

MVP 완료 조건:

```text
✅ 실제 Instagram 댓글 발생
        ↓
✅ comments webhook 수신
        ↓
✅ SQS enqueue
        ↓
✅ Worker Lambda 실행
        ↓
✅ Private Reply 전송

"팔로워인지 확인할게요! 아무 메시지나 보내주세요 💬"

        ↓

✅ 사용자가 DM으로 아무 메시지나 응답
        ↓
✅ messages webhook 수신
        ↓
✅ SQS enqueue
        ↓
✅ Worker Lambda
        ↓
✅ 후속 DM 전송

"❤️사전예약 양식❤️
성함 :
생년월일 :
연락처 :
통신사 :
희망기종 :
거주지역 :
위 양식 작성해주시면 업무 조회 후 상담도와드리겠습니다😃"

        ↓
✅ DynamoDB 상태 FORM_SENT
✅ 중복 이벤트에도 중복 메시지 최소화
✅ 실패 시 SQS retry
✅ 반복 실패 시 DLQ
```

---

# 39. 설계 결론

이 시스템의 최종 기술 선택은 다음과 같다.

```text
Instagram
  ↓
API Gateway HTTP API
  ↓
Webhook Lambda
  ↓
SQS Standard
  ↓
Worker Lambda
  ├── DynamoDB
  ├── Secrets Manager
  └── Instagram Graph API
         │
         ├── Private Reply
         └── Follow-up Message

Failure → SQS retry → DLQ

Source Control → GitHub
IaC → AWS SAM
CI/CD → GitHub Actions + AWS OIDC
Logs → CloudWatch
```

핵심 설계 원칙은 다음과 같다.

1. Webhook 수신과 외부 API 부작용을 분리한다.
2. SQS를 통해 retry/backpressure/DLQ를 확보한다.
3. Lambda는 stateless하게 만들고 상태는 DynamoDB에 저장한다.
4. 외부 webhook 중복 전달을 전제로 idempotency를 구현한다.
5. Instagram access token은 Git이 아닌 Secrets Manager에 저장한다.
6. AWS Console이 아니라 Git + SAM을 infrastructure source of truth로 사용한다.
7. GitHub Actions는 OIDC로 AWS에 접근한다.
8. Kinesis/EventBridge/Step Functions/ECS/EC2는 현재 요구사항에 비해 과도하므로 도입하지 않는다.
9. 개인정보가 포함될 수 있는 대화 본문은 로그에 남기지 않는다.
10. follower 여부를 임의의 공식 API endpoint로 조회한다고 가정하지 않고, Meta가 지원하는 Private Reply → 사용자 응답 → follow-up messaging flow를 사용한다.

---

# 40. 참고 자료

- Meta Instagram API 공식 Postman 컬렉션: https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api
- Meta Comment webhook: https://www.postman.com/meta/instagram/request/23987686-db99ce99-bf76-475c-8b76-718576c11cae
- Meta Webhook payload reference: https://www.postman.com/meta/instagram/folder/23987686-5049585f-09b2-4775-a11a-debe5956e09a
- Meta Instagram User Profile API: https://www.postman.com/meta/instagram/folder/23987686-22b3a5b0-4a51-449a-9299-e3667d69b182
- AWS Lambda + SQS 공식 문서: https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
- AWS SAM 공식 문서: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html
- AWS API Gateway HTTP APIs: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html
