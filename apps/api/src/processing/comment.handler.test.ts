import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleComment } from './comment.handler.ts';
import type { HandlerAccount, HandlerCampaign, HandlerContext, EventInput } from './context.ts';
import { InstagramApiError } from '../instagram/errors.ts';
import type { CommentEvent } from '../webhook/normalize.ts';
import { FOLLOWER_TTL_MS, NON_FOLLOWER_TTL_MS } from './follower-cache.ts';

// ── 픽스처 ────────────────────────────────────────────────────────

const account: HandlerAccount = {
  id: 'acc_1',
  igUserId: '17841400000000000',
  defaultPrivateReplyText: '계정 기본 문구',
  defaultFollowUpText: '계정 기본 후속 문구',
  defaultCommentReplyText: null, // 기본은 대댓글 없음 (opt-in)
  nonFollowerText: null, // 기본은 게이트 없음 (opt-in)
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
  /** 기존 대화 = 팔로워 캐시. null 이면 처음 보는 사람. */
  conversation?: { isFollower: boolean | null; followerCheckedAt: Date | null } | null;
  /** isUserFollowBusiness 가 돌려줄 값. 만료된 캐시를 다시 조회할 때만 쓰인다. */
  liveIsFollower?: boolean | null;
  createSentReplyError?: unknown;
  sendPrivateReplyError?: unknown;
  replyToCommentError?: unknown;
  commentReplyText?: string | null;
  nowSequence?: number[];
} = {}) {
  const calls: string[] = [];
  const events: EventInput[] = [];
  let deleteCalled = false;
  let upsertArgs: unknown = undefined;
  let sentReplyCreateArgs: unknown = undefined;
  let sentReplyDeleteArgs: unknown = undefined;
  const commentReplies: { commentId: string; message: string }[] = [];
  const privateReplies: string[] = [];
  let cacheWrite: unknown = undefined;
  let nowIdx = 0;
  const nowSequence = opts.nowSequence ?? [1000, 1500];

  const ctx: HandlerContext = {
    account:
      opts.commentReplyText === undefined
        ? account
        : { ...account, defaultCommentReplyText: opts.commentReplyText },
    prisma: {
      campaign: {
        // biome-ignore lint: 테스트 전용 최소 구현
        findUnique: async () => {
          calls.push('campaign.findUnique');
          return opts.campaign === undefined ? campaign : opts.campaign;
        },
      },
      sentReply: {
        create: async (args: unknown) => {
          calls.push('sentReply.create');
          sentReplyCreateArgs = args;
          if (opts.createSentReplyError) throw opts.createSentReplyError;
          return {} as never;
        },
        delete: async (args: unknown) => {
          calls.push('sentReply.delete');
          sentReplyDeleteArgs = args;
          deleteCalled = true;
          return {} as never;
        },
      },
      conversation: {
        updateMany: async (args: unknown) => {
          calls.push('conversation.updateMany');
          cacheWrite = args;
          return { count: 1 } as never;
        },
        findUnique: async () => {
          calls.push('conversation.findUnique');
          return opts.conversation ?? null;
        },
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
      sendPrivateReply: async (_commentId: string, text: string) => {
        calls.push('sendPrivateReply');
        privateReplies.push(text);
        if (opts.sendPrivateReplyError) throw opts.sendPrivateReplyError;
        return { recipientId: 'igsid_1', messageId: 'mid_1' };
      },
      isUserFollowBusiness: async () => {
        calls.push('isUserFollowBusiness');
        return opts.liveIsFollower ?? null;
      },
      sendMessage: async () => {
        throw new Error('이 테스트에서는 쓰이지 않는다');
      },
      replyToComment: async (commentId: string, message: string) => {
        calls.push('replyToComment');
        if (opts.replyToCommentError) throw opts.replyToCommentError;
        commentReplies.push({ commentId, message });
        return { id: 'reply_1' };
      },
      // biome-ignore lint: InstagramSender 표면만 필요
    } as unknown as HandlerContext['instagram'],
    now: () => nowSequence[Math.min(nowIdx++, nowSequence.length - 1)] ?? 0,
  };

  return {
    ctx,
    calls,
    events,
    commentReplies,
    privateReplies,
    cacheWrite: () => cacheWrite,
    deleteCalled: () => deleteCalled,
    upsertArgs: () => upsertArgs,
    sentReplyCreateArgs: () => sentReplyCreateArgs,
    sentReplyDeleteArgs: () => sentReplyDeleteArgs,
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

// 마커의 뜻은 "이미 보냈다" 하나뿐이다. 발송이 실패했으면 안 보낸 것이므로 되돌린다.
// 키가 (계정, 사람, 게시물)이 되면서 남겨두는 비용이 완전히 달라졌다 — commentId 키에서는
// 그 댓글 하나가 손해였지만, 지금은 **그 사람이 그 게시물에서 영영 못 받는다.**
// 토큰이 잠깐 403(비재시도로 분류)이었다가 복구된 경우까지 영구 소각된다.
test('non-retryable 실패면 throw 하지 않지만 마커는 되돌린다', async () => {
  const permanentError = new InstagramApiError('만료된 창', { status: 400, retryable: false });
  const f = createFakeCtx({ sendPrivateReplyError: permanentError });

  await assert.doesNotReject(() => handleComment(baseEvent, f.ctx));

  assert.ok(f.deleteCalled(), '마커를 지워야 나중에 같은 사람이 같은 글에서 다시 받을 수 있다');
  assert.deepEqual(f.sentReplyDeleteArgs(), {
    where: { igAccountId_igsid_mediaId: { igAccountId: 'acc_1', igsid: 'igsid_1', mediaId: 'media_1' } },
  });
  assert.ok(!f.calls.includes('conversation.upsert'));
  const failedEvent = f.events.find((e) => e.type === 'FAILED');
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

// ── 멱등성 키: (계정, 사람, 게시물) ────────────────────────────────
//
// 키가 commentId 였을 때는 같은 사람이 같은 글에 댓글을 또 달면 새 ID 라 DM 이 또 나갔다.
// Meta 의 "댓글당 1회" 제한(meta-api.md §1-9)은 새 댓글을 새로 허용하므로 막아주지 않는다.

test('마커는 commentId 가 아니라 (igAccountId, igsid, mediaId) 로 선점한다', async () => {
  const f = createFakeCtx();
  await handleComment(baseEvent, f.ctx);

  const args = f.sentReplyCreateArgs() as { data: Record<string, string> };
  assert.deepEqual(args.data, {
    igAccountId: 'acc_1',
    igsid: 'igsid_1',
    mediaId: 'media_1',
    commentId: 'comment_1', // 추적용으로 남기지만 키는 아니다
  });
});

test('같은 사람이 같은 글에 단 두 번째 댓글은 commentId 가 달라도 DUPLICATE 로 막힌다', async () => {
  // 실제 DB 라면 (acc_1, igsid_1, media_1) 이 이미 있어 P2002 가 난다.
  const f = createFakeCtx({ createSentReplyError: P2002 });
  const secondComment: CommentEvent = { ...baseEvent, commentId: 'comment_2' };

  await handleComment(secondComment, f.ctx);

  assert.ok(!f.calls.includes('sendPrivateReply'), '두 번째 댓글에는 DM 을 보내지 않는다');
  const skip = f.events.find((e) => e.type === 'COMMENT_SKIPPED');
  assert.equal(skip?.skipReason, 'DUPLICATE');
});

test('같은 사람이 다른 글에 달면 발송한다 — 게시물별로 1회이기 때문', async () => {
  const f = createFakeCtx({ campaign: null });
  const otherMedia: CommentEvent = { ...baseEvent, commentId: 'comment_9', mediaId: 'media_2' };

  await handleComment(otherMedia, f.ctx);

  assert.ok(f.calls.includes('sendPrivateReply'));
  const args = f.sentReplyCreateArgs() as { data: Record<string, string> };
  assert.equal(args.data.mediaId, 'media_2');
});

test('retryable 롤백도 같은 복합키로 삭제한다', async () => {
  const retryable = new InstagramApiError('429', { status: 429, retryable: true });
  const f = createFakeCtx({ sendPrivateReplyError: retryable });

  await assert.rejects(() => handleComment(baseEvent, f.ctx));

  assert.deepEqual(f.sentReplyDeleteArgs(), {
    where: { igAccountId_igsid_mediaId: { igAccountId: 'acc_1', igsid: 'igsid_1', mediaId: 'media_1' } },
  });
});

// ── 공개 대댓글 ───────────────────────────────────────────────────

test('계정에 대댓글 문구가 있으면 발송 후 그 댓글에 대댓글을 단다', async () => {
  const f = createFakeCtx({ commentReplyText: 'DM 발송 완료!' });
  await handleComment(baseEvent, f.ctx);

  assert.deepEqual(f.commentReplies, [{ commentId: 'comment_1', message: 'DM 발송 완료!' }]);
});

test('대댓글은 DM 발송과 PRIVATE_REPLY_SENT 기록이 끝난 뒤에 일어난다', async () => {
  const f = createFakeCtx({ commentReplyText: 'DM 발송 완료!' });
  await handleComment(baseEvent, f.ctx);

  assert.ok(
    f.calls.indexOf('sendPrivateReply') < f.calls.indexOf('replyToComment'),
    '주 동작이 먼저다',
  );
  assert.equal(f.calls[f.calls.length - 1], 'replyToComment', '대댓글이 마지막이다');
});

test('대댓글 문구가 없으면(기본값) 호출하지 않는다 — 설정 안 한 사용자의 동작은 그대로', async () => {
  const f = createFakeCtx(); // defaultCommentReplyText: null
  await handleComment(baseEvent, f.ctx);

  assert.ok(!f.calls.includes('replyToComment'));
});

test('대댓글 문구가 공백뿐이면 호출하지 않는다', async () => {
  const f = createFakeCtx({ commentReplyText: '   ' });
  await handleComment(baseEvent, f.ctx);

  assert.ok(!f.calls.includes('replyToComment'));
});

// 부가 동작이 주 동작을 되돌리면 안 된다. 던지면 SQS 가 재시도해서 DUPLICATE 만 쌓인다.
test('대댓글이 실패해도 throw 하지 않고 PRIVATE_REPLY_SENT 는 그대로 남는다', async () => {
  const f = createFakeCtx({
    commentReplyText: 'DM 발송 완료!',
    replyToCommentError: new InstagramApiError('400', { status: 400, retryable: false }),
  });

  await handleComment(baseEvent, f.ctx); // 던지지 않아야 한다

  assert.ok(f.events.some((e) => e.type === 'PRIVATE_REPLY_SENT'));
  assert.ok(!f.events.some((e) => e.type === 'FAILED'), '대댓글 실패를 FAILED 로 오염시키지 않는다');
  assert.ok(!f.deleteCalled(), '멱등성 마커를 되돌리지 않는다');
});

// ── 팔로워 캐시로 확인 단계 건너뛰기 ─────────────────────────────
//
// is_user_follow_business 는 대화 성립 후에만 조회되므로(meta-api.md §1-13) 댓글
// 단계에서 새로 물어볼 수 없다. 지난 답장 때 저장해둔 캐시가 유일한 근거다.

const freshFollower = { isFollower: true, followerCheckedAt: new Date(1000 - 60_000) };

test('팔로워로 확인된 사람에게는 확인 문구 대신 양식을 바로 보낸다', async () => {
  const f = createFakeCtx({ conversation: freshFollower });
  await handleComment(baseEvent, f.ctx);

  assert.deepEqual(f.privateReplies, ['캠페인 후속 문구'], '1차 발송이 곧 양식이다');
});

test('건너뛴 경우 대화는 곧바로 FORM_SENT 가 된다', async () => {
  const f = createFakeCtx({ conversation: freshFollower });
  await handleComment(baseEvent, f.ctx);

  const args = f.upsertArgs() as { create: { state: string }; update: { state: string } };
  assert.equal(args.create.state, 'FORM_SENT');
  assert.equal(args.update.state, 'FORM_SENT');
});

// 안 남기면 Phase 3 퍼널에서 "1차는 갔는데 양식이 안 나간 사람" 으로 잘못 집계된다.
test('건너뛴 경우 PRIVATE_REPLY_SENT 와 FOLLOW_UP_SENT 를 모두 기록한다', async () => {
  const f = createFakeCtx({ conversation: freshFollower });
  await handleComment(baseEvent, f.ctx);

  assert.ok(f.events.some((e) => e.type === 'PRIVATE_REPLY_SENT' && e.isFollower === true));
  assert.ok(f.events.some((e) => e.type === 'FOLLOW_UP_SENT' && e.isFollower === true));
});

test('캐시가 만료됐으면 기존 2단계로 간다', async () => {
  const stale = { isFollower: true, followerCheckedAt: new Date(1000 - FOLLOWER_TTL_MS - 1) };
  const f = createFakeCtx({ conversation: stale });
  await handleComment(baseEvent, f.ctx);

  assert.deepEqual(f.privateReplies, ['캠페인 문구']);
  const args = f.upsertArgs() as { create: { state: string } };
  assert.equal(args.create.state, 'WAITING_USER_MESSAGE');
});

test('비팔로워로 확인된 사람도 기존 2단계로 간다', async () => {
  const f = createFakeCtx({ conversation: { isFollower: false, followerCheckedAt: new Date(1000) } });
  await handleComment(baseEvent, f.ctx);

  assert.deepEqual(f.privateReplies, ['캠페인 문구']);
});

test('처음 보는 사람은 기존 2단계로 간다', async () => {
  const f = createFakeCtx({ conversation: null });
  await handleComment(baseEvent, f.ctx);

  assert.deepEqual(f.privateReplies, ['캠페인 문구']);
  assert.ok(!f.events.some((e) => e.type === 'FOLLOW_UP_SENT'));
});


// ── 만료된 캐시는 댓글 시점에 다시 물어본다 ──────────────────────
//
// 실사용에서 나온 시나리오다. 1차 DM 이 "팔로우 확인할게요" 라고 시켰고, 사용자가 팔로우한
// 뒤 새 게시물에 댓글을 달았는데 **같은 확인 문구가 또 나갔다.** 캐시가 false 로 신선했고
// 댓글 경로는 캐시를 읽기만 했기 때문이다. false 의 TTL 을 짧게 잡고 여기서 재조회한다.

const staleFalse = { isFollower: false, followerCheckedAt: new Date(1000 - NON_FOLLOWER_TTL_MS - 1) };

test('캐시가 false 로 만료됐고 그 사이 팔로우했으면 다시 조회해 빠른 경로를 탄다', async () => {
  const f = createFakeCtx({ conversation: staleFalse, liveIsFollower: true });
  await handleComment(baseEvent, f.ctx);

  assert.ok(f.calls.includes('isUserFollowBusiness'), '만료됐으므로 다시 물어본다');
  assert.deepEqual(f.privateReplies, ['캠페인 후속 문구'], '확인 문구 없이 양식이 바로 나간다');
});

test('재조회 결과를 캐시에 다시 쓴다 — 다음 댓글에서 또 묻지 않도록', async () => {
  const f = createFakeCtx({ conversation: staleFalse, liveIsFollower: true });
  await handleComment(baseEvent, f.ctx);

  const w = f.cacheWrite() as { data: Record<string, unknown> };
  assert.equal(w.data.isFollower, true);
  assert.deepEqual(w.data.followerCheckedAt, new Date(1000));
});

// 답장할 때마다가 아니라 만료됐을 때만 물어봐야 캐시를 둔 의미가 있다.
test('캐시가 신선하면 댓글 시점에 조회하지 않는다', async () => {
  const f = createFakeCtx({
    conversation: { isFollower: false, followerCheckedAt: new Date(1000 - 60_000) },
    liveIsFollower: true,
  });
  await handleComment(baseEvent, f.ctx);

  assert.ok(!f.calls.includes('isUserFollowBusiness'));
  assert.deepEqual(f.privateReplies, ['캠페인 문구'], '신선한 false 를 믿고 2단계로 간다');
});

// 대화가 없으면 is_user_follow_business 자체가 조회되지 않는다 (meta-api.md §1-13).
test('처음 보는 사람에게는 조회를 시도조차 하지 않는다', async () => {
  const f = createFakeCtx({ conversation: null, liveIsFollower: true });
  await handleComment(baseEvent, f.ctx);

  assert.ok(!f.calls.includes('isUserFollowBusiness'));
  assert.deepEqual(f.privateReplies, ['캠페인 문구']);
});

// 조회가 실패했다고 캐시를 덮으면 "모름" 이 TTL 동안 굳는다.
test('재조회가 실패하면 캐시를 건드리지 않고 기존 값으로 판단한다', async () => {
  const f = createFakeCtx({ conversation: staleFalse, liveIsFollower: null });
  await handleComment(baseEvent, f.ctx);

  assert.ok(f.calls.includes('isUserFollowBusiness'));
  assert.equal(f.cacheWrite(), undefined, '캐시를 쓰지 않는다');
  assert.deepEqual(f.privateReplies, ['캠페인 문구']);
});
