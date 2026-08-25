import type { Campaign, IgAccount, PrismaClient } from '../generated/prisma/client.ts';
import type { EventType, SkipReason } from '../generated/prisma/enums.ts';
import type { InstagramApiClient } from '../instagram/client.ts';
import { InstagramApiError } from '../instagram/errors.ts';

/**
 * 핸들러가 공유하는 실행 컨텍스트.
 *
 * 모든 의존을 **평범한 객체로 주입**받습니다 — 테스트에서 mocking 라이브러리 없이
 * 가짜를 넣기 위함입니다. 여기 있는 import 는 전부 `import type` 이라 런타임에
 * 사라지고, 따라서 이 파일과 이 파일을 쓰는 핸들러는 `node --test` 로 그대로 돕니다.
 * (생성된 Prisma 코드를 값으로 import 하면 그 순간 깨집니다.)
 */

/** 핸들러가 실제로 만지는 Prisma 표면만 좁힙니다. */
export type HandlerPrisma = Pick<PrismaClient, 'campaign' | 'sentReply' | 'conversation' | 'event'>;

/** 발송에 필요한 메서드만. 토큰 검증·구독 API 는 핸들러의 관심사가 아닙니다. */
export type InstagramSender = Pick<InstagramApiClient, 'sendPrivateReply' | 'sendMessage'>;

export type HandlerAccount = Pick<
  IgAccount,
  'id' | 'igUserId' | 'defaultPrivateReplyText' | 'defaultFollowUpText'
>;

export type HandlerCampaign = Pick<
  Campaign,
  'id' | 'mediaId' | 'enabled' | 'triggerKeywords' | 'privateReplyText' | 'followUpText'
>;

export type HandlerContext = {
  account: HandlerAccount;
  prisma: HandlerPrisma;
  instagram: InstagramSender;
  /** 테스트에서 latencyMs 를 고정하기 위한 주입 지점. 기본은 Date.now. */
  now?: () => number;
};

export type EventInput = {
  type: EventType;
  skipReason?: SkipReason | undefined;
  campaignId?: string | undefined;
  mediaId?: string | undefined;
  igsid?: string | undefined;
  username?: string | undefined;
  errorCode?: string | undefined;
  latencyMs?: number | undefined;
  isFollower?: boolean | undefined;
};

/**
 * 모든 분기에서 호출합니다 — 건너뛴 경우(`COMMENT_SKIPPED` + `skipReason`)도 포함해서.
 * "왜 DM 이 안 갔지?" 는 사용자가 가장 많이 하는 질문인데, 기록하지 않은 과거는
 * 소급 생성이 불가능합니다 (docs/architecture.md §데이터 모델).
 *
 * **절대 던지지 않습니다.** 통계 기록 실패가 발송 흐름을 깨면 안 되고, 던지면
 * SQS 가 재시도해서 중복 발송을 시도하게 됩니다. 실패는 로그로만 남깁니다.
 */
export async function recordEvent(ctx: HandlerContext, input: EventInput): Promise<void> {
  try {
    await ctx.prisma.event.create({
      data: {
        igAccountId: ctx.account.id,
        type: input.type,
        skipReason: input.skipReason ?? null,
        campaignId: input.campaignId ?? null,
        mediaId: input.mediaId ?? null,
        igsid: input.igsid ?? null,
        username: input.username ?? null,
        errorCode: input.errorCode ?? null,
        latencyMs: input.latencyMs ?? null,
        isFollower: input.isFollower ?? null,
      },
    });
  } catch (cause) {
    // 본문·토큰은 애초에 EventInput 에 없습니다. 원인만 남깁니다.
    console.error('event 기록 실패', { type: input.type, cause: String(cause) });
  }
}

/** 현재 시각. 테스트에서 주입한 값이 있으면 그것을 씁니다. */
export function nowMs(ctx: HandlerContext): number {
  return (ctx.now ?? Date.now)();
}

/**
 * 재시도 여부 판정. **핸들러 전부가 이 함수를 쓴다** — 정책이 갈리면 안 된다.
 *
 * `InstagramApiError` 가 아닌 예상 밖 예외는 **재시도 가능**으로 본다.
 * 알 수 없는 에러는 정의상 발송이 되었는지조차 모르는 상태다. 여기서 삼키면
 * 증거가 사라지고 사용자는 중간 상태에 갇힌 채 아무 일도 일어나지 않는다.
 * throw 하면 SQS 가 재시도하고, 끝내 실패해도 DLQ 에 남아 원인을 볼 수 있다.
 * 결정적 버그라면 재시도 5회를 태우고 DLQ 로 가는데, 그게 DLQ 의 용도다.
 */
export function isRetryableError(error: unknown): boolean {
  return error instanceof InstagramApiError ? error.retryable : true;
}

/**
 * `Event.errorCode` 에 넣을 문자열. 핸들러마다 다르게 뽑으면 Phase 3 에서
 * 실패 사유를 그룹핑할 때 같은 원인이 여러 코드로 흩어진다.
 */
export function extractErrorCode(error: unknown): string {
  if (error instanceof InstagramApiError) {
    return String(error.code ?? error.status ?? error.type ?? 'UNKNOWN');
  }
  if (error instanceof Error) return error.name || 'UNKNOWN';
  return 'UNKNOWN';
}
