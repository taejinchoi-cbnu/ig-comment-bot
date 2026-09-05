import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReceive, handleVerification, type WebhookDeps } from './webhook.service.ts';
import { encrypt, generateKey } from '../crypto/cipher.ts';
import { signBody } from './signature.ts';
import type { BotEvent } from './normalize.ts';

const MASTER_KEY = generateKey();
const IG_USER_ID = '17841400000000000';
const THEM = '17850000000000000';
const APP_SECRET = 'app-secret-abc';
const VERIFY_TOKEN = 'verify-token-xyz';

type Captured = { enqueued: BotEvent[][]; events: Record<string, unknown>[] };

function buildDeps(
  opts: {
    slugExists?: boolean;
    /** enqueue 결과를 흉내 냅니다. 기본은 전부 성공. */
    enqueueResult?: (events: readonly BotEvent[]) => { successful: number; failed: { event: BotEvent; reason: string }[] };
  } = {},
): { deps: WebhookDeps; captured: Captured } {
  const captured: Captured = { enqueued: [], events: [] };
  const row = {
    id: 'acc_1',
    igUserId: IG_USER_ID,
    slug: 'abc123',
    verifyToken: VERIFY_TOKEN,
    accessTokenEnc: encrypt('access-token', MASTER_KEY),
    appSecretEnc: encrypt(APP_SECRET, MASTER_KEY),
    defaultPrivateReplyText: null,
    defaultFollowUpText: null,
  };
  const prisma = {
    igAccount: { findUnique: async () => (opts.slugExists === false ? null : row) },
    event: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        captured.events.push(...data);
        return { count: data.length };
      },
    },
  };
  return {
    captured,
    deps: {
      prisma: prisma as unknown as WebhookDeps['prisma'],
      producer: {
        enqueue: async (events: readonly BotEvent[]) => {
          captured.enqueued.push([...events]);
          if (opts.enqueueResult) return opts.enqueueResult(events);
          return { successful: events.length, failed: [] };
        },
      },
      masterKey: MASTER_KEY,
    },
  };
}

const commentBody = (fromId = THEM) =>
  JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: IG_USER_ID,
        changes: [
          {
            field: 'comments',
            value: {
              id: 'c1',
              text: '예약',
              from: { id: fromId, username: 'someone' },
              media: { id: 'm1' },
            },
          },
        ],
      },
    ],
  });

// ── GET 검증 ──────────────────────────────────────────────────────

test('GET: verify token 이 맞으면 challenge 를 그대로 돌려준다', async () => {
  const { deps } = buildDeps();
  const out = await handleVerification(
    'abc123',
    { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '12345' },
    deps,
  );
  assert.deepEqual(out, { status: 200, body: '12345' });
});

test('GET: verify token 이 틀리면 403', async () => {
  const { deps } = buildDeps();
  const out = await handleVerification(
    'abc123',
    { 'hub.mode': 'subscribe', 'hub.verify_token': '틀린값', 'hub.challenge': '12345' },
    deps,
  );
  assert.equal(out.status, 403);
});

test('GET: 없는 slug 는 404', async () => {
  const { deps } = buildDeps({ slugExists: false });
  const out = await handleVerification('없음', { 'hub.mode': 'subscribe' }, deps);
  assert.equal(out.status, 404);
});

// ── POST 수신 ─────────────────────────────────────────────────────

test('POST: 서명이 맞으면 이벤트를 큐에 넣고 200', async () => {
  const { deps, captured } = buildDeps();
  const body = commentBody();
  const out = await handleReceive('abc123', Buffer.from(body), signBody(body, APP_SECRET), deps);
  assert.equal(out.status, 200);
  assert.equal(out.enqueued, 1);
  assert.equal(captured.enqueued[0]?.[0]?.kind, 'COMMENT');
});

test('POST: 위조 서명은 403 이고 큐에 넣지 않는다', async () => {
  const { deps, captured } = buildDeps();
  const body = commentBody();
  const out = await handleReceive('abc123', Buffer.from(body), signBody(body, '다른시크릿'), deps);
  assert.equal(out.status, 403);
  assert.equal(captured.enqueued.length, 0);
});

test('POST: 없는 slug 는 404 이고 서명 검증도 하지 않는다', async () => {
  const { deps, captured } = buildDeps({ slugExists: false });
  const body = commentBody();
  const out = await handleReceive('없음', Buffer.from(body), signBody(body, APP_SECRET), deps);
  assert.equal(out.status, 404);
  assert.equal(captured.enqueued.length, 0);
});

test('POST: 서명은 맞지만 JSON 이 아니면 200 으로 넘긴다 — 비200 이 반복되면 Meta 가 구독을 끊는다', async () => {
  const { deps, captured } = buildDeps();
  const body = 'not-json';
  const out = await handleReceive('abc123', Buffer.from(body), signBody(body, APP_SECRET), deps);
  assert.equal(out.status, 200);
  assert.equal(captured.enqueued.length, 0);
});

test('POST: 셀프 댓글은 큐에 안 넣고 SELF_COMMENT 로 기록한다', async () => {
  const { deps, captured } = buildDeps();
  const body = commentBody(IG_USER_ID); // from.id === entry.id
  const out = await handleReceive('abc123', Buffer.from(body), signBody(body, APP_SECRET), deps);
  assert.equal(out.status, 200);
  assert.equal(captured.enqueued.length, 0);
  assert.equal(captured.events[0]?.skipReason, 'SELF_COMMENT');
});

test('POST: ECHO 는 기록하지 않는다 — DM 을 보낼 때마다 하나씩 되돌아와 노이즈만 된다', async () => {
  const { deps, captured } = buildDeps();
  const body = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: IG_USER_ID,
        messaging: [{ sender: { id: IG_USER_ID }, message: { mid: 'm', text: 'x', is_echo: true } }],
      },
    ],
  });
  const out = await handleReceive('abc123', Buffer.from(body), signBody(body, APP_SECRET), deps);
  assert.equal(out.status, 200);
  assert.equal(captured.events.length, 0, 'ECHO 는 Event 에 남기지 않는다');
});

test('POST: base64 로 온 본문도 원본 바이트로 검증하면 통과한다', async () => {
  const { deps } = buildDeps();
  const body = commentBody();
  const raw = Buffer.from(Buffer.from(body).toString('base64'), 'base64'); // Function URL 경로 재현
  const out = await handleReceive('abc123', raw, signBody(body, APP_SECRET), deps);
  assert.equal(out.status, 200);
  assert.equal(out.enqueued, 1);
});

test('POST: enqueue 가 일부 실패하면 실제 성공 수를 돌려주고 FAILED 로 기록한다', async () => {
  const { deps, captured } = buildDeps({
    enqueueResult: (events) => ({
      successful: 0,
      failed: events.map((event) => ({ event, reason: 'ThrottlingException' })),
    }),
  });
  const body = commentBody();
  const out = await handleReceive('abc123', Buffer.from(body), signBody(body, APP_SECRET), deps);

  assert.equal(out.status, 200, 'enqueue 실패라도 Meta 에는 200 — 비200 이 반복되면 구독이 끊긴다');
  assert.equal(out.enqueued, 0, '시도한 수가 아니라 실제로 큐에 들어간 수를 돌려준다');

  const failedEvent = captured.events.find((e) => e.type === 'FAILED');
  assert.ok(failedEvent, 'enqueue 실패도 Event 에 남아야 "왜 DM 이 안 갔지?" 에 답할 수 있다');
  assert.equal(failedEvent?.igsid, THEM);
  assert.match(String(failedEvent?.errorCode), /^ENQUEUE_FAILED:/);
});

test('POST: enqueue 부분 실패는 successful 개수를 정확히 반영한다', async () => {
  const { deps } = buildDeps({
    enqueueResult: (events) => ({
      successful: events.length - 1,
      failed: [{ event: events[events.length - 1]!, reason: 'InternalError' }],
    }),
  });
  // 댓글 하나 + 메시지 하나 → 이벤트 2개
  const body = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: IG_USER_ID,
        changes: [
          { field: 'comments', value: { id: 'c1', text: '예약', from: { id: THEM }, media: { id: 'm1' } } },
        ],
        messaging: [{ sender: { id: THEM }, message: { mid: 'mid1', text: '네' } }],
      },
    ],
  });
  const out = await handleReceive('abc123', Buffer.from(body), signBody(body, APP_SECRET), deps);
  assert.equal(out.enqueued, 1, '2건 중 1건만 성공했다면 1을 돌려줘야 한다');
});

// 정체는 실사용 로그로 확정했다 — 같은 Meta 앱의 Instagram 테스터로 등록된 **다른 계정**
// 앞으로 발사된 웹훅이다. 우리가 DM 을 보낼 때마다 그 계정 관점의 echo 까지 와서 발송
// 1건당 2~3행이 쌓이고 있었다. 우리 계정 통계에 들어갈 이유가 없다.
test('POST: ACCOUNT_MISMATCH 는 기록하지 않는다 — 남의 계정 이벤트다', async () => {
  const { deps, captured } = buildDeps();
  const body = JSON.stringify({
    object: 'instagram',
    entry: [{ id: '99999999999999999', changes: [] }],
  });

  const out = await handleReceive('abc123', Buffer.from(body), signBody(body, APP_SECRET), deps);

  assert.equal(out.status, 200);
  assert.equal(out.skipped, 1, 'normalize 는 걸러냈다');
  assert.equal(captured.events.length, 0, '하지만 Event 로는 남기지 않는다');
});
