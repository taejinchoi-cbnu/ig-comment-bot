# 테스트 169건이 전부 통과했는데, 그대로 배포했으면 콜드스타트에서 즉사했을 것이다

> ig-comment-bot Phase 1 · 2026-08-25
> Wave 1~3(서브에이전트 병렬 구현) 직후 `/code-review medium` 실행 → 8건 반영

**PAAR 구조**로 정리합니다 — Problem(문제) · Analysis(분석) · Action(조치) · Result(결과).

---

## 배경

Phase 1의 처리 경로(webhook 수신, 댓글/메시지 핸들러, Instagram 클라이언트, 토큰 암호화, SQS
프로듀서, Lambda 배선)를 서브에이전트 여러 개를 병렬로 띄워 만들었습니다. 저는 오케스트레이션과
리뷰를 맡고, 실제 코드는 sonnet/haiku 에이전트들이 각자 파일을 나눠 짰습니다.

Wave 3가 끝난 시점 상태:

```
pnpm verify           169건 통과, typecheck 클린, build 클린
pnpm test:db            8건 통과 (실제 Neon Postgres)
node dist/main.js      /health 200, GET·POST /webhook/:slug 라우트 정상
```

전부 초록이었습니다. 이 상태에서 `/code-review medium`을 돌렸습니다.

---

## P — Problem

리뷰 결과 8건 중 1번이 심각했습니다.

> `infra/template.yaml`의 `CodeUri`가 `apps/api/dist`(= `nest build` 산출물)를 가리키는데,
> `nest build`는 컴파일만 하고 **`node_modules`를 담지 않는다.** `cloudformation package`는
> `CodeUri` 디렉터리를 그대로 zip 해서 올리므로, **이 상태로 배포하면 두 Lambda 모두 콜드스타트에서
> `Cannot find module 'reflect-metadata'`로 죽는다.**

테스트 169건, typecheck, build, 로컬 부팅까지 전부 통과했는데 **배포 아티팩트 자체가 처음부터
동작할 수 없는 상태**였습니다. 이유가 명확합니다 — 그 어떤 테스트도 "이 zip이 Lambda 환경에서
실제로 부팅되는가"를 확인하지 않았습니다. `node dist/main.js`로 로컬에서 띄운 건 `node_modules`가
`apps/api/` 아래 그대로 있는 상태에서 실행한 것이라, 이 문제를 절대 드러내지 않습니다.

**초록 테스트는 "코드가 맞다"를 증명하지, "이 아티팩트가 뜬다"를 증명하지 않습니다.**

---

## A — Analysis

### 1단계: 번들링이 가능한 구조인지 먼저 확인

esbuild로 완전히 번들링하면 되는데, NestJS는 생성자 주입에 `emitDecoratorMetadata`(타입 리플렉션)를
쓰는 경우가 많고 esbuild는 그걸 지원하지 않습니다. 번들링 전에 우리 코드가 실제로 그 기능에
의존하는지부터 확인해야 했습니다.

```bash
$ grep -n 'constructor(' src/webhook/webhook.controller.ts src/app.module.ts
(결과 없음)
$ grep -rn '@Injectable\|providers:' src/**/*.ts
(결과 없음)
```

생성자 주입이 **아예 없었습니다.** `WebhookController`는 `getPrisma()`, `loadSecrets()` 같은 함수를
메서드 안에서 직접 호출하는 구조였고, `@Controller`/`@Get`류는 자체적으로 `Reflect.defineMetadata`를
명시적으로 호출하는 데코레이터라 `emitDecoratorMetadata` 없이도 동작합니다. AGENTS.md에 처음부터
"순수 모듈에 데코레이터 금지" 규칙을 박아둔 게, 의도치 않게 여기서 번들링 가능성을 지켜준
셈입니다.

### 2단계: 실제로 번들링 시도 → 다른 벽에 부딪힘

```
✘ [ERROR] Could not resolve "@nestjs/microservices/microservices-module"
✘ [ERROR] Could not resolve "class-validator"
✘ [ERROR] Could not resolve "@nestjs/websockets/socket-module"
✘ [ERROR] Could not resolve "class-transformer"
```

NestJS 코어가 마이크로서비스·웹소켓·검증 파이프를 **선택적으로** 지원하려고 내부에서
`require()`로 찔러보는 코드였습니다. 우리는 그 기능들을 안 쓰니 설치조차 안 했는데, esbuild는
정적 분석 시점에 이걸 못 찾으면 그냥 빌드를 실패시킵니다. Nest 쪽 코드는 이미 이 호출을
`optionalRequire` 헬퍼로 감싸 런타임에 실패해도 무시하게 되어 있어서, `--external`로 네 개를
넘겨 esbuild가 손대지 않게 두면 됩니다 — Nest+esbuild 조합의 표준 해법입니다.

### 3단계: 정말 뜨는지 실제로 부팅해서 확인

여기가 핵심이었습니다. "번들 파일이 생성됐다"와 "Lambda에서 뜬다"는 다른 이야기입니다.
Function URL이 주는 페이로드 형태(API Gateway v2)를 합성해서 진짜로 handler를 호출했습니다.

```js
const { handler } = require('./dist-lambda/http.js');
const event = { version:'2.0', rawPath:'/health', ... };
handler(event, { getRemainingTimeInMillis:()=>30000 }, ()=>{})
  .then(r => console.log('status', r.statusCode, r.body));
```

```
[Nest] Starting Nest application...
[Nest] AppModule dependencies initialized
[Nest] Mapped {/health, GET} route
[Nest] Mapped {/webhook/:slug, GET} route
[Nest] Mapped {/webhook/:slug, POST} route
status 200 {"ok":true,"at":"2026-08-25T11:30:02.371Z"}
```

SQS 핸들러도 빈 배치로 같은 방식으로 확인했습니다 (`{"batchItemFailures":[]}`). **이 두 번의 실제
호출이, 169개 유닛 테스트가 못 준 확신을 줬습니다.**

### 4단계: 번들링이 가능했던 숨은 전제 — Prisma 7 driver adapter

번들이 통째로 성공한 이유가 하나 더 있습니다. `@prisma/adapter-pg`(driver adapter) 방식은 쿼리를
`pg` 드라이버로 직접 보내서, 예전 Prisma가 쓰던 네이티브 바이너리(`libquery_engine.*.node`)가
아예 없습니다. 있었다면 esbuild 번들에 안 들어가 별도 레이어/에셋 처리가 필요했을 겁니다.
Prisma 6→7 마이그레이션 때는 "런타임/CLI URL 분리가 Neon 구성과 잘 맞는다"는 이유로 driver
adapter를 골랐는데, 이번엔 그 선택이 번들링 가능성이라는 다른 축에서도 이득을 냈습니다.

---

## A — Action

나머지 7건도 심각도 순으로 처리했습니다.

### 테넌트 격리 누락 (4번) — 고치기 전에 버그가 진짜인지 재현부터

`message.handler.ts`가 캠페인을 `Campaign.id` 하나만으로 조회했습니다. `comment.handler.ts`는
`igAccountId_mediaId` 복합 키로 찾는데, 다른 에이전트가 만든 `message.handler.ts`는 그 규칙을
안 따랐습니다. `Campaign.id`가 전역 고유(cuid)라 지금은 결과가 같지만, 그게 DB 제약이 아니라
"comment.handler.ts가 항상 올바른 값만 쓴다"는 관례에만 의존하고 있었습니다.

이 발견을 그냥 믿지 않고, **격리가 없는 버전을 별도 스크립트로 실제로 돌려서 진짜 새는지 확인**했습니다.

```js
// 원래 버그 그대로 재현: id 만으로 찾는 가짜 DB
campaign: { findFirst: async ({ where }) => (where.id === 'camp_other' ? foreignCampaign : null) }
...
assert.equal(sentText, foreignCampaign.followUpText); // 통과 — 실제로 샌다
```

**정말 샜습니다.** `findFirst({ where: { id, igAccountId } })`로 고친 뒤, 커밋된 회귀 테스트가
실제로 그 상황을 막아내는지도 확인했습니다 (수정을 잠깐 되돌려서 테스트가 실패하는 것까지 확인
후 재적용).

### 전역 환경변수가 애초에 아키텍처와 안 맞았음 (5번)

`account.service.ts`가 `process.env.META_APP_SECRET`을 두 번째 서명 후보로 참조하는데,
`template.yaml` 어디에도 이 변수가 정의돼 있지 않아 **프로덕션에서 항상 `undefined`** 였습니다.
단순히 "환경변수를 빼먹었다"가 아니라 **설계 자체가 틀렸습니다** — 우리는 고객마다 별도 Meta
앱을 쓰는 멀티테넌트 구조(Model B)라, "상위 앱 시크릿"이 있다면 그것도 계정마다 다를 수 있는
값이지 플랫폼 전역일 수 없습니다. `IgAccount.parentAppSecretEnc`(nullable) 필드를 추가하고
마이그레이션을 새로 돌려 계정별로 옮겼습니다.

### 나머지 5건

| # | 문제 | 조치 |
|---|---|---|
| 2 | SQS 워커가 모르는 계정 이벤트를 로그만 남기고 버림 | `igAccountId`가 필수 FK라 Event를 못 씀 — 이유를 주석으로 명시하고 구조화 로그로 격상 |
| 3 | enqueue 부분 실패가 통계에 안 남고 카운트도 부정확 | `FAILED` Event로 기록, 실제 성공 수를 반환하도록 수정 |
| 6 | webhook 경로가 안 쓰는 `accessToken`을 매번 복호화 | 제거 — 실패하면 정상 서명 요청까지 404로 떨어지는 불필요한 결합이었다 |
| 7 | `deploy.sh`가 `STACK_NAME`과 무관하게 항상 `Environment=dev` | `ops/deploy.env`의 `ENVIRONMENT`를 따르도록, `dev\|prod` 검증 추가 |
| 8 | "실패는 캐시 안 하는 비동기 메모이즈" 패턴이 4곳에 손카피 | `src/lib/memoize-async.ts`로 통합, 4곳 리팩터 |

---

## R — Result

**정량**

| 항목 | 리뷰 전 | 리뷰 후 |
|---|---|---|
| 오프라인 테스트 | 154건 | **169건** |
| DB 통합 테스트 | 8건 | 8건 (변동 없음) |
| 배포 시 콜드스타트 결과 | **즉시 크래시** (미검증 상태였음) | Function URL 이벤트로 실제 부팅·200 확인 |
| 테넌트 간 문구 유출 가능성 | 있었음 (재현 확인) | 재현 테스트가 고친 코드를 막아내는 것까지 확인 |
| `META_APP_SECRET` | 항상 `undefined`인 죽은 코드 | 계정별 필드로 정정, 마이그레이션 적용 |
| 손카피된 메모이즈 구현 | 4곳 | 1곳 + 재사용 4곳 |

**정성**

- 가장 심각한 버그(1번)는 **유닛 테스트로는 원천적으로 못 잡는 종류**였습니다. 테스트가 검증하는
  범위(코드 로직)와 배포가 검증해야 하는 범위(빌드 산출물이 실행 환경에서 부팅되는가)가 다른
  층이라, "테스트 다 통과 = 배포 준비 완료"라는 등식이 성립하지 않았습니다.
- 8건 중 절반가량(1, 4, 5)이 **여러 에이전트가 병렬로 작업한 경계에서** 생겼습니다. 각 에이전트는
  자기 파일 안에서는 논리적으로 맞았습니다 — `message.handler.ts`를 만든 에이전트는 그 파일만
  보면 이상할 게 없었고, `account.service.ts`의 `META_APP_SECRET` 참조도 그 자체로는 합리적인
  방어 코드처럼 보였습니다. 문제는 **다른 파일과의 일관성**(comment.handler의 테넌트 스코프 규칙)과
  **인프라 다른 레이어와의 일관성**(그 환경변수가 실제로 어딘가에 정의됐는지)이었고, 이건 개별
  에이전트가 아니라 오케스트레이터가 파일 경계를 넘어 봐야 잡히는 종류였습니다.

---

## 배운 것

### 1. 초록 테스트는 "배포 가능"의 증거가 아니다

단위 테스트, typecheck, 로컬 빌드, 로컬 부팅까지 4단계가 전부 통과해도 배포 아티팩트가 뜨지
않을 수 있습니다. 이유는 **로컬 실행과 Lambda 실행이 의존성을 찾는 방식이 다르기 때문**입니다 —
로컬은 `node_modules`가 디스크에 그대로 있고, Lambda 배포 패키지는 `CodeUri`가 zip하는 내용물이
전부입니다. **배포 파이프라인이 실제로 만드는 산출물을, 실제로 실행해서 확인하는 단계**가 테스트
스위트와 별개로 있어야 합니다. 이번엔 그 확인을 "합성 이벤트로 handler를 직접 호출"하는 방식으로
했는데, 비용이 크지 않아서 다음부터는 배포 스크립트에 스모크 테스트로 넣을 만합니다.

### 2. 발견을 발견 그대로 믿지 않고 재현한다

4번(테넌트 격리) 리뷰는 "이럴 수도 있다"는 지적이었지, "실제로 샌다"는 증명이 아니었습니다.
재현 스크립트로 직접 돌려서 진짜 새는 걸 확인하고, 그다음 고친 코드가 그걸 막는지도 되돌렸다
복원하는 방식으로 확인했습니다. **리뷰 코멘트를 정정 없이 그대로 코드에 반영하는 것과, 그 코멘트가
가리키는 실패를 재현해서 이해하고 고치는 것은 결과 코드가 비슷해 보여도 신뢰도가 다릅니다.**

### 3. 병렬 작업은 파일 안은 지켜도 파일 사이는 안 지킨다

서브에이전트에게 각자 파일을 나눠주면 파일 하나하나는 프롬프트대로 잘 나옵니다. 그런데
"모든 쿼리는 igAccountId로 스코프한다" 같은 **파일을 넘나드는 불변식**은 개별 에이전트의
프롬프트에 아무리 명시해도, 다른 에이전트가 만든 유사 코드와 실제로 대조해보기 전까지는
깨졌는지 알 수 없습니다. 오케스트레이터의 역할이 "각 산출물이 스펙대로인가"보다 **"산출물들이
서로 일관된가"** 쪽에 더 있다는 걸 이번에 체감했습니다.

### 4. 전역 상태로 잘못 모델링된 값은 코드가 아니라 설계를 고쳐야 한다

`META_APP_SECRET` 환경변수는 "환경변수를 안 채웠다"는 배선 문제처럼 보였지만, 실제로는 **그
값이 전역일 수 없는 구조**(계정마다 다른 Meta 앱)를 전역 변수로 표현하려 한 설계 실수였습니다.
배선만 고쳤다면 "테넌트 A의 상위 시크릿이 테넌트 B에도 적용되는" 다음 버그를 심는 꼴이었을
겁니다. 증상(undefined)과 원인(잘못된 스코프 모델)을 구분해야 했습니다.

---

## 면접용 30초 요약

> 서브에이전트를 병렬로 띄워 백엔드 처리 경로를 구현했는데, 테스트 169건과 typecheck·빌드가
> 전부 통과한 시점에 코드 리뷰를 돌렸더니 가장 심한 문제가 나왔습니다 — NestJS 빌드 산출물은
> node_modules를 안 담는데 CloudFormation이 그 디렉터리를 그대로 zip 하고 있어서, 배포하면
> Lambda가 콜드스타트에서 바로 죽는 상태였습니다. 어떤 테스트도 이걸 못 잡은 이유는 로컬 실행과
> Lambda 배포 패키지가 의존성을 찾는 방식이 다르기 때문이었고요. esbuild로 완전히 번들링해서
> 고쳤는데, 그 전에 우리 코드가 NestJS의 생성자 주입 타입 리플렉션에 의존하는지부터 확인했고
> (안 썼습니다), 고친 뒤에는 실제 Function URL 이벤트를 합성해서 handler를 직접 호출해 200
> 응답을 받는 것까지 확인했습니다. 나머지 리뷰 항목 중에는 테넌트 격리가 빠진 것도 있었는데,
> 그냥 고치지 않고 필터 없는 버전을 재현 스크립트로 돌려서 실제로 다른 계정 데이터가 새는 걸
> 먼저 확인한 다음 고쳤습니다. 전체적으로 배운 건, 테스트가 전부 초록이어도 그게 "배포해도
> 된다"는 증거는 아니라는 것과, 여러 에이전트가 병렬로 만든 코드는 파일 하나하나는 맞아도 파일
> 사이의 일관성은 따로 확인해야 한다는 것이었습니다.
