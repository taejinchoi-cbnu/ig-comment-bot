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
import { extractErrorCode, type HandlerContext, isRetryableError, nowMs, recordEvent } from './context.ts';
import { resolveTemplates } from './templates.ts';
import { shouldTrigger } from './trigger.ts';

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

  const startedAt = nowMs(ctx);
  try {
    await ctx.instagram.sendPrivateReply(event.commentId, templates.privateReply);
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

    if (retryable) {
      // 마커만 남고 발송은 안 된 상태를 되돌린다. 안 그러면 이 댓글은 영원히 DM 을 못 받는다.
      await ctx.prisma.sentReply.delete({
        where: {
          igAccountId_igsid_mediaId: {
            igAccountId: account.id,
            igsid: event.igsid,
            mediaId: event.mediaId,
          },
        },
      });
      throw error; // SQS 가 재시도한다
    }

    // non-retryable: 재시도해도 절대 성공하지 않으므로 마커는 남겨두고 조용히 끝낸다.
    // throw 하면 5회 재시도 후 DLQ 로 가서 노이즈만 만든다.
    return;
  }

  await ctx.prisma.conversation.upsert({
    where: { igAccountId_igsid: { igAccountId: account.id, igsid: event.igsid } },
    create: {
      igAccountId: account.id,
      igsid: event.igsid,
      state: 'WAITING_USER_MESSAGE',
      lastCommentId: event.commentId,
      lastMediaId: event.mediaId, // ← 게시물별 문구가 성립하는 이유 (docs/architecture.md §게시물별 문구)
      lastCampaignId: campaign?.id ?? null,
    },
    update: {
      state: 'WAITING_USER_MESSAGE',
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
  });

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
