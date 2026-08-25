/**
 * MESSAGE 이벤트 핸들러 — 1차 DM 에 답장한 사용자에게 후속 문구(사전예약 양식)를 보냅니다.
 *
 * 멱등성은 조건부 UPDATE 한 번이 전부입니다 (docs/architecture.md §멱등성):
 *   UPDATE conversations SET state='USER_REPLIED' WHERE ... AND state='WAITING_USER_MESSAGE'
 * `claimed.count === 0` 이면 대화가 없거나 이미 양식을 보냈거나 중복 webhook 입니다.
 *
 * 문구는 댓글 단계가 저장해둔 lastMediaId/lastCampaignId 로 되찾습니다
 * (docs/architecture.md §게시물별 문구) — MESSAGE 이벤트 시점엔 IGSID 뿐이라
 * 어느 게시물에서 시작된 대화인지 이 값 없이는 알 수 없습니다.
 *
 * 데코레이터를 쓰지 않는 평범한 함수로 유지하세요 (node --test 대상).
 */
import type { MessageEvent } from '../webhook/normalize.ts';
import { extractErrorCode, type HandlerContext, isRetryableError, nowMs, recordEvent } from './context.ts';
import { resolveTemplates } from './templates.ts';

export async function handleMessage(event: MessageEvent, ctx: HandlerContext): Promise<void> {
  const startedAt = nowMs(ctx);
  const igAccountId = ctx.account.id;
  const igsid = event.igsid;

  await recordEvent(ctx, { type: 'USER_REPLIED', igsid });

  // 조건부 상태 전이로 선점 — 이게 중복 방지의 전부다.
  const claimed = await ctx.prisma.conversation.updateMany({
    where: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
    data: { state: 'USER_REPLIED' },
  });
  if (claimed.count === 0) {
    await recordEvent(ctx, { type: 'COMMENT_SKIPPED', skipReason: 'DUPLICATE', igsid });
    return;
  }

  // 경합 없음 — lastMediaId 는 댓글 단계 이후 변하지 않고, 위에서 이미 선점했다.
  const conversation = await ctx.prisma.conversation.findUnique({
    where: { igAccountId_igsid: { igAccountId, igsid } },
  });

  const campaign = conversation?.lastCampaignId
    ? await ctx.prisma.campaign.findUnique({ where: { id: conversation.lastCampaignId } })
    : null;

  const templates = resolveTemplates(ctx.account, campaign);
  const mediaId = conversation?.lastMediaId ?? undefined;
  const campaignId = campaign?.id ?? undefined;

  try {
    await ctx.instagram.sendMessage(igsid, templates.followUp);
  } catch (cause) {
    const errorCode = extractErrorCode(cause);

    // 예상 밖 예외도 재시도 경로로 보낸다 (context.ts 의 isRetryableError 참고).
    // 여기서 삼키면 대화가 USER_REPLIED 로 굳어 재드라이브해도 위 조건부
    // UPDATE 에 걸리고, 그 사용자는 영원히 양식을 못 받는다.
    if (isRetryableError(cause)) {
      // 롤백하지 않으면 상태만 USER_REPLIED 로 남고 양식은 안 나가서,
      // 재시도가 와도 위 조건부 UPDATE 에 걸려 이 사용자는 영원히 양식을 못 받는다.
      await ctx.prisma.conversation.updateMany({
        where: { igAccountId, igsid, state: 'USER_REPLIED' },
        data: { state: 'WAITING_USER_MESSAGE' },
      });
      await recordEvent(ctx, { type: 'FAILED', errorCode, campaignId, mediaId, igsid });
      throw cause;
    }

    // non-retryable: 재시도해도 성공하지 않으므로 롤백하지 않고 throw 도 하지 않는다
    // (throw 하면 SQS 가 5회 재시도 후 DLQ 로 보내 노이즈만 만든다).
    await recordEvent(ctx, { type: 'FAILED', errorCode, campaignId, mediaId, igsid });
    return;
  }

  await ctx.prisma.conversation.updateMany({
    where: { igAccountId, igsid },
    data: { state: 'FORM_SENT' },
  });

  await recordEvent(ctx, {
    type: 'FOLLOW_UP_SENT',
    campaignId,
    mediaId,
    igsid,
    latencyMs: nowMs(ctx) - startedAt,
  });
}
