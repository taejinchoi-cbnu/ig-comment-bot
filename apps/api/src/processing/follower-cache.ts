/**
 * 팔로워 여부 캐시의 정책 한 곳.
 *
 * `is_user_follow_business` 는 **대화가 성립한 뒤에만** 조회됩니다
 * (docs/meta-api.md §1-13). 댓글이 들어온 시점에는 새로 물어볼 방법이 없으므로,
 * 답장을 받았을 때 찍어 `Conversation` 에 저장해 둔 값이 유일한 근거입니다.
 *
 * 저장소를 따로 두지 않는 이유: `Conversation` 이 이미 `(igAccountId, igsid)` 당
 * 한 행이라 그 자체가 key-value 입니다. TTL 도 만료 배치가 아니라 읽는 시점의
 * 비교 한 줄입니다.
 *
 * 순수 함수로 유지하세요 (node --test 대상, 데코레이터 금지).
 */

/**
 * 팔로우는 언제든 끊깁니다. 짧게 잡으면 캐시가 무의미해지고, 길게 잡으면 이미 언팔한
 * 사람에게 팔로워 대접을 계속하게 됩니다. 30일이면 "같은 계정이 다음 게시물에 또
 * 댓글을 다는" 주기를 대체로 덮으면서 오차가 한 달을 넘지 않습니다.
 */
export const FOLLOWER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type FollowerCache = {
  isFollower: boolean | null;
  followerCheckedAt: Date | null;
};

/**
 * "이 값을 다시 물어볼 필요가 없는가." **값이 무엇인지와 무관합니다.**
 *
 * 팔로워임(`isKnownFollower`)과 신선함은 다른 질문입니다. 비팔로워로 확인된 사람도
 * 확인은 신선한 것이고, 이 둘을 뭉치면 비팔로워에게 답장마다 조회를 날리게 됩니다.
 */
export function isFollowerCacheFresh(
  cache: FollowerCache | null | undefined,
  now: number,
  ttlMs: number = FOLLOWER_TTL_MS,
): boolean {
  const checkedAt = cache?.followerCheckedAt;
  if (!checkedAt) return false; // 확인한 적이 없거나 시점이 없으면 만료 판정이 불가능하다
  return now - checkedAt.getTime() < ttlMs;
}

/**
 * "이 사람은 팔로워임이 확인됐고 그 확인이 아직 유효한가."
 *
 * `false`(비팔로워로 확인됨)와 `null`(모름)을 **구분하지 않고 둘 다 거짓**으로 봅니다 —
 * 이 값이 참일 때만 확인 단계를 건너뛰므로, 애매하면 기존 2단계로 가는 쪽이 안전합니다.
 */
export function isKnownFollower(
  cache: FollowerCache | null | undefined,
  now: number,
  ttlMs: number = FOLLOWER_TTL_MS,
): boolean {
  return cache?.isFollower === true && isFollowerCacheFresh(cache, now, ttlMs);
}
