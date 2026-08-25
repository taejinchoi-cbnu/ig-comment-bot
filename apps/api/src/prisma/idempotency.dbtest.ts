/**
 * 통합 테스트 — 멱등성이 실제 PostgreSQL(Neon)에서 우리가 믿는 대로 동작하는지 증명한다.
 *
 * 핸들러 테스트(comment.handler.test.ts, message.handler.test.ts)는 가짜 Prisma 객체를
 * 주입해서 분기 로직만 검증한다. 이 파일은 그 분기가 의존하는 두 가지 DB 동작 자체를
 * 실제 DB로 검증한다 (docs/architecture.md §멱등성):
 *
 *  1. SentReply.create 중복 시 정말 P2002 코드로 던지는지
 *  2. Conversation.updateMany 조건부 전이가 정말 count:0/1 로 동시성을 가르는지
 *
 * 파일명이 .dbtest.ts 인 이유: package.json 의 "test" 스크립트는 src/**\/*.test.ts 만
 * 돈다. 이 파일은 실 DB 연결이 필요해 CI 기본 파이프라인에서 제외돼야 하므로
 * 그 글롭에 안 걸리는 이름을 쓴다. 실행: `node --test "src/prisma/*.dbtest.ts"`.
 *
 * 데코레이터를 쓰지 않는다 (node --test 대상).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPrisma } from './client.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';

// client.ts 는 연결 문자열을 Secrets Manager 에서 가져올 수 있어 생성이 비동기입니다.
// before 훅에서 한 번 받아 이 변수로 씁니다.
let prisma: PrismaClient;

// 이 테스트 실행 전체에서 고유한 접두사. 기존 데이터와 절대 겹치지 않는다.
const RUN_ID = `dbtest_${randomUUID()}`;

let userId: string;
let igAccountId: string;

before(async () => {
  prisma = await getPrisma();
  const user = await prisma.user.create({
    data: {
      email: `${RUN_ID}@example.com`,
      passwordHash: 'x',
    },
  });
  userId = user.id;

  const igAccount = await prisma.igAccount.create({
    data: {
      userId,
      igUserId: `${RUN_ID}_iguser`,
      slug: `${RUN_ID}_slug`,
      accessTokenEnc: 'x',
      appSecretEnc: 'x',
      verifyToken: 'x',
    },
  });
  igAccountId = igAccount.id;
});

// User 를 지우면 IgAccount → SentReply/Conversation 이 Cascade 로 전부 따라 지워진다
// (schema.prisma 의 onDelete: Cascade). 테스트가 실패해도 항상 실행되도록 after 에 둔다.
after(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

// ── SentReply: 댓글 멱등성 ──────────────────────────────────────────

test('같은 (igAccountId, commentId) 로 두 번 create 하면 두 번째는 P2002 로 던진다', async () => {
  const commentId = `${RUN_ID}_comment_1`;

  await prisma.sentReply.create({ data: { igAccountId, commentId } });

  await assert.rejects(
    () => prisma.sentReply.create({ data: { igAccountId, commentId } }),
    (cause: unknown) => {
      assert.equal(typeof cause, 'object');
      assert.equal((cause as { code?: unknown }).code, 'P2002');
      return true;
    },
  );
});

test('다른 commentId 로는 정상적으로 삽입된다', async () => {
  const row = await prisma.sentReply.create({
    data: { igAccountId, commentId: `${RUN_ID}_comment_2` },
  });
  assert.equal(row.commentId, `${RUN_ID}_comment_2`);
});

test('동시에 같은 키로 create 두 개를 실행하면 정확히 하나만 성공한다', async () => {
  const commentId = `${RUN_ID}_comment_concurrent`;

  const results = await Promise.allSettled([
    prisma.sentReply.create({ data: { igAccountId, commentId } }),
    prisma.sentReply.create({ data: { igAccountId, commentId } }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'P2002');
});

test('마커를 delete 한 뒤에는 같은 키로 다시 create 가 성공한다 (retryable 롤백 경로)', async () => {
  const commentId = `${RUN_ID}_comment_rollback`;

  await prisma.sentReply.create({ data: { igAccountId, commentId } });
  await prisma.sentReply.delete({ where: { igAccountId_commentId: { igAccountId, commentId } } });

  const row = await prisma.sentReply.create({ data: { igAccountId, commentId } });
  assert.equal(row.commentId, commentId);
});

// ── Conversation: 메시지 멱등성 ──────────────────────────────────────

test('WAITING_USER_MESSAGE 행을 조건부 updateMany 로 전이하면 count 는 1이고, 곧바로 다시 하면 0이다', async () => {
  const igsid = `${RUN_ID}_igsid_1`;
  await prisma.conversation.create({
    data: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
  });

  const first = await prisma.conversation.updateMany({
    where: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
    data: { state: 'USER_REPLIED' },
  });
  assert.equal(first.count, 1);

  const second = await prisma.conversation.updateMany({
    where: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
    data: { state: 'USER_REPLIED' },
  });
  assert.equal(second.count, 0);
});

test('FORM_SENT 상태 행에 같은 조건부 updateMany 를 하면 count 는 0이다', async () => {
  const igsid = `${RUN_ID}_igsid_2`;
  await prisma.conversation.create({
    data: { igAccountId, igsid, state: 'FORM_SENT' },
  });

  const result = await prisma.conversation.updateMany({
    where: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
    data: { state: 'USER_REPLIED' },
  });
  assert.equal(result.count, 0);
});

test('동시에 같은 조건부 updateMany 두 개를 실행하면 정확히 하나만 count:1 이다 (중복 양식 발송 방지)', async () => {
  const igsid = `${RUN_ID}_igsid_concurrent`;
  await prisma.conversation.create({
    data: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
  });

  const [a, b] = await Promise.all([
    prisma.conversation.updateMany({
      where: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
      data: { state: 'USER_REPLIED' },
    }),
    prisma.conversation.updateMany({
      where: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
      data: { state: 'USER_REPLIED' },
    }),
  ]);

  const counts = [a.count, b.count].sort();
  assert.deepEqual(counts, [0, 1]);
});

// ── 대화 조회: 선점 후 findUnique 로 캠페인 문구 정보를 읽을 수 있는가 ──

test('조건부 updateMany 로 선점한 뒤 findUnique 로 lastMediaId/lastCampaignId 를 읽을 수 있다', async () => {
  const igsid = `${RUN_ID}_igsid_lookup`;
  await prisma.conversation.create({
    data: {
      igAccountId,
      igsid,
      state: 'WAITING_USER_MESSAGE',
      lastMediaId: `${RUN_ID}_media`,
      lastCampaignId: `${RUN_ID}_campaign`,
    },
  });

  const claimed = await prisma.conversation.updateMany({
    where: { igAccountId, igsid, state: 'WAITING_USER_MESSAGE' },
    data: { state: 'USER_REPLIED' },
  });
  assert.equal(claimed.count, 1);

  const conversation = await prisma.conversation.findUnique({
    where: { igAccountId_igsid: { igAccountId, igsid } },
  });
  assert.equal(conversation?.lastMediaId, `${RUN_ID}_media`);
  assert.equal(conversation?.lastCampaignId, `${RUN_ID}_campaign`);
  assert.equal(conversation?.state, 'USER_REPLIED');
});
