# Meta / Instagram API — 검증된 제약과 함정

> ★ 작업 중 가장 자주 열게 될 문서. 코드를 쓰기 전에 관련 항목을 확인한다.
>
> 여기 적힌 것은 전부 Meta 공식 문서로 확인했다. 원본 설계서(`archive/2026-08-24-initial-design.md`)에는
> 이 중 **5개가 틀리게** 적혀 있으므로 그쪽을 참조하지 말 것.

기준: **API v25.0**, 호스트 `https://graph.instagram.com`, Instagram API with Instagram Login

---

## 1. 틀리면 조용히 망가지는 것들

| # | 항목 | 실제 | 안 지키면 |
|---|---|---|---|
| 1 | 댓글 webhook 형태 | `entry[].changes[]` 배열, `changes[].field === "comments"` | 파싱 자체가 실패. 원본 설계의 `entry[].field`는 **틀림** |
| 2 | 커멘터 식별자 | `changes[].value.from.id` 가 IGSID (`from.username`도 옴) | 대화 상태를 못 만듦 |
| 3 | 메시지 webhook 형태 | `entry[].messaging[]` 배열 (Messenger 형식) | 댓글과 같은 형태로 파싱하면 실패 |
| 4 | **echo 필터** | 봇이 보낸 DM이 `messaging[].message.is_echo === true` (`is_self`도) 로 되돌아옴 | **무한루프.** 자기 메시지에 자기가 반응 |
| 5 | **셀프 댓글 필터** | 내 계정이 내 글에 단 댓글도 webhook이 발사됨. `value.from.id === entry.id` 로 판별 | 자기 자신에게 DM 시도 → 실패 + 로그 오염 |
| 6 | **계정 구독** | App Dashboard의 필드 구독만으로는 부족. 계정마다 `POST /v25.0/me/subscribed_apps?subscribed_fields=comments,messages` 필요 | **webhook이 아예 안 온다.** 가장 흔한 삽질 |
| 7 | **App Secret 2종** | 앱 구성에 따라 서명 키가 Instagram app secret **또는 상위 Meta app secret**. 둘 다 시도해야 함 | 403만 반복되고 원인 파악이 오래 걸림 |
| 8 | raw body | Function URL / API Gateway가 body를 base64로 줄 수 있음. `isBase64Encoded` 확인 후 **디코드한 원본 바이트**로 HMAC | 서명 검증 전부 실패 |
| 9 | Private Reply 창 | 댓글당 **1회만**, 게시물/릴스는 댓글 후 **7일 이내** (Live는 방송 중에만) | 400. 재시도해도 성공 안 함 |
| 10 | 후속 메시지 창 | 사용자가 응답한 뒤에만 가능, 응답 후 **24시간 이내** | 400 |
| 11 | **Standard Access** | 상대 계정이 앱에 **role(Instagram Tester)** 을 갖고 초대를 수락해야 메시지 발송됨 | 권한 에러. 앱을 Live로 바꿔도 App Review 없이는 안 됨 |
| 12 | **자기 자신에게 DM 불가** | 내 계정으로 내 글에 댓글 달면 Private Reply가 자기에게 DM하는 셈이라 실패 | **테스트에 두 번째 인스타 계정이 반드시 필요** |
| 13 | 팔로워 판별 | `is_user_follow_business` 필드가 **존재한다**. 단 **대화 성립 후에만** 조회 가능 | 원본 설계 §5.5의 "판별 API 없음"은 **틀림**. 댓글 단계에선 못 쓰는 것도 사실 |
| 14 | 액세스 토큰 | App Dashboard → Instagram → API setup with Instagram business login → **Generate token** = **60일 장기 토큰** | OAuth 플로우를 구현할 필요가 없다 |

### 필요 권한
```
instagram_business_basic
instagram_business_manage_comments
instagram_business_manage_messages
instagram_business_manage_insights   # Phase 3 (팔로워 추이·인구통계). 아래 §7
```

---

## 2. Webhook payload 실제 형태

**댓글** — `changes[]` 안에 있다:
```json
{
  "object": "instagram",
  "entry": [{
    "id": "<내_IG_USER_ID>",
    "time": 1760000000000,
    "changes": [{
      "field": "comments",
      "value": {
        "id": "<COMMENT_ID>",
        "text": "예약",
        "from": { "id": "<커멘터_IGSID>", "username": "someone" },
        "media": { "id": "<MEDIA_ID>", "media_product_type": "FEED" }
      }
    }]
  }]
}
```

**메시지** — `messaging[]` 안에 있다:
```json
{
  "object": "instagram",
  "entry": [{
    "id": "<내_IG_USER_ID>",
    "time": 1760000000000,
    "messaging": [{
      "sender":    { "id": "<상대_IGSID>" },
      "recipient": { "id": "<내_IG_USER_ID>" },
      "timestamp": 1760000000000,
      "message": { "mid": "<MESSAGE_ID>", "text": "네" }
    }]
  }]
}
```

### normalize 단계에서 버려야 할 것

| 조건 | 이유 |
|---|---|
| `value.from.id === entry.id` | 셀프 댓글 |
| `message.is_echo` 또는 `message.is_self` | 봇 자기 메시지 (**무한루프 방지**) |
| `entry.id` 가 경로의 계정과 불일치 | 잘못 배달된 이벤트 |
| `message.text` 없음 | 스티커/리액션/read/delivery 이벤트 |

한 요청에 **여러 `entry`와 여러 `changes`가 올 수 있으므로 배열로 처리**한다.

---

## 3. 메시지 발송

두 경우 모두 같은 엔드포인트, `recipient`만 다르다.

```http
POST https://graph.instagram.com/v25.0/{IG_USER_ID}/messages
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json
```

```jsonc
// 1차 — 댓글에 대한 Private Reply
{ "recipient": { "comment_id": "<COMMENT_ID>" }, "message": { "text": "..." } }

// 2차 — 사용자가 답장한 뒤 일반 메시지
{ "recipient": { "id": "<IGSID>" },              "message": { "text": "..." } }
```

### 재시도 분류

| 재시도함 (SQS retry) | 재시도 안 함 (로그 + 종료) |
|---|---|
| 429 Too Many Requests | 400 malformed / 잘못된 comment_id |
| 5xx | 401 / 403 (토큰·권한) |
| 네트워크 오류 | Private Reply 7일 창 만료 |
| AWS SDK 일시 오류 | 후속 24시간 창 만료 |

재시도 안 하는 오류를 SQS에 되돌리면 5번 재시도 후 DLQ로 가서 노이즈만 만든다. 코드에서 분류한다.

---

## 4. 계정 연결 절차 (모델 B)

App Review를 안 가므로, **사용자가 자기 Meta 앱을 만들고** 자격증명을 우리에게 준다.
각 앱이 자기 계정만 다루므로 Standard Access로 충분하다 — 이게 App Review를 우회하는 핵심이다.

1. 사용자: Meta Developer 앱 생성 → Instagram Professional 계정 연결
2. 사용자: **Instagram → API setup with Instagram business login → Generate token** (60일) + **IG User ID** 복사
3. 사용자: 앱 설정에서 **App Secret** 복사
4. 우리: 위 3개를 받아 저장하고 `slug` + `verifyToken` 생성 → **webhook URL과 verify token을 화면에 표시**
5. 사용자: 자기 앱의 Webhooks에 그 URL/토큰 입력 → *Verify and Save* → `comments`, `messages` 구독
6. 우리: `GET /v25.0/me` 로 토큰 검증 + **`POST /v25.0/me/subscribed_apps?subscribed_fields=comments,messages`** 호출
7. 운영자: 테스트/사용할 인스타 계정을 App Roles → **Instagram Tester로 초대** → 해당 계정에서 **수락**

> 6번을 빠뜨리면 5번까지 다 해도 webhook이 오지 않는다. 가장 흔한 실패 지점.

App Review를 통과하면 1~5가 OAuth 버튼 하나로 접히고 **DB 레코드는 동일**하다. 나중에 붙여도 데이터 모델은 그대로.

---

## 5. 게시글 URL → media ID

사용자는 `https://www.instagram.com/p/DXXXXXXXXXX/` 또는 `/reel/DXXXXXXXXXX/` 를 붙여넣는다.

**URL의 shortcode는 media ID가 아니다.**
shortcode를 base64 디코딩해서 media ID를 만드는 방법이 인터넷에 돌아다니지만 신뢰할 수 없으므로 **쓰지 않는다.**

올바른 방법 — 내 미디어 목록에서 `permalink`로 매칭:
```http
GET /v25.0/me/media?fields=id,permalink,caption,media_type,thumbnail_url&limit=50
```
1. 응답의 각 `permalink`에서 shortcode 추출
2. 입력 URL의 shortcode와 매칭 → `id` 확보
3. `thumbnail_url` · `caption`도 함께 저장 → 대시보드 썸네일/미리보기

매칭 실패(최근 50개 밖 게시물)하면 **같은 응답으로 받은 목록을 드롭다운으로 제시**한다. 추가 API 호출 없이 폴백이 나온다.

---

## 6. 트러블슈팅 결정 트리

**"자동 DM이 안 나가요"**

```
CloudWatch 로그에 webhook 요청이 찍혔는가?
├─ 아니오 → ① subscribed_apps 호출했는가?          ← 1순위 의심
│           ② Meta Dashboard에서 comments/messages 구독 상태
│           ③ callback URL 오타 / slug 불일치
│           ④ Meta 쪽에서 구독이 비활성화됐는가 (비200 반복 시 발생)
└─ 예 → 응답 코드는?
        ├─ 404 → slug가 DB에 없음. 계정 연결 다시 확인
        ├─ 403 → 서명 불일치. ⓐ base64 raw body 처리 ⓑ App Secret 종류(2종 다 시도)
        └─ 200 → SQS에 들어갔는가?
                 ├─ 아니오 → normalize가 버렸다. events 테이블의 skipReason 확인
                 │            (셀프 댓글 / 키워드 불일치 / echo / 텍스트 없음)
                 └─ 예 → 워커 로그의 Instagram API 응답은?
                          ├─ 권한 에러 → Instagram Tester 초대 수락 여부       ← 흔함
                          ├─ 400       → 셀프 댓글이거나 7일/24시간 창 경과
                          ├─ 429/5xx   → 재시도 중. DLQ 깊이 확인
                          └─ 성공      → 상대방 요청함(Requests) 탭 확인
```

---

## 7. Insights — 분석에 쓸 수 있는 것과 없는 것

Phase 3에서 쓴다. 권한 `instagram_business_manage_insights` 가 추가로 필요하고,
[§4 연결 절차](#4-계정-연결-절차-모델-b)에서 사용자가 이 권한도 승인해야 한다.

### 되는 것

| 지표 | 요청 | 제약 |
|---|---|---|
| 팔로워 수 추이 | `metric=follower_count`, `metric_type=time_series`, `period=day` | **100팔로워 미만 계정은 안 나옴** |
| 팔로워 인구통계 | `metric=follower_demographics`, `period=lifetime`, `metric_type=total_value`, `timeframe=`, `breakdown=` | 위와 동일 |
| 반응자 인구통계 | `metric=engaged_audience_demographics` (나머지 동일) | 위와 동일 |
| **개인별 팔로워 여부** | `GET /{IGSID}?fields=is_user_follow_business` | **대화 성립 후에만** |

```http
GET /v25.0/{IG_USER_ID}/insights
  ?metric=follower_demographics
  &period=lifetime
  &metric_type=total_value
  &timeframe=last_30_days        # last_14_days | last_30_days | last_90_days | prev_month | this_month | this_week
  &breakdown=age                 # age | gender | city | country
```

### 안 되는 것 — 대체 수단 없음

| | 왜 |
|---|---|
| **팔로워 목록 (누가 팔로우했는지)** | 개인을 식별하는 팔로워 목록 엔드포인트가 **존재하지 않는다.** 집계만 제공 |
| **게시글별 팔로워 증가 귀속** | `follower_count`는 계정 단위 일별 수치. "이 게시글로 12명 늘었다"는 만들 수 없다 |

캠페인 기간과 팔로워 그래프를 겹쳐 보여주는 것까지는 되지만 **상관관계이지 인과가 아니다.**
화면 문구도 "이 기간에 +47명"이지 "이 게시글이 47명을 데려왔다"가 아니어야 한다.

### 그 대신 — 캠페인 단위로 실측 가능한 지표

`is_user_follow_business`는 **개인별로** 조회된다. 캠페인에 반응한 사람마다 찍으면:

> "이 게시글 반응자 41명 중 팔로워 28명 / 비팔로워 13명"

이건 계정 단위 집계가 아니라 **게시글 단위 실측**이고, 팔로워 증가를 귀속시키지 못하는 문제를
정면으로 우회한다. 상용 도구가 보여주지 않는 숫자다.

- 조회 시점: 사용자가 DM으로 답장한 직후(대화 성립 시점)
- 결과는 `Event` 행에 함께 기록한다. 나중에 다시 조회하면 값이 달라져 과거 통계가 흔들린다
- 반응자 1명당 API 호출 1회 → 호출량은 답장 수만큼. 지금 규모에선 문제없음

### 테스트 시 주의

테스트 계정이 **100팔로워 미만이면 `follower_count`와 인구통계가 아예 안 나온다.**
Phase 3 검증 시 팔로워가 있는 실계정(지인 계정)으로 확인해야 한다. 개인별 팔로워 여부는 이 제한과 무관하다.

---

## 8. 참고 링크

- [Instagram Platform Overview (Standard vs Advanced Access)](https://developers.facebook.com/docs/instagram-platform/overview/)
- [Webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks)
- [Send Messages](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)
- [Private Replies](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/private-replies)
- [Conversations API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api/)
- [Get Started (토큰 발급)](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started)
