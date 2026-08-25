import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventProducer, type EnqueueResult } from './producer.ts';
import type { BotEvent, CommentEvent, MessageEvent } from '../webhook/normalize.ts';
import type { SQSClient } from '@aws-sdk/client-sqs';

/**
 * 테스트용 가짜 SQS 클라이언트.
 * send 호출을 기록하고, 구성된 응답을 반환합니다.
 */
function createFakeSQSClient(
  responses: Array<{ Successful?: { Id: string }[]; Failed?: Array<{ Id: string; Message: string }> }>,
) {
  let callIndex = 0;
  const calls: unknown[] = [];

  return {
    send: async (cmd: unknown) => {
      calls.push(cmd);
      const response = responses[callIndex] ?? { Successful: [] };
      callIndex++;
      return response;
    },
    calls,
  };
}

// 테스트용 더미 이벤트 생성
function createCommentEvent(id: string): CommentEvent {
  return {
    kind: 'COMMENT',
    igUserId: `user_${id}`,
    commentId: `comment_${id}`,
    mediaId: `media_${id}`,
    igsid: `author_${id}`,
    text: `Comment ${id}`,
  };
}

function createMessageEvent(id: string): MessageEvent {
  return {
    kind: 'MESSAGE',
    igUserId: `user_${id}`,
    messageId: `msg_${id}`,
    igsid: `sender_${id}`,
    text: `Message ${id}`,
  };
}

test('3건 입력 → 1회 호출, Entries 3개', async () => {
  const events: BotEvent[] = [createCommentEvent('1'), createCommentEvent('2'), createCommentEvent('3')];
  const fakeClient = createFakeSQSClient([{ Successful: [{ Id: '0' }, { Id: '1' }, { Id: '2' }] }]);

  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
    client: fakeClient as unknown as SQSClient,
  });

  const result = await producer.enqueue(events);

  // send 는 1회만 호출
  assert.equal(fakeClient.calls.length, 1);

  // 호출된 커맨드 확인
  const cmd = fakeClient.calls[0] as any;
  assert.equal(cmd.input.Entries!.length, 3);
  assert.equal(cmd.input.QueueUrl, 'https://example.com/queue');

  // 결과 확인
  assert.equal(result.successful, 3);
  assert.equal(result.failed.length, 0);
});

test('12건 입력 → 2회 호출, 첫 배치 10개 / 두 번째 2개', async () => {
  const events: BotEvent[] = Array.from({ length: 12 }, (_, i) => createCommentEvent(String(i)));
  const fakeClient = createFakeSQSClient([
    { Successful: Array.from({ length: 10 }, (_, i) => ({ Id: String(i) })) },
    { Successful: [{ Id: '0' }, { Id: '1' }] },
  ]);

  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
    client: fakeClient as unknown as SQSClient,
  });

  const result = await producer.enqueue(events);

  // send 는 2회 호출
  assert.equal(fakeClient.calls.length, 2);

  // 첫 배치 확인 (10개)
  const cmd1 = fakeClient.calls[0] as any;
  assert.equal(cmd1.input.Entries!.length, 10);

  // 두 번째 배치 확인 (2개)
  const cmd2 = fakeClient.calls[1] as any;
  assert.equal(cmd2.input.Entries!.length, 2);

  // 결과 확인
  assert.equal(result.successful, 12);
  assert.equal(result.failed.length, 0);
});

test('배치 안에서 Id가 서로 다르다', async () => {
  const events: BotEvent[] = [createCommentEvent('1'), createCommentEvent('2'), createCommentEvent('3')];
  const fakeClient = createFakeSQSClient([{ Successful: [{ Id: '0' }, { Id: '1' }, { Id: '2' }] }]);

  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
    client: fakeClient as unknown as SQSClient,
  });

  await producer.enqueue(events);

  const cmd = fakeClient.calls[0] as any;
  const ids = cmd.input.Entries!.map((e: any) => e.Id);

  // 인덱스 기반 ID가 서로 다른지 확인
  assert.deepEqual(ids, ['0', '1', '2']);
});

test('MessageBody가 원본 이벤트의 JSON이다', async () => {
  const event = createMessageEvent('test');
  const events: BotEvent[] = [event];
  const fakeClient = createFakeSQSClient([{ Successful: [{ Id: '0' }] }]);

  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
    client: fakeClient as unknown as SQSClient,
  });

  await producer.enqueue(events);

  const cmd = fakeClient.calls[0] as any;
  const messageBody = cmd.input.Entries![0]!.MessageBody;
  const parsed = JSON.parse(messageBody);

  // 파싱된 이벤트가 원본과 동일한지 확인
  assert.deepEqual(parsed, event);
});

test('빈 배열 → SQS를 호출하지 않고 { successful: 0, failed: [] }', async () => {
  const fakeClient = createFakeSQSClient([]);

  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
    client: fakeClient as unknown as SQSClient,
  });

  const result = await producer.enqueue([]);

  // send 호출 없음
  assert.equal(fakeClient.calls.length, 0);

  // 결과 확인
  assert.deepEqual(result, { successful: 0, failed: [] });
});

test('Failed 응답에서 failed에 원본 이벤트를 담아서 반환한다', async () => {
  const event1 = createCommentEvent('1');
  const event2 = createCommentEvent('2');
  const event3 = createCommentEvent('3');
  const events: BotEvent[] = [event1, event2, event3];

  const fakeClient = createFakeSQSClient([
    {
      Successful: [{ Id: '1' }],
      Failed: [
        { Id: '0', Message: 'InvalidParameterValue' },
        { Id: '2', Message: 'InternalFailure' },
      ],
    },
  ]);

  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
    client: fakeClient as unknown as SQSClient,
  });

  const result = await producer.enqueue(events);

  // 성공 1개, 실패 2개
  assert.equal(result.successful, 1);
  assert.equal(result.failed.length, 2);

  // 실패한 이벤트가 원본과 동일한지 확인
  assert.deepEqual(result.failed[0]!.event, event1);
  assert.deepEqual(result.failed[1]!.event, event3);

  // 실패 사유 확인
  assert.equal(result.failed[0]!.reason, 'InvalidParameterValue');
  assert.equal(result.failed[1]!.reason, 'InternalFailure');
});

test('여러 배치에 걸쳐 실패가 나도 전부 모아서 돌려준다', async () => {
  const events: BotEvent[] = Array.from({ length: 12 }, (_, i) => createCommentEvent(String(i)));

  const fakeClient = createFakeSQSClient([
    {
      Successful: [{ Id: '1' }, { Id: '3' }],
      Failed: [
        { Id: '0', Message: 'Error1' },
        { Id: '2', Message: 'Error2' },
      ],
    },
    {
      Successful: [{ Id: '0' }],
      Failed: [
        { Id: '1', Message: 'Error3' },
      ],
    },
  ]);

  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
    client: fakeClient as unknown as SQSClient,
  });

  const result = await producer.enqueue(events);

  // 성공 3개 (1번 배치: 2개, 2번 배치: 1개)
  assert.equal(result.successful, 3);

  // 실패 3개 (1번 배치: 2개, 2번 배치: 1개)
  assert.equal(result.failed.length, 3);

  // 실패한 이벤트 확인
  // 첫 배치: event[0], event[2]
  // 두 번째 배치: event[11]
  assert.deepEqual((result.failed[0]!.event as CommentEvent).commentId, 'comment_0');
  assert.deepEqual((result.failed[1]!.event as CommentEvent).commentId, 'comment_2');
  assert.deepEqual((result.failed[2]!.event as CommentEvent).commentId, 'comment_11');
});

test('여러 배치에서 각 배치 내 Id는 0부터 시작한다', async () => {
  const events: BotEvent[] = Array.from({ length: 12 }, (_, i) => createCommentEvent(String(i)));
  const fakeClient = createFakeSQSClient([
    { Successful: Array.from({ length: 10 }, (_, i) => ({ Id: String(i) })) },
    { Successful: [{ Id: '0' }, { Id: '1' }] },
  ]);

  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
    client: fakeClient as unknown as SQSClient,
  });

  await producer.enqueue(events);

  // 첫 배치의 Id: 0~9
  const cmd1 = fakeClient.calls[0] as any;
  const ids1 = cmd1.input.Entries!.map((e: any) => e.Id);
  assert.deepEqual(ids1, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

  // 두 번째 배치의 Id: 0~1 (각 배치 내에서만 유일)
  const cmd2 = fakeClient.calls[1] as any;
  const ids2 = cmd2.input.Entries!.map((e: any) => e.Id);
  assert.deepEqual(ids2, ['0', '1']);
});

test('기본 SQSClient가 주입되지 않으면 new SQSClient({})를 생성한다', async () => {
  // 이 테스트는 구현 검증용입니다.
  // 실제로는 AWS SDK를 호출하지 않으므로, 생성자가 에러 없이 진행되는지만 확인합니다.
  const producer = new EventProducer({
    queueUrl: 'https://example.com/queue',
  });

  assert.ok(producer);
});
