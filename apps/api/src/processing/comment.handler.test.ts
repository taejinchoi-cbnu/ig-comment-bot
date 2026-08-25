import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleComment } from './comment.handler.ts';
import type { HandlerAccount, HandlerCampaign, HandlerContext, EventInput } from './context.ts';
import { InstagramApiError } from '../instagram/errors.ts';
import type { CommentEvent } from '../webhook/normalize.ts';

// ── 픽스처 ────────────────────────────────────────────────────────

const account: HandlerAccount = {
  id: 'acc_1',
  igUserId: '17841400000000000',
  defaultPrivateReplyText: '계정 기본 문구',
  defaultFollowUpText: '계정 기본 후속 문구',
};

const campaign: HandlerCampaign = {
  id: 'camp_1',
  mediaId: 'media_1',
  enabled: true,
  triggerKeywords: ['예약'],
  privateReplyText: '캠페인 문구',
  followUpText: '캠페인 후속 문구',
};

const baseEvent: CommentEvent = {
  kind: 'COMMENT',
  igUserId: account.igUserId,
  commentId: 'comment_1',
  mediaId: 'media_1',
  igsid: 'igsid_1',
  username: 'someone',
  text: '예약 하고 싶어요',
};

/** 호출 순서를 기록하는 가짜 HandlerContext. 각 훅으로 동작을 커스터마이즈한다. */
function createFakeCtx(opts: {
  campaign?: HandlerCampaign | null;
  createSentReplyError?: unknown;
  sendPrivateReplyError?: unknown;
  nowSequence?: number[];
} = {}) {
  const calls: string[] = [];
  const events: EventInput[] = [];
  let deleteCalled = false;
  let upsertArgs: unknown = undefined;
  let nowIdx = 0;
  const nowSequence = opts.nowSequence ?? [1000, 1500];

  const ctx: HandlerContext = {
    account,
    prisma: {
      campaign: {
        // biome-ignore lint: 테스트 전용 최소 구현
        findUnique: async () => {
          calls.push('campaign.findUnique');
          return opts.campaign === undefined ? campaign : opts.campaign;
        },
      },
      sentReply: {
        create: async () => {
          calls.push('sentReply.create');
          if (opts.createSentReplyError) throw opts.createSentReplyError;
          return {} as never;
        },
        delete: async () => {
          calls.push('sentReply.delete');
          deleteCalled = true;
          return {} as never;
        },
      },
      conversation: {
        upsert: async (args: unknown) => {
          calls.push('conversation.upsert');
          upsertArgs = args;
          return {} as never;
        },
      },
      event: {
        create: async (args: { data: EventInput & { type: string } }) => {
          calls.push('event.create');
          events.push(args.data as unknown as EventInput);
          return {} as never;
        },
      },
      // biome-ignore lint: HandlerPrisma 표면만 필요
    } as unknown as HandlerContext['prisma'],
    instagram: {
      sendPrivateReply: async () => {
        calls.push('sendPrivateReply');
        if (opts.sendPrivateReplyError) throw opts.sendPrivateReplyError;
        return { recipientId: 'igsid_1', messageId: 'mid_1' };
      },
      sendMessage: async () => {
        throw new Error('이 테스트에서는 쓰이지 않는다');
      },
      // biome-ignore lint: InstagramSender 표면만 필요
    } as unknown as HandlerContext['instagram'],
    now: () => nowSequence[Math.min(nowIdx++, nowSequence.length - 1)] ?? 0,
  };

  return {
    ctx,
    calls,
    events,
    deleteCalled: () => deleteCalled,
    upsertArgs: () => upsertArgs,
  };
}

const P2002 = { code: 'P2002', message: 'Unique constraint failed' };

// ── 정상 흐름 ─────────────────────────────────────────────────────

test('캠페인이 있으면 발송 후 대화를 upsert 하고 PRIVATE_REPLY_SENT 를 기록한다', async () => {
  const { ctx, calls, events, upsertArgs } = createFakeCtx({ nowSequence: [1000, 1500] });

  await handleComment(baseEvent, ctx);

  assert.ok(calls.includes('sendPrivateReply'), 'Private Reply 가 발송돼야 한다');
  assert.ok(calls.includes('conversation.upsert'), '대화가 upsert 돼야 한다');

  const sentEvent = events.find((e) => e.type === 'PRIVATE_REPLY_SENT');
  assert.ok(sentEvent, 'PRIVATE_REPLY_SENT 가 기록돼야 한다');
  assert.equal(sentEvent?.latencyMs, 500);
  assert.equal(sentEvent?.campaignId, 'camp_1');
  assert.equal(sentEvent?.mediaId, 'media_1');

  const args = upsertArgs() as { create: Record<string, unknown> };
  assert.equal(args.create.lastMediaId, 'media_1');
});

test('캠페인이 없어도 중단하지 않고 계정 기본 문구로 발송한다', async () => {
  const { ctx, calls, events } = createFakeCtx({ campaign: null });

  // 캠페인이 없으면 triggerKeywords 가 [] 이므로 모든 댓글이 통과한다
  await handleComment(baseEvent, ctx);

  assert.ok(calls.includes('sendPrivateReply'), '캠페인이 없어도 발송돼야 한다');
  const sentEvent = events.find((e) => e.type === 'PRIVATE_REPLY_SENT');
  assert.ok(sentEvent);
  assert.equal(sentEvent?.campaignId, null, '캠페인이 없으니 campaignId 도 없어야 한다 (recordEvent 가 undefined→null 로 정규화)');
});

// ── 캠페인 꺼짐 ───────────────────────────────────────────────────

test('캠페인이 꺼져 있으면 발송하지 않고 CAMPAIGN_DISABLED 를 기록한다', async () => {
  const disabled: HandlerCampaign = { ...campaign, enabled: false };
  const { ctx, calls, events } = createFakeCtx({ campaign: disabled });

  await handleComment(baseEvent, ctx);

  assert.ok(!calls.includes('sendPrivateReply'), '발송이 일어나면 안 된다');
  const skipEvent = events.find((e) => e.type === 'COMMENT_SKIPPED');
  assert.equal(skipEvent?.skipReason, 'CAMPAIGN_DISABLED');
  assert.equal(skipEvent?.campaignId, 'camp_1');
});

// ── 키워드 불일치 ─────────────────────────────────────────────────

test('키워드가 일치하지 않으면 발송하지 않고 NO_KEYWORD_MATCH 를 기록한다', async () => {
  const { ctx, calls, events } = createFakeCtx();
  const event: CommentEvent = { ...baseEvent, text: '전혀 다른 말' };

  await handleComment(event, ctx);

  assert.ok(!calls.includes('sendPrivateReply'));
  const skipEvent = events.find((e) => e.type === 'COMMENT_SKIPPED');
  assert.equal(skipEvent?.skipReason, 'NO_KEYWORD_MATCH');
});

// ── 중복(P2002) ───────────────────────────────────────────────────

test('이미 보낸 댓글(P2002)이면 발송하지 않고 DUPLICATE 를 기록한다', async () => {
  const { ctx, calls, events } = createFakeCtx({ createSentReplyError: P2002 });

  await handleComment(baseEvent, ctx);

  const sendCalls = calls.filter((c) => c === 'sendPrivateReply');
  assert.equal(sendCalls.length, 0, 'sendPrivateReply 는 0회 호출돼야 한다');
  const skipEvent = events.find((e) => e.type === 'COMMENT_SKIPPED');
  assert.equal(skipEvent?.skipReason, 'DUPLICATE');
});

// ── 멱등성 마커 선점 순서 ─────────────────────────────────────────

test('멱등성 마커 선점이 발송보다 먼저 일어난다', async () => {
  const { ctx, calls } = createFakeCtx();

  await handleComment(baseEvent, ctx);

  const createIdx = calls.indexOf('sentReply.create');
  const sendIdx = calls.indexOf('sendPrivateReply');
  assert.ok(createIdx >= 0 && sendIdx >= 0);
  assert.ok(createIdx < sendIdx, '마커 선점(create) 이 발송(sendPrivateReply) 보다 앞서야 한다');
});

// ── 발송 실패: retryable ──────────────────────────────────────────

test('retryable 실패면 마커를 delete 로 되돌리고 throw 한다', async () => {
  const retryableError = new InstagramApiError('일시적 오류', { status: 500, retryable: true });
  const { ctx, calls, events, deleteCalled } = createFakeCtx({ sendPrivateReplyError: retryableError });

  await assert.rejects(() => handleComment(baseEvent, ctx), retryableError);

  assert.ok(deleteCalled(), 'sentReply.delete 가 호출돼야 한다');
  assert.ok(!calls.includes('conversation.upsert'), '실패했으니 대화는 갱신되면 안 된다');
  const failedEvent = events.find((e) => e.type === 'FAILED');
  assert.ok(failedEvent, 'FAILED 가 기록돼야 한다');
  assert.equal(failedEvent?.errorCode, '500');
});

// ── 발송 실패: non-retryable ──────────────────────────────────────

test('non-retryable 실패면 마커를 남겨두고 throw 하지 않는다', async () => {
  const permanentError = new InstagramApiError('만료된 창', { status: 400, retryable: false });
  const { ctx, calls, events, deleteCalled } = createFakeCtx({ sendPrivateReplyError: permanentError });

  await assert.doesNotReject(() => handleComment(baseEvent, ctx));

  assert.ok(!deleteCalled(), 'sentReply.delete 는 호출되면 안 된다 (마커를 남겨둔다)');
  assert.ok(!calls.includes('conversation.upsert'));
  const failedEvent = events.find((e) => e.type === 'FAILED');
  assert.ok(failedEvent, 'FAILED 가 기록돼야 한다');
  assert.equal(failedEvent?.errorCode, '400');
});

// ── lastMediaId ───────────────────────────────────────────────────

test('대화에 lastMediaId 가 저장된다 (게시물별 문구의 근거)', async () => {
  const { ctx, upsertArgs } = createFakeCtx();

  await handleComment(baseEvent, ctx);

  const args = upsertArgs() as { create: Record<string, unknown>; update: Record<string, unknown> };
  assert.equal(args.create.lastMediaId, 'media_1');
  assert.equal(args.update.lastMediaId, 'media_1');
  assert.equal(args.create.state, 'WAITING_USER_MESSAGE');
});

// ── 각 분기의 Event 기록 ──────────────────────────────────────────

test('정상 흐름에서 COMMENT_RECEIVED 와 PRIVATE_REPLY_SENT 가 모두 기록된다', async () => {
  const { ctx, events } = createFakeCtx();

  await handleComment(baseEvent, ctx);

  assert.ok(events.some((e) => e.type === 'COMMENT_RECEIVED'));
  assert.ok(events.some((e) => e.type === 'PRIVATE_REPLY_SENT'));
});
