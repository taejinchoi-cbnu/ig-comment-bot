/**
 * 댓글이 자동 DM을 발동시키는지 판단합니다.
 * 키워드가 비어 있으면 모든 댓글이 통과합니다 (게시글별 기본 동작).
 *
 * 데코레이터를 쓰지 않는 순수 함수로 유지하세요 —
 * Node의 타입 스트리핑으로 `node --test`가 컴파일 없이 바로 돌립니다.
 */
export function shouldTrigger(text: string | undefined, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  if (!text) return false;
  const haystack = text.toLowerCase();
  return keywords.some((k) => {
    const needle = k.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}
