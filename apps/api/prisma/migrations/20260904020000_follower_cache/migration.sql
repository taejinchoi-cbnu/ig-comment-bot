-- 팔로워 여부 캐시.
--
-- is_user_follow_business 는 대화가 성립한 뒤에만 조회된다(docs/meta-api.md §1-13).
-- 그래서 댓글 단계에서는 새로 물어볼 수 없고, 답장을 받은 시점에 찍어둔 이 값이
-- 유일한 근거다. 이 값이 있으면 다음 댓글에는 "팔로워인지 확인할게요" 를 건너뛰고
-- 양식을 바로 보낼 수 있다.
--
-- 별도 KV 저장소를 두지 않는 이유: Conversation 이 이미 @@unique(igAccountId, igsid) 라
-- 사람당 한 행이다. 그 행에 컬럼 두 개를 붙이면 그게 곧 key-value 이고,
-- TTL 은 만료 배치가 아니라 followerCheckedAt 비교 한 줄로 끝난다.
ALTER TABLE "Conversation" ADD COLUMN "isFollower" BOOLEAN;
ALTER TABLE "Conversation" ADD COLUMN "followerCheckedAt" TIMESTAMP(3);
