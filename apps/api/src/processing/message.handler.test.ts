import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from './message.handler.ts';
import { InstagramApiError } from '../instagram/errors.ts';
import type { HandlerAccount, HandlerCampaign, HandlerContext, HandlerPrisma, InstagramSender } from './context.ts';
import type { MessageEvent } from '../webhook/normalize.ts';

const ACCOUNT_ID = 'acc_1';
const IGSID = 'igsid_1';
const IG_USER_ID = 'ig_user_1';

type ConversationRow = {
  igAccountId: string;
  igsid: string;
  state: 'WAITING_USER_MESSAGE' | 'USER_REPLIED' | 'FORM_SENT';
  lastMediaId: string | null;
  lastCampaignId: string | null;
};

function buildEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    kind: 'MESSAGE',
    igUserId: IG_USER_ID,
    messageId: 'mid_1',
    igsid: IGSID,
    text: '홍길동/1990-01-01/010-1234-5678',
    ...overrides,
  };
}

function buildAccount(overrides: Partial<HandlerAccount> = {}): HandlerAccount {
  return {
    id: ACCOUNT_ID,
    igUserId: IG_USER_ID,
    defaultPrivateReplyText: null,
    defaultFollowUpText: '계정 기본 후속 문구',
    defaultCommentReplyText: null,
    nonFollowerText: null,
    ...overrides,
  };
}

function buildCampaign(overrides: Partial<HandlerCampaign> = {}): HandlerCampaign {
  return {
    id: 'camp_1',
    mediaId: 'media_1',
    enabled: true,
    triggerKeywords: [],
    privateReplyText: null,
    followUpText: '캠페인 후속 문구',
    ...overrides,
  };
}

/** 가짜 HandlerContext 를 만든다. mocking 라이브러리 없이 평범한 객체로 의존을 주입한다. */
function buildCtx(opts: {
  conversation?: ConversationRow | null;
  campaigns?: Record<string, HandlerCampaign>;
  /** 각 캠페인을 소유한 계정. 없으면 ACCOUNT_ID 소유로 간주한다. */
  campaignOwners?: Record<string, string>;
  account?: HandlerAccount;
  sendMessageImpl?: (igsid: string, text: string) => Promise<{ recipientId: string; messageId: string }>;
  /** isUserFollowBusiness 가 돌려줄 값. 기본 null(모름). */
  isFollower?: boolean | null;
  followerCheckError?: unknown;
  now?: () => number;
}) {
  const calls: string[] = [];
  const events: Array<Record<string, unknown>> = [];

  let conversation: ConversationRow | null =
    opts.conversation === undefined
      ? { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_1', lastCampaignId: null }
      : opts.conversation;

  const campaigns = opts.campaigns ?? {};
  let formSentData: Record<string, unknown> | undefined;
  let rollbackData: Record<string, unknown> | undefined;

  const prisma = {
    conversation: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { state: ConversationRow['state'] } }) => {
        if (data.state === 'USER_REPLIED') {
          calls.push('claim');
          if (!conversation || conversation.state !== where.state) return { count: 0 };
          conversation = { ...conversation, state: 'USER_REPLIED' };
          return { count: 1 };
        }
        if (data.state === 'WAITING_USER_MESSAGE') {
          calls.push('rollback');
          rollbackData = data as Record<string, unknown>;
          if (!conversation) return { count: 0 };
          conversation = { ...conversation, state: 'WAITING_USER_MESSAGE' };
          return { count: 1 };
        }
        // FORM_SENT — 팔로워 캐시도 이때 같이 쓴다
        calls.push('formSent');
        formSentData = data as Record<string, unknown>;
        if (!conversation) return { count: 0 };
        conversation = { ...conversation, state: 'FORM_SENT' };
        return { count: 1 };
      },
      findUnique: async () => {
        calls.push('findConversation');
        return conversation;
      },
    },
    campaign: {
      // 실제 message.handler.ts 는 findFirst({ where: { id, igAccountId } }) 를 쓴다.
      // igAccountId 가 안 맞으면 null 을 돌려줘야 테넌트 격리 회귀를 잡을 수 있다.
      findFirst: async ({ where }: { where: { id: string; igAccountId: string } }) => {
        calls.push('findCampaign');
        const campaign = campaigns[where.id];
        if (!campaign) return null;
        const owner = opts.campaignOwners?.[where.id] ?? ACCOUNT_ID;
        return owner === where.igAccountId ? campaign : null;
      },
    },
    sentReply: {},
    event: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push(`event:${data.type as string}`);
        events.push(data);
      },
    },
  } as unknown as HandlerPrisma;

  const sendMessageImpl =
    opts.sendMessageImpl ?? (async (recipient: string) => ({ recipientId: recipient, messageId: 'sent_1' }));

  const instagram = {
    sendPrivateReply: async () => {
      throw new Error('이 핸들러는 sendPrivateReply 를 쓰지 않는다');
    },
    sendMessage: async (igsid: string, text: string) => {
      calls.push('sendMessage');
      return sendMessageImpl(igsid, text);
    },
    replyToComment: async () => {
      throw new Error('이 핸들러는 replyToComment 를 쓰지 않는다');
    },
    isUserFollowBusiness: async () => {
      calls.push('isUserFollowBusiness');
      if (opts.followerCheckError) throw opts.followerCheckError;
      return opts.isFollower ?? null;
    },
  } as unknown as InstagramSender;

  const ctx: HandlerContext = {
    account: opts.account ?? buildAccount(),
    prisma,
    instagram,
    ...(opts.now ? { now: opts.now } : {}),
  };

  return { ctx, calls, events, getConversation: () => conversation, formSentData: () => formSentData, rollbackData: () => rollbackData };
}

// ── 정상 흐름 ──────────────────────────────────────────────────────

test('정상 흐름: 선점 성공 → 캠페인 문구로 발송 → FORM_SENT → FOLLOW_UP_SENT 기록', async () => {
  const campaign = buildCampaign({ id: 'camp_1', followUpText: '캠페인 후속 문구' });
  const { ctx, calls, events, getConversation } = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_1', lastCampaignId: 'camp_1' },
    campaigns: { camp_1: campaign },
    now: () => 1000,
  });

  await handleMessage(buildEvent(), ctx);

  assert.equal(getConversation()?.state, 'FORM_SENT');
  assert.ok(calls.includes('sendMessage'));

  const followUpEvent = events.find((e) => e.type === 'FOLLOW_UP_SENT');
  assert.ok(followUpEvent, 'FOLLOW_UP_SENT 가 기록되어야 한다');
  assert.equal(followUpEvent?.campaignId, 'camp_1');
  assert.equal(followUpEvent?.mediaId, 'media_1');
  assert.equal(followUpEvent?.igsid, IGSID);
  assert.equal(typeof followUpEvent?.latencyMs, 'number');
});

test('count === 0 (대화가 없거나 이미 보냄) → sendMessage 0회 호출되고 DUPLICATE 기록', async () => {
  // 대화 자체가 없는 경우
  const noConversation = buildCtx({ conversation: null });
  await handleMessage(buildEvent(), noConversation.ctx);
  assert.equal(noConversation.calls.filter((c) => c === 'sendMessage').length, 0);
  const skipped1 = noConversation.events.find((e) => e.type === 'COMMENT_SKIPPED');
  assert.equal(skipped1?.skipReason, 'DUPLICATE');

  // 이미 양식을 보낸 경우 (state 가 WAITING_USER_MESSAGE 가 아님)
  const alreadySent = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'FORM_SENT', lastMediaId: 'media_1', lastCampaignId: null },
  });
  await handleMessage(buildEvent(), alreadySent.ctx);
  assert.equal(alreadySent.calls.filter((c) => c === 'sendMessage').length, 0);
  const skipped2 = alreadySent.events.find((e) => e.type === 'COMMENT_SKIPPED');
  assert.equal(skipped2?.skipReason, 'DUPLICATE');
  // 상태를 건드리지 않았어야 한다
  assert.equal(alreadySent.getConversation()?.state, 'FORM_SENT');
});

test('lastCampaignId 가 가리키는 캠페인의 followUpText 가 실제로 발송된다 (게시물별 문구)', async () => {
  const sentTexts: string[] = [];
  const campaignA = buildCampaign({ id: 'camp_A', followUpText: 'A 캠페인 후속 문구' });
  const campaignB = buildCampaign({ id: 'camp_B', followUpText: 'B 캠페인 후속 문구' });

  const runFor = async (campaignId: string, campaigns: Record<string, HandlerCampaign>) => {
    const { ctx } = buildCtx({
      conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_x', lastCampaignId: campaignId },
      campaigns,
      sendMessageImpl: async (_igsid, text) => {
        sentTexts.push(text);
        return { recipientId: _igsid, messageId: 'm' };
      },
    });
    await handleMessage(buildEvent(), ctx);
  };

  await runFor('camp_A', { camp_A: campaignA, camp_B: campaignB });
  await runFor('camp_B', { camp_A: campaignA, camp_B: campaignB });

  assert.deepEqual(sentTexts, ['A 캠페인 후속 문구', 'B 캠페인 후속 문구']);
});

test('lastCampaignId 가 null 이면 계정 기본 문구로 발송한다', async () => {
  let sentText = '';
  const { ctx } = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: null, lastCampaignId: null },
    account: buildAccount({ defaultFollowUpText: '계정 기본 후속 문구' }),
    sendMessageImpl: async (_igsid, text) => {
      sentText = text;
      return { recipientId: _igsid, messageId: 'm' };
    },
  });

  await handleMessage(buildEvent(), ctx);

  assert.equal(sentText, '계정 기본 후속 문구');
});

// ── 실패 경로 ──────────────────────────────────────────────────────

test('retryable 실패 → 상태가 WAITING_USER_MESSAGE 로 롤백되고 throw 된다', async () => {
  const retryableError = new InstagramApiError('일시적 오류', { status: 500, retryable: true });
  const { ctx, calls, events, getConversation } = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_1', lastCampaignId: null },
    sendMessageImpl: async () => {
      throw retryableError;
    },
  });

  await assert.rejects(() => handleMessage(buildEvent(), ctx), retryableError);

  assert.ok(calls.includes('rollback'), '롤백 updateMany 가 호출되어야 한다');
  assert.equal(getConversation()?.state, 'WAITING_USER_MESSAGE');

  const failedEvent = events.find((e) => e.type === 'FAILED');
  assert.ok(failedEvent, 'FAILED 가 기록되어야 한다');
});

test('non-retryable 실패 → 롤백하지 않고 throw 도 하지 않는다', async () => {
  const permanentError = new InstagramApiError('토큰 만료', { status: 401, retryable: false });
  const { ctx, calls, events, getConversation } = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_1', lastCampaignId: null },
    sendMessageImpl: async () => {
      throw permanentError;
    },
  });

  await assert.doesNotReject(() => handleMessage(buildEvent(), ctx));

  assert.ok(!calls.includes('rollback'), '롤백 updateMany 가 호출되면 안 된다');
  // FORM_SENT 로 확정되지도 않는다 — USER_REPLIED 에 머문다
  assert.equal(getConversation()?.state, 'USER_REPLIED');

  const failedEvent = events.find((e) => e.type === 'FAILED');
  assert.ok(failedEvent, 'FAILED 가 기록되어야 한다');
});

// ── 순서·기록 ──────────────────────────────────────────────────────

test('선점(claim)이 발송(sendMessage)보다 먼저 일어난다', async () => {
  const { ctx, calls } = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_1', lastCampaignId: null },
  });

  await handleMessage(buildEvent(), ctx);

  const claimIdx = calls.indexOf('claim');
  const sendIdx = calls.indexOf('sendMessage');
  assert.ok(claimIdx !== -1 && sendIdx !== -1);
  assert.ok(claimIdx < sendIdx, '선점이 발송보다 먼저 일어나야 한다');
});

test('각 분기마다 Event 가 기록된다', async () => {
  // 정상 흐름: USER_REPLIED → FOLLOW_UP_SENT
  const normal = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_1', lastCampaignId: null },
  });
  await handleMessage(buildEvent(), normal.ctx);
  assert.deepEqual(normal.events.map((e) => e.type), ['USER_REPLIED', 'FOLLOW_UP_SENT']);

  // 중복: USER_REPLIED → COMMENT_SKIPPED
  const dup = buildCtx({ conversation: null });
  await handleMessage(buildEvent(), dup.ctx);
  assert.deepEqual(dup.events.map((e) => e.type), ['USER_REPLIED', 'COMMENT_SKIPPED']);

  // retryable 실패: USER_REPLIED → FAILED
  const retryable = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_1', lastCampaignId: null },
    sendMessageImpl: async () => {
      throw new InstagramApiError('일시적 오류', { status: 500, retryable: true });
    },
  });
  await assert.rejects(() => handleMessage(buildEvent(), retryable.ctx));
  assert.deepEqual(retryable.events.map((e) => e.type), ['USER_REPLIED', 'FAILED']);

  // non-retryable 실패: USER_REPLIED → FAILED
  const permanent = buildCtx({
    conversation: { igAccountId: ACCOUNT_ID, igsid: IGSID, state: 'WAITING_USER_MESSAGE', lastMediaId: 'media_1', lastCampaignId: null },
    sendMessageImpl: async () => {
      throw new InstagramApiError('토큰 만료', { status: 401, retryable: false });
    },
  });
  await handleMessage(buildEvent(), permanent.ctx);
  assert.deepEqual(permanent.events.map((e) => e.type), ['USER_REPLIED', 'FAILED']);
});

test('예상 밖 예외도 롤백하고 throw 한다 — comment 핸들러와 같은 정책', async () => {
  // InstagramApiError 가 아닌 예외를 삼키면 대화가 USER_REPLIED 로 굳는다.
  // 재드라이브해도 조건부 UPDATE 에 걸려 그 사용자는 영원히 양식을 못 받는다.
  const bug = new TypeError('예상 못 한 버그');
  const { ctx, calls, events, getConversation } = buildCtx({
    conversation: {
      igAccountId: ACCOUNT_ID,
      igsid: IGSID,
      state: 'WAITING_USER_MESSAGE',
      lastMediaId: 'media_1',
      lastCampaignId: null,
    },
    sendMessageImpl: async () => {
      throw bug;
    },
  });

  await assert.rejects(() => handleMessage(buildEvent(), ctx), bug);

  assert.ok(calls.includes('rollback'), `롤백이 호출되어야 한다. 실제: ${calls.join(' → ')}`);
  assert.equal(getConversation()?.state, 'WAITING_USER_MESSAGE');
  assert.ok(
    events.find((e) => e.type === 'FAILED'),
    'FAILED 가 기록되어야 한다',
  );
});

test('테넌트 격리: lastCampaignId 가 다른 계정 소유 캠페인을 가리키면 그 문구를 쓰지 않는다', async () => {
  // 정상 경로에서는 있을 수 없다 — comment.handler.ts 는 항상 자기 계정의 캠페인만
  // lastCampaignId 에 쓴다. 하지만 findFirst 에 igAccountId 필터가 빠지면 이 시나리오에서
  // 남의 계정 문구가 새어 나간다. 그 방어선이 실제로 동작하는지 확인한다.
  const foreignCampaign = buildCampaign({ id: 'camp_other', followUpText: '남의 계정 문구 — 절대 나가면 안 됨' });
  const { ctx, calls } = buildCtx({
    conversation: {
      igAccountId: ACCOUNT_ID,
      igsid: IGSID,
      state: 'WAITING_USER_MESSAGE',
      lastMediaId: 'media_1',
      lastCampaignId: 'camp_other',
    },
    campaigns: { camp_other: foreignCampaign },
    campaignOwners: { camp_other: 'acc_다른계정' },
    account: buildAccount({ defaultFollowUpText: '계정 기본 후속 문구' }),
    sendMessageImpl: async (_igsid, text) => {
      assert.notEqual(text, foreignCampaign.followUpText, '남의 계정 캠페인 문구가 나가면 안 된다');
      assert.equal(text, '계정 기본 후속 문구', '계정 스코프에 없으니 계정 기본값으로 폴백해야 한다');
      return { recipientId: 'r', messageId: 'm' };
    },
  });

  await handleMessage(buildEvent(), ctx);
  assert.ok(calls.includes('findCampaign'));
  assert.ok(calls.includes('sendMessage'), '검증은 sendMessageImpl 안에서 이뤄진다');
});

// ── 팔로워 캐시 채우기 ────────────────────────────────────────────
//
// is_user_follow_business 는 대화 성립 후에만 조회된다(meta-api.md §1-13).
// 답장을 받은 지금이 유일한 기회라 여기서 찍어 Conversation 에 저장한다.

test('답장을 받으면 팔로워 여부를 조회해 대화에 캐시한다', async () => {
  const f = buildCtx({ isFollower: true, now: () => 5000 });
  await handleMessage(buildEvent(), f.ctx);

  assert.ok(f.calls.includes('isUserFollowBusiness'));
  const data = f.formSentData() as Record<string, unknown>;
  assert.equal(data.state, 'FORM_SENT');
  assert.equal(data.isFollower, true);
  assert.deepEqual(data.followerCheckedAt, new Date(5000));
});

test('비팔로워도 그대로 캐시한다 — 매번 다시 묻지 않기 위해', async () => {
  const f = buildCtx({ isFollower: false, now: () => 5000 });
  await handleMessage(buildEvent(), f.ctx);

  const data = f.formSentData() as Record<string, unknown>;
  assert.equal(data.isFollower, false);
});

// 값을 못 얻었는데 checkedAt 만 새로 찍으면 "모름" 이 TTL 동안 굳는다.
test('값을 못 얻으면 캐시 필드를 건드리지 않는다', async () => {
  const f = buildCtx({ isFollower: null });
  await handleMessage(buildEvent(), f.ctx);

  const data = f.formSentData() as Record<string, unknown>;
  assert.equal(data.state, 'FORM_SENT');
  assert.ok(!('isFollower' in data));
  assert.ok(!('followerCheckedAt' in data));
});

// 양식은 이미 나갔다. 부가 정보 하나 때문에 SQS 재시도를 유발하면 조건부 UPDATE 에
// 걸려 그 사용자는 양식을 다시 받지 못한다.
test('팔로워 조회가 실패해도 throw 하지 않고 FOLLOW_UP_SENT 는 남는다', async () => {
  const f = buildCtx({ followerCheckError: new Error('boom') });
  await handleMessage(buildEvent(), f.ctx);

  assert.ok(f.events.some((e) => e.type === 'FOLLOW_UP_SENT'));
  assert.ok(f.calls.includes('formSent'));
});

test('FOLLOW_UP_SENT 에 조회 시점의 팔로워 여부를 박제한다', async () => {
  const f = buildCtx({ isFollower: true });
  await handleMessage(buildEvent(), f.ctx);

  const sent = f.events.find((e) => e.type === 'FOLLOW_UP_SENT');
  assert.equal(sent?.isFollower, true);
});

// ── 팔로워 게이트 (옵션) ──────────────────────────────────────────
//
// 기본은 꺼져 있다. nonFollowerText 를 넣은 계정에서만 동작한다.

const gateAccount = (text: string | null) => buildAccount({ nonFollowerText: text });

test('게이트가 꺼져 있으면(기본) 비팔로워도 양식을 받는다', async () => {
  const f = buildCtx({ isFollower: false });
  await handleMessage(buildEvent(), f.ctx);

  assert.ok(f.events.some((e) => e.type === 'FOLLOW_UP_SENT'));
});

test('게이트가 켜져 있고 비팔로워면 양식 대신 게이트 문구가 나간다', async () => {
  const sent: string[] = [];
  const f = buildCtx({
    account: gateAccount('먼저 팔로우해주세요!'),
    isFollower: false,
    sendMessageImpl: async (r, text) => {
      sent.push(text);
      return { recipientId: r, messageId: 'm' };
    },
  });

  await handleMessage(buildEvent(), f.ctx);

  assert.deepEqual(sent, ['먼저 팔로우해주세요!']);
  assert.ok(!f.events.some((e) => e.type === 'FOLLOW_UP_SENT'), '양식은 안 나갔다');
  const skip = f.events.find((e) => e.type === 'COMMENT_SKIPPED');
  assert.equal(skip?.skipReason, 'NOT_FOLLOWER');
});

// FORM_SENT 로 굳히면 팔로우한 뒤에도 영영 양식을 못 받는다.
test('게이트에 막히면 대화를 WAITING_USER_MESSAGE 로 되돌려 재시도 여지를 남긴다', async () => {
  const f = buildCtx({ account: gateAccount('먼저 팔로우해주세요!'), isFollower: false });
  await handleMessage(buildEvent(), f.ctx);

  assert.equal(f.getConversation()?.state, 'WAITING_USER_MESSAGE');
});

test('게이트가 켜져 있어도 팔로워면 양식을 받는다', async () => {
  const f = buildCtx({ account: gateAccount('먼저 팔로우해주세요!'), isFollower: true });
  await handleMessage(buildEvent(), f.ctx);

  assert.ok(f.events.some((e) => e.type === 'FOLLOW_UP_SENT'));
});

// 조회가 한 번 실패했다고 정상 사용자를 막는 쪽이 훨씬 나쁘다.
test('팔로워 여부를 모르면 게이트가 켜져 있어도 막지 않는다', async () => {
  const f = buildCtx({ account: gateAccount('먼저 팔로우해주세요!'), isFollower: null });
  await handleMessage(buildEvent(), f.ctx);

  assert.ok(f.events.some((e) => e.type === 'FOLLOW_UP_SENT'));
});

test('게이트 문구가 공백뿐이면 게이트가 없는 것으로 본다', async () => {
  const f = buildCtx({ account: gateAccount('   '), isFollower: false });
  await handleMessage(buildEvent(), f.ctx);

  assert.ok(f.events.some((e) => e.type === 'FOLLOW_UP_SENT'));
});

test('게이트에 막혀도 팔로워 캐시는 저장된다 — 매번 다시 묻지 않기 위해', async () => {
  const f = buildCtx({ account: gateAccount('먼저 팔로우해주세요!'), isFollower: false, now: () => 7000 });
  await handleMessage(buildEvent(), f.ctx);

  const data = f.rollbackData() as Record<string, unknown>;
  assert.equal(data.state, 'WAITING_USER_MESSAGE');
  assert.equal(data.isFollower, false);
  assert.deepEqual(data.followerCheckedAt, new Date(7000));
});

// ── 빠른 경로 사용자의 캐시 갱신 ──────────────────────────────────
//
// 확인 단계를 건너뛴 사람은 대화가 FORM_SENT 로 시작하므로 조건부 UPDATE 에 항상 걸린다.
// 그 경로에서 캐시를 갱신하지 않으면, 최적화 대상인 단골에게서만 캐시가 만료되고
// 다시는 갱신되지 않는 자기모순이 된다.

test('양식을 이미 보낸 사람의 답장에서도 캐시가 만료됐으면 갱신한다', async () => {
  const f = buildCtx({
    conversation: {
      igAccountId: ACCOUNT_ID,
      igsid: IGSID,
      state: 'FORM_SENT',
      lastMediaId: 'media_1',
      lastCampaignId: null,
    } as never,
    isFollower: true,
  });

  await handleMessage(buildEvent(), f.ctx);

  assert.ok(f.calls.includes('isUserFollowBusiness'), '만료된 캐시는 다시 조회한다');
  assert.ok(!f.calls.includes('sendMessage'), '양식을 다시 보내지는 않는다');
});

// 답장 하나마다 API 를 한 번씩 쓰면 캐시를 둔 의미가 없다.
test('캐시가 신선하면 다시 조회하지 않는다', async () => {
  const f = buildCtx({
    conversation: {
      igAccountId: ACCOUNT_ID,
      igsid: IGSID,
      state: 'FORM_SENT',
      lastMediaId: 'media_1',
      lastCampaignId: null,
      isFollower: true,
      followerCheckedAt: new Date(Date.now() - 1000),
    } as never,
    isFollower: true,
  });

  await handleMessage(buildEvent(), f.ctx);

  assert.ok(!f.calls.includes('isUserFollowBusiness'));
});

// 비팔로워도 확인은 신선하다. 뭉쳐서 판단하면 그 사람 답장마다 조회가 나간다.
test('비팔로워로 확인된 신선한 캐시도 다시 조회하지 않는다', async () => {
  const f = buildCtx({
    conversation: {
      igAccountId: ACCOUNT_ID,
      igsid: IGSID,
      state: 'FORM_SENT',
      lastMediaId: 'media_1',
      lastCampaignId: null,
      isFollower: false,
      followerCheckedAt: new Date(Date.now() - 1000),
    } as never,
    isFollower: false,
  });

  await handleMessage(buildEvent(), f.ctx);

  assert.ok(!f.calls.includes('isUserFollowBusiness'));
});
