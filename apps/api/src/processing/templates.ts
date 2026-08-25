/**
 * 계정·캠페인 설정에 따라 자동 DM 문구를 3단 폴백으로 결정합니다.
 * 각 필드는 독립적으로 캐스케이드됩니다:
 *   privateReply: 캠페인 → 계정 → 시스템 기본값
 *   followUp: 캠페인 → 계정 → 시스템 기본값
 *   triggerKeywords: 캠페인 배열 (없으면 [])
 *
 * "값이 없다" = null, undefined, 빈 문자열, 공백만 있는 문자열.
 * 판정은 trim 후 확인하지만, 반환값은 원본 그대로입니다.
 */

export const DEFAULT_PRIVATE_REPLY_TEXT =
  '팔로워인지 확인할게요! 아무 메시지나 보내주세요 💬';

export const DEFAULT_FOLLOW_UP_TEXT =
  '❤️사전예약 양식❤️\n성함 :\n생년월일 :\n연락처 :\n통신사 :\n희망기종 :\n거주지역 :\n위 양식 작성해주시면 업무 조회 후 상담도와드리겠습니다😃';

export type AccountDefaults = {
  defaultPrivateReplyText?: string | null;
  defaultFollowUpText?: string | null;
};

export type CampaignOverrides = {
  privateReplyText?: string | null;
  followUpText?: string | null;
  triggerKeywords?: readonly string[] | null;
};

export type ResolvedTemplates = {
  privateReply: string;
  followUp: string;
  triggerKeywords: readonly string[];
};

/**
 * 값이 있는지 판단합니다.
 * null, undefined, 빈 문자열, 공백만 있는 문자열 → false
 * 그 외 → true
 */
function hasValue(value: string | undefined | null): value is string {
  if (value == null) return false;
  return value.trim().length > 0;
}

/**
 * 3단 폴백 필드를 결정합니다.
 * campaign → account → defaultValue 순으로 체크합니다.
 */
function resolveField(
  campaignValue: string | undefined | null,
  accountValue: string | undefined | null,
  defaultValue: string,
): string {
  if (hasValue(campaignValue)) return campaignValue;
  if (hasValue(accountValue)) return accountValue;
  return defaultValue;
}

/**
 * 트리거 키워드를 결정합니다.
 * campaign.triggerKeywords 가 배열이면 그대로 (빈 배열 포함).
 * null/undefined 면 빈 배열 [].
 */
function resolveKeywords(
  campaign: CampaignOverrides | null | undefined,
): readonly string[] {
  if (campaign?.triggerKeywords != null) {
    return campaign.triggerKeywords;
  }
  return [];
}

export function resolveTemplates(
  account: AccountDefaults | null | undefined,
  campaign: CampaignOverrides | null | undefined,
): ResolvedTemplates {
  return {
    privateReply: resolveField(
      campaign?.privateReplyText,
      account?.defaultPrivateReplyText,
      DEFAULT_PRIVATE_REPLY_TEXT,
    ),
    followUp: resolveField(
      campaign?.followUpText,
      account?.defaultFollowUpText,
      DEFAULT_FOLLOW_UP_TEXT,
    ),
    triggerKeywords: resolveKeywords(campaign),
  };
}
