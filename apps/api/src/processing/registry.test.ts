import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from './registry.ts';
import type { HandlerContext } from './context.ts';
import type { BotEvent } from '../webhook/normalize.ts';

/** dispatch 가 종류별로 갈라지는지만 본다. 각 핸들러의 로직은 자기 테스트가 검증한다. */
function ctxRecording(seen: string[]): HandlerContext {
  const prisma = {
    campaign: { findUnique: async () => null },
    sentReply: { create: async () => ({}), delete: async () => ({}) },
    conversation: {
      updateMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
      findUnique: async () => null,
    },
    event: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seen.push(`event:${String(data['type'])}`);
        return {};
      },
    },
  };
  return {
    account: {
      id: 'a',
      igUserId: 'ig',
      defaultPrivateReplyText: null,
      defaultFollowUpText: null,
      defaultCommentReplyText: null,
    },
    prisma: prisma as unknown as HandlerContext['prisma'],
    instagram: {
      sendPrivateReply: async () => {
        seen.push('sendPrivateReply');
        return { recipientId: 'r', messageId: 'm' };
      },
      replyToComment: async () => {
        seen.push('replyToComment');
        return { id: 'c' };
      },
      sendMessage: async () => {
        seen.push('sendMessage');
        return { recipientId: 'r', messageId: 'm' };
      },
    },
  };
}

test('COMMENT 는 댓글 핸들러로 간다', async () => {
  const seen: string[] = [];
  const event: BotEvent = {
    kind: 'COMMENT',
    igUserId: 'ig',
    commentId: 'c1',
    mediaId: 'm1',
    igsid: 'u1',
    text: '예약',
  };
  await dispatch(event, ctxRecording(seen));
  assert.ok(seen.includes('sendPrivateReply'), `실제 호출: ${seen.join(' → ')}`);
  assert.ok(!seen.includes('sendMessage'));
});

test('MESSAGE 는 메시지 핸들러로 간다', async () => {
  const seen: string[] = [];
  const event: BotEvent = { kind: 'MESSAGE', igUserId: 'ig', messageId: 'mid', igsid: 'u1', text: '네' };
  await dispatch(event, ctxRecording(seen));
  // 대화가 없어 선점에 실패(count 0)하므로 발송까지 가지 않는 것이 정상이다
  assert.ok(seen.includes('event:USER_REPLIED'), `실제 호출: ${seen.join(' → ')}`);
  assert.ok(!seen.includes('sendPrivateReply'));
});
