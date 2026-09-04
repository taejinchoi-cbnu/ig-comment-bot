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

  // findUnique(id) 가 아니라 findFirst 로 igAccountId 를 같이 건다. Campaign.id 는
  // 전역 고유(cuid)라 지금은 결과가 같지만, 여기서 테넌트 필터를 생략하면
  // "모든 쿼리는 igAccountId 스코프" 라는 불변식이 이 경로에서만 깨진다.
  // lastCampaignId 는 지금은 항상 같은 계정의 캠페인에서만 채워지지만,
  // 그 보장이 DB 제약이 아니라 comment.handler.ts 의 쓰기 로직에만 있다 —
  // 나중에 다른 쓰기 경로(운영 툴, 마이그레이션)가 이 불변식을 깨면
  // 이 필터가 남의 계정 캠페인 문구가 새는 것을 막는 마지막 방어선이다.
  const campaign = conversation?.lastCampaignId
    ? await ctx.prisma.campaign.findFirst({ where: { id: conversation.lastCampaignId, igAccountId } })
    : null;

  const templates = resolveTemplates(ctx.account, campaign);
  const mediaId = conversation?.lastMediaId ?? undefined;
  const campaignId = campaign?.id ?? undefined;

  // 팔로워 여부는 **대화가 성립한 지금**만 조회할 수 있다 (docs/meta-api.md §1-13).
  // 댓글 단계에는 물어볼 방법이 없으므로 여기서 찍어 캐시해 두고, 다음 댓글 때 쓴다.
  const isFollower = await checkFollower(ctx, igsid);
  // 값을 못 얻었으면 캐시를 건드리지 않는다. checkedAt 만 새로 찍으면 "모름" 이
  // TTL 동안 굳어서 그 사이 계속 확인 단계를 거치게 된다.
  const cache = isFollower === null ? {} : { isFollower, followerCheckedAt: new Date(nowMs(ctx)) };

  // 팔로워 게이트는 **옵션**이다. nonFollowerText 가 비어 있으면(기본) 아무도 막지 않는다.
  // 판단 불가(null)일 때도 막지 않는다 — 조회가 한 번 실패했다고 정상 사용자를 막는
  // 쪽이 훨씬 나쁘다 (docs/why.md §팔로워 게이트).
  const gateText = ctx.account.nonFollowerText?.trim();
  const gated = Boolean(gateText) && isFollower === false;

  // 발송은 한 번, 에러 처리도 한 갈래다. 무엇을 보낼지만 위에서 정한다.
  try {
    await ctx.instagram.sendMessage(igsid, gated ? (gateText as string) : templates.followUp);
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

  if (gated) {
    // 양식은 안 나갔다. WAITING_USER_MESSAGE 로 되돌려 두면 그 사람이 팔로우한 뒤
    // 다시 답장할 때 이 경로를 그대로 다시 타고, 그때는 팔로워로 확인돼 양식을 받는다.
    // FORM_SENT 로 굳히면 팔로우해도 영영 못 받는다.
    await ctx.prisma.conversation.updateMany({
      where: { igAccountId, igsid },
      data: { state: 'WAITING_USER_MESSAGE', ...cache },
    });
    await recordEvent(ctx, {
      type: 'COMMENT_SKIPPED',
      skipReason: 'NOT_FOLLOWER',
      campaignId,
      mediaId,
      igsid,
      isFollower: false,
      latencyMs: nowMs(ctx) - startedAt,
    });
    return;
  }

  await ctx.prisma.conversation.updateMany({
    where: { igAccountId, igsid },
    data: { state: 'FORM_SENT', ...cache },
  });

  await recordEvent(ctx, {
    type: 'FOLLOW_UP_SENT',
    campaignId,
    mediaId,
    igsid,
    latencyMs: nowMs(ctx) - startedAt,
    // 반응 시점의 값을 박제한다. 나중에 다시 조회하면 과거 통계가 흔들린다
    // (docs/meta-api.md §7).
    ...(isFollower === null ? {} : { isFollower }),
  });
}

/**
 * 팔로워 여부 조회. **절대 던지지 않습니다** — 양식은 이미 나갔고, 부가 정보 하나 때문에
 * SQS 재시도를 유발하면 조건부 UPDATE 에 걸려 그 사용자는 다시 받지 못합니다.
 */
async function checkFollower(ctx: HandlerContext, igsid: string): Promise<boolean | null> {
  try {
    return await ctx.instagram.isUserFollowBusiness(igsid);
  } catch (cause) {
    console.error('팔로워 여부 조회 실패', { igsid, cause: String(cause) });
    return null;
  }
}
