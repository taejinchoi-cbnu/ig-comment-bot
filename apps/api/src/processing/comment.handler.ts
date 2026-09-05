/**
 * 댓글 이벤트 핸들러 — Private Reply 발송의 진입점.
 *
 * 처리 순서 (docs/architecture.md §멱등성 · §게시물별 문구):
 *  1. 캠페인 조회 (igAccountId + mediaId)
 *  2. 캠페인이 꺼져 있으면 중단. 캠페인이 없으면 중단하지 않고 계정 기본 문구로 진행한다.
 *  3. 문구·키워드 결정 (3단 폴백)
 *  4. 키워드 불일치면 중단
 *  5. COMMENT_RECEIVED 기록
 *  6. 멱등성 마커 선점 (SentReply.create) — 반드시 발송 전에. P2002 = 이미 보냄
 *  7. Private Reply 발송
 *     - retryable 실패: 마커를 delete 로 되돌리고 throw (SQS 재시도)
 *     - non-retryable 실패: 마커는 남겨두고 return (재시도해도 성공 못 하므로)
 *  8. 대화 상태 upsert (lastMediaId 가 게시물별 문구가 성립하는 이유)
 *  9. PRIVATE_REPLY_SENT 기록 (latencyMs 포함)
 *
 * 데코레이터를 쓰지 않는 평범한 함수로 유지한다 — Node 타입 스트리핑이
 * 데코레이터를 변환하지 못해 넣는 순간 `node --test` 가 깨진다.
 */

import type { CommentEvent } from '../webhook/normalize.ts';
import {
  extractErrorCode,
  type HandlerContext,
  isRetryableError,
  nowMs,
  recordEvent,
  refreshFollowerCache,
} from './context.ts';
import { resolveTemplates } from './templates.ts';
import { shouldTrigger } from './trigger.ts';
import { isKnownFollower } from './follower-cache.ts';

/** Prisma 의 unique 제약 위반(P2002) 여부를 구조적으로 판별한다. 생성된 코드를 값으로 import 하지 않는다. */
function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'P2002'
  );
}

export async function handleComment(event: CommentEvent, ctx: HandlerContext): Promise<void> {
  const { account } = ctx;

  const campaign = await ctx.prisma.campaign.findUnique({
    where: { igAccountId_mediaId: { igAccountId: account.id, mediaId: event.mediaId } },
  });

  // 캠페인이 있는데 꺼져 있을 때만 중단한다. 캠페인이 없으면(3단 폴백의 첫 단) 그대로 진행한다.
  if (campaign && campaign.enabled === false) {
    await recordEvent(ctx, {
      type: 'COMMENT_SKIPPED',
      skipReason: 'CAMPAIGN_DISABLED',
      campaignId: campaign.id,
      mediaId: event.mediaId,
      igsid: event.igsid,
      username: event.username,
    });
    return;
  }

  const templates = resolveTemplates(account, campaign);

  if (!shouldTrigger(event.text, templates.triggerKeywords)) {
    await recordEvent(ctx, {
      type: 'COMMENT_SKIPPED',
      skipReason: 'NO_KEYWORD_MATCH',
      campaignId: campaign?.id,
      mediaId: event.mediaId,
      igsid: event.igsid,
      username: event.username,
    });
    return;
  }

  await recordEvent(ctx, {
    type: 'COMMENT_RECEIVED',
    campaignId: campaign?.id,
    mediaId: event.mediaId,
    igsid: event.igsid,
    username: event.username,
  });

  // 멱등성 마커 선점. 반드시 발송 전에 — 발송 후에 쓰면 그 사이 재시도가 중복 발송을 만든다.
  //
  // 키는 (계정, 사람, 게시물) 이다. commentId 로 잡으면 같은 사람이 같은 글에 댓글을
  // 또 달 때마다 DM 이 나간다 — Meta 의 "댓글당 1회" 제한(meta-api.md §1-9)은 새 댓글을
  // 새로 허용하므로 막아주지 않는다. 여기가 유일한 방어선이다.
  try {
    await ctx.prisma.sentReply.create({
      data: {
        igAccountId: account.id,
        igsid: event.igsid,
        mediaId: event.mediaId,
        commentId: event.commentId,
      },
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      await recordEvent(ctx, {
        type: 'COMMENT_SKIPPED',
        skipReason: 'DUPLICATE',
        campaignId: campaign?.id,
        mediaId: event.mediaId,
        igsid: event.igsid,
        username: event.username,
      });
      return;
    }
    throw cause; // 예상 밖 DB 오류 — 숨기지 않는다
  }

  // 이미 팔로워로 확인된 사람이면 "팔로워인지 확인할게요" 를 건너뛰고 양식을 바로 보낸다.
  //
  // 그 확인은 여기서 할 수 없다 — is_user_follow_business 는 대화 성립 후에만 조회되므로
  // (docs/meta-api.md §1-13) 지난번 답장 때 message.handler 가 찍어둔 캐시가 유일한
  // 근거다. 캐시가 없거나 만료됐거나 비팔로워면 기존 2단계 그대로 간다.
  const existing = await ctx.prisma.conversation.findUnique({
    where: { igAccountId_igsid: { igAccountId: account.id, igsid: event.igsid } },
  });

  // 캐시 만료 판정과 발송 시작을 같은 시점으로 본다. 둘 사이는 분기 하나뿐이라
  // 차이가 무의미하고, now() 를 두 번 부르면 테스트에서 시퀀스만 어긋난다.
  const startedAt = nowMs(ctx);

  // 캐시가 만료됐으면 여기서 다시 물어본다. 1차 DM 이 "팔로우 확인할게요" 라고 시켜놓고
  // 시키는 대로 한 사람에게 또 같은 걸 묻는 걸 막는 지점이다 — false 는 TTL 이 짧아
  // (follower-cache.ts ttlFor) 팔로우 직후 댓글이 실제로 이 경로를 탄다.
  // 대화가 없는 사람에게는 조회 자체가 불가능하므로 그대로 2단계로 간다.
  const cache = await refreshFollowerCache(ctx, existing, event.igsid, startedAt);
  const skipConfirmation = isKnownFollower(cache, startedAt);
  const replyText = skipConfirmation ? templates.followUp : templates.privateReply;
  const nextState = skipConfirmation ? 'FORM_SENT' : 'WAITING_USER_MESSAGE';

  try {
    await ctx.instagram.sendPrivateReply(event.commentId, replyText);
  } catch (error) {
    const retryable = isRetryableError(error);

    await recordEvent(ctx, {
      type: 'FAILED',
      campaignId: campaign?.id,
      mediaId: event.mediaId,
      igsid: event.igsid,
      username: event.username,
      errorCode: extractErrorCode(error),
    });

    // 성공 여부와 무관하게 마커를 되돌린다. **마커의 뜻은 "이미 보냈다" 하나뿐이다** —
    // 발송이 실패했으면 안 보낸 것이므로 남겨둘 이유가 없다.
    //
    // 키가 commentId 였을 때는 non-retryable 에서 마커를 남겨도 손해가 그 댓글 하나였다.
    // 지금 키는 (계정, 사람, 게시물)이라 남겨두면 **그 사람은 그 게시물에서 영영 DM 을
    // 못 받는다.** 토큰이 잠깐 403(비재시도로 분류됨)이었다가 복구된 경우까지 영구 소각된다.
    // 중복 웹훅이 오면 실패한 호출을 한 번 더 쓰지만, 그쪽이 훨씬 싸다.
    await ctx.prisma.sentReply.delete({
      where: {
        igAccountId_igsid_mediaId: {
          igAccountId: account.id,
          igsid: event.igsid,
          mediaId: event.mediaId,
        },
      },
    });

    if (retryable) throw error; // SQS 가 재시도한다

    // non-retryable: 재시도해도 성공하지 않으므로 throw 하지 않는다.
    // throw 하면 5회 재시도 후 DLQ 로 가서 노이즈만 만든다.
    return;
  }

  await ctx.prisma.conversation.upsert({
    where: { igAccountId_igsid: { igAccountId: account.id, igsid: event.igsid } },
    create: {
      igAccountId: account.id,
      igsid: event.igsid,
      // 양식을 이미 보냈으면 답장을 기다릴 이유가 없다. 이 상태로 두면 그 사람이
      // 답장할 때 message.handler 의 조건부 UPDATE 가 걸러 양식이 두 번 나가지 않는다.
      state: nextState,
      lastCommentId: event.commentId,
      lastMediaId: event.mediaId, // ← 게시물별 문구가 성립하는 이유 (docs/architecture.md §게시물별 문구)
      lastCampaignId: campaign?.id ?? null,
    },
    update: {
      state: nextState,
      lastCommentId: event.commentId,
      lastMediaId: event.mediaId,
      lastCampaignId: campaign?.id ?? null,
    },
  });

  await recordEvent(ctx, {
    type: 'PRIVATE_REPLY_SENT',
    campaignId: campaign?.id,
    mediaId: event.mediaId,
    igsid: event.igsid,
    username: event.username,
    latencyMs: nowMs(ctx) - startedAt,
    ...(skipConfirmation ? { isFollower: true } : {}),
  });

  // 확인 단계를 건너뛰었다면 이 한 번으로 양식까지 나간 것이므로 퍼널에도 그렇게 남긴다.
  // 안 남기면 Phase 3 에서 "1차는 갔는데 양식이 안 나간 사람" 으로 잘못 집계된다.
  if (skipConfirmation) {
    await recordEvent(ctx, {
      type: 'FOLLOW_UP_SENT',
      campaignId: campaign?.id,
      mediaId: event.mediaId,
      igsid: event.igsid,
      username: event.username,
      isFollower: true,
    });
  }

  await replyToCommentBestEffort(ctx, event.commentId, account.defaultCommentReplyText);
}

/**
 * DM 을 보낸 뒤 그 댓글에 공개로 한 줄 답니다. Private Reply 는 상대의 "요청" 탭으로
 * 들어가서 받은 줄 모르는 경우가 많기 때문입니다.
 *
 * **절대 던지지 않습니다.** 여기 도달했다는 건 DM 이 이미 나갔다는 뜻이고, 던지면 SQS 가
 * 재시도해서 `DUPLICATE` 스킵만 쌓입니다. 부가 동작이 주 동작을 되돌릴 수 없어야 합니다.
 *
 * `Event` 도 남기지 않습니다 — `FAILED` 로 쓰면 "DM 발송 실패"와 섞여 Phase 3 퍼널이
 * 오염됩니다. 전용 EventType 은 필요가 확인되면 그때 추가합니다.
 *
 * 문구가 없으면(기본값) 아무것도 하지 않습니다. 설정하지 않은 사용자의 동작은 그대로입니다.
 */
async function replyToCommentBestEffort(
  ctx: HandlerContext,
  commentId: string,
  text: string | null,
): Promise<void> {
  if (!text?.trim()) return;
  try {
    await ctx.instagram.replyToComment(commentId, text);
  } catch (cause) {
    // 댓글 본문이 아니라 ID 만 남깁니다 (AGENTS.md §Privacy).
    console.error('대댓글 발송 실패', { commentId, cause: String(cause) });
  }
}
