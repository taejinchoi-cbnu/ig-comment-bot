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

export type FollowerCache = {
  isFollower: boolean | null;
  followerCheckedAt: Date | null;
};

/**
 * **TTL 이 값에 따라 다릅니다.** 두 값이 바뀌는 속도가 다르기 때문입니다.
 *
 * `true`(팔로워임)는 잘 안 바뀝니다. 30일이면 "같은 계정이 다음 게시물에 또 댓글을 다는"
 * 주기를 대체로 덮고, 그 사이 언팔했더라도 손해는 양식을 한 번 더 보내는 정도입니다.
 *
 * `false`는 **우리 메시지 때문에 바로 바뀌는 값**입니다. 1차 DM 이 "팔로우 확인할게요"
 * 라고 시켜놓고, 시키는 대로 한 사람에게 30일 동안 계속 같은 걸 묻는 건 앞뒤가 안 맞습니다.
 * 실제로 팔로우 직후 댓글에서 확인 문구가 또 나가는 걸 보고 나눴습니다.
 */
export const FOLLOWER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NON_FOLLOWER_TTL_MS = 60 * 60 * 1000;

/** 캐시된 값에 맞는 TTL. 값이 없으면(모름) 짧은 쪽을 씁니다 — 빨리 다시 물어봐야 합니다. */
export function ttlFor(cache: FollowerCache | null | undefined): number {
  return cache?.isFollower === true ? FOLLOWER_TTL_MS : NON_FOLLOWER_TTL_MS;
}


/**
 * "이 값을 다시 물어볼 필요가 없는가." **값이 무엇인지와 무관합니다.**
 *
 * 팔로워임(`isKnownFollower`)과 신선함은 다른 질문입니다. 비팔로워로 확인된 사람도
 * 확인은 신선한 것이고, 이 둘을 뭉치면 비팔로워에게 답장마다 조회를 날리게 됩니다.
 */
export function isFollowerCacheFresh(
  cache: FollowerCache | null | undefined,
  now: number,
  ttlMs: number = ttlFor(cache),
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
  ttlMs: number = ttlFor(cache),
): boolean {
  return cache?.isFollower === true && isFollowerCacheFresh(cache, now, ttlMs);
}
