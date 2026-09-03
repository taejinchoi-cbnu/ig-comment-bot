-- 1) 계정 기본 대댓글 문구. NULL 이면 대댓글을 달지 않는다 (opt-in).
--    DM 은 상대의 "요청(Requests)" 탭으로 들어가 받은 줄 모르는 경우가 많아,
--    댓글에 공개로 한 줄 달아주는 "확인해보세요" 신호가 필요하다.
ALTER TABLE "IgAccount" ADD COLUMN "defaultCommentReplyText" TEXT;

-- 2) 멱등성 마커의 키를 (계정, 댓글) → (계정, 사람, 게시물) 로 바꾼다.
--
--    commentId 로 잡으면 같은 사람이 같은 글에 댓글을 또 달 때마다 새 ID 라서
--    DM 이 다시 나간다. Meta 의 "댓글당 1회" 제한(docs/meta-api.md §1-9)은 새 댓글을
--    새로 허용하므로 막아주지 않는다 — 여기가 유일한 방어선이다.
--    igsid 로만 잡으면 반대로 다른 게시물의 문구를 영영 못 받는다.
--
--    기존 행을 지우는 이유: igsid/mediaId 를 NOT NULL 로 추가하려면 기존 행에 채울
--    값이 있어야 하는데 없다. 마커는 본래 휘발성이고(지워지면 그 사람이 그 글에
--    한 번 더 받을 수 있을 뿐), 여기 있는 건 개발 중 E2E 테스트로 생긴 행뿐이다.
DELETE FROM "SentReply";

ALTER TABLE "SentReply" DROP CONSTRAINT "SentReply_pkey";
ALTER TABLE "SentReply" ADD COLUMN "igsid" TEXT NOT NULL;
ALTER TABLE "SentReply" ADD COLUMN "mediaId" TEXT NOT NULL;
ALTER TABLE "SentReply" ADD CONSTRAINT "SentReply_pkey" PRIMARY KEY ("igAccountId", "igsid", "mediaId");
