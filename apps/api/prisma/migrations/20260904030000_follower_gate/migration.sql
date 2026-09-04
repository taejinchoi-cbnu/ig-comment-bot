-- 팔로워 게이트 (옵션).
--
-- NULL 이면 게이트가 없다 = 지금까지의 동작 그대로 비팔로워도 양식을 받는다.
-- 값을 넣은 계정에서만 비팔로워에게 양식 대신 이 문구가 나간다.
-- 켜는 것이 제품 결정이라 기본값을 두지 않는다 (docs/why.md §팔로워 게이트).
ALTER TABLE "IgAccount" ADD COLUMN "nonFollowerText" TEXT;

-- "왜 양식이 안 갔지?" 에 답하는 열에 새 사유를 추가한다. 게이트가 막은 것과
-- 발송이 실패한 것은 완전히 다른 사건이라 FAILED 로 뭉뚱그리지 않는다.
ALTER TYPE "SkipReason" ADD VALUE 'NOT_FOLLOWER';
