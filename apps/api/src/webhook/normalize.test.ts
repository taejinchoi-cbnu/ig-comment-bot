import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from './normalize.ts';

const ME = '17841400000000000'; // 내 IG User ID (entry[].id)
const THEM = '17850000000000000'; // 댓글/DM 을 보낸 사람의 IGSID

const commentPayload = (value: Record<string, unknown>, entryId = ME) => ({
  object: 'instagram',
  entry: [{ id: entryId, time: 1760000000000, changes: [{ field: 'comments', value }] }],
});

const messagePayload = (messaging: Record<string, unknown>, entryId = ME) => ({
  object: 'instagram',
  entry: [{ id: entryId, time: 1760000000000, messaging: [messaging] }],
});

const comment = (over: Record<string, unknown> = {}) => ({
  id: '18000123456789000',
  text: '예약',
  from: { id: THEM, username: 'someone' },
  media: { id: '17990000000000000', media_product_type: 'FEED' },
  ...over,
});

// ── 댓글 ──────────────────────────────────────────────────────────

test('댓글은 entry[].changes[] 에서 읽는다', () => {
  const { events, skipped } = normalize(commentPayload(comment()), ME);
  assert.equal(skipped.length, 0);
  assert.deepEqual(events, [
    {
      kind: 'COMMENT',
      igUserId: ME,
      commentId: '18000123456789000',
      mediaId: '17990000000000000',
      igsid: THEM,
      username: 'someone',
      text: '예약',
    },
  ]);
});

test('내가 내 글에 단 댓글은 SELF_COMMENT 로 건너뛴다', () => {
  // from.id 가 entry.id 와 같은 경우. 자기 자신에게 DM 은 불가능하다
  const { events, skipped } = normalize(commentPayload(comment({ from: { id: ME } })), ME);
  assert.equal(events.length, 0);
  assert.equal(skipped[0]?.reason, 'SELF_COMMENT');
});

test('댓글 삭제/수정 알림(verb !== add)에는 반응하지 않는다', () => {
  const { events, skipped } = normalize(commentPayload(comment({ verb: 'remove' })), ME);
  assert.equal(events.length, 0);
  assert.equal(skipped.length, 0);
});

test('verb 가 없으면 생성으로 본다', () => {
  const { events } = normalize(commentPayload(comment()), ME);
  assert.equal(events.length, 1);
});

test('media.id 가 없는 댓글은 버린다 — 어느 게시글인지 알 수 없다', () => {
  const { events } = normalize(commentPayload(comment({ media: undefined })), ME);
  assert.equal(events.length, 0);
});

test('텍스트 없는 댓글도 통과시킨다 — 키워드 판정은 다음 단계의 일이다', () => {
  const { events } = normalize(commentPayload(comment({ text: undefined })), ME);
  assert.equal(events.length, 1);
  assert.equal((events[0] as { text?: string }).text, undefined);
});

// ── 메시지 ────────────────────────────────────────────────────────

test('메시지는 entry[].messaging[] 에서 읽는다', () => {
  const { events, skipped } = normalize(
    messagePayload({
      sender: { id: THEM },
      recipient: { id: ME },
      timestamp: 1760000000000,
      message: { mid: 'mid.abc', text: '네' },
    }),
    ME,
  );
  assert.equal(skipped.length, 0);
  assert.deepEqual(events, [
    { kind: 'MESSAGE', igUserId: ME, messageId: 'mid.abc', igsid: THEM, text: '네' },
  ]);
});

test('is_echo 는 ECHO 로 건너뛴다 — 없으면 무한루프', () => {
  const { events, skipped } = normalize(
    messagePayload({
      sender: { id: ME },
      recipient: { id: THEM },
      message: { mid: 'mid.echo', text: '팔로워인지 확인할게요!', is_echo: true },
    }),
    ME,
  );
  assert.equal(events.length, 0);
  assert.equal(skipped[0]?.reason, 'ECHO');
});

test('is_self 도 ECHO 로 건너뛴다', () => {
  const { skipped } = normalize(
    messagePayload({ sender: { id: THEM }, message: { mid: 'm', text: 'x', is_self: true } }),
    ME,
  );
  assert.equal(skipped[0]?.reason, 'ECHO');
});

test('플래그가 없어도 sender 가 나 자신이면 ECHO 다', () => {
  // 플래그를 안 주는 경우를 대비한 두 번째 방어선
  const { events, skipped } = normalize(
    messagePayload({ sender: { id: ME }, message: { mid: 'm', text: 'x' } }),
    ME,
  );
  assert.equal(events.length, 0);
  assert.equal(skipped[0]?.reason, 'ECHO');
});

test('텍스트 없는 메시지는 NO_TEXT — 스티커·리액션', () => {
  const { events, skipped } = normalize(
    messagePayload({ sender: { id: THEM }, message: { mid: 'm', attachments: [{ type: 'image' }] } }),
    ME,
  );
  assert.equal(events.length, 0);
  assert.equal(skipped[0]?.reason, 'NO_TEXT');
});

test('echo 판정이 NO_TEXT 보다 먼저다 — 통계가 정확해야 한다', () => {
  const { skipped } = normalize(
    messagePayload({ sender: { id: ME }, message: { mid: 'm', is_echo: true } }),
    ME,
  );
  assert.equal(skipped[0]?.reason, 'ECHO');
});

test('message 가 없는 이벤트(read/delivery)는 조용히 무시한다', () => {
  const { events, skipped } = normalize(
    messagePayload({ sender: { id: THEM }, read: { mid: 'm' } }),
    ME,
  );
  assert.equal(events.length, 0);
  assert.equal(skipped.length, 0);
});

// ── 테넌트 격리 ───────────────────────────────────────────────────

test('다른 계정으로 온 이벤트는 ACCOUNT_MISMATCH 로 버린다', () => {
  const { events, skipped } = normalize(commentPayload(comment(), '99999999999999999'), ME);
  assert.equal(events.length, 0);
  assert.equal(skipped[0]?.reason, 'ACCOUNT_MISMATCH');
  assert.equal(skipped[0]?.igUserId, '99999999999999999');
});

// ── 배치 ──────────────────────────────────────────────────────────

test('한 요청에 entry 와 changes 가 여러 개 올 수 있다', () => {
  const { events } = normalize(
    {
      object: 'instagram',
      entry: [
        {
          id: ME,
          changes: [
            { field: 'comments', value: comment({ id: 'c1' }) },
            { field: 'comments', value: comment({ id: 'c2' }) },
            { field: 'mentions', value: { id: 'ignored' } }, // 구독하지 않은 필드
          ],
        },
        {
          id: ME,
          messaging: [{ sender: { id: THEM }, message: { mid: 'm1', text: '네' } }],
        },
      ],
    },
    ME,
  );
  assert.deepEqual(
    events.map((e) => (e.kind === 'COMMENT' ? e.commentId : e.messageId)),
    ['c1', 'c2', 'm1'],
  );
});

// ── 신뢰할 수 없는 입력 ───────────────────────────────────────────

test('쓰레기 입력에도 예외를 던지지 않는다', () => {
  for (const bad of [null, undefined, 0, '', 'string', [], {}, { object: 'page' }, { object: 'instagram' }]) {
    const r = normalize(bad, ME);
    assert.deepEqual(r, { events: [], skipped: [] }, `입력: ${JSON.stringify(bad)}`);
  }
});

test('entry 안이 망가져 있어도 살아있는 항목은 처리한다', () => {
  const { events } = normalize(
    {
      object: 'instagram',
      entry: [null, 'nope', { id: ME, changes: 'not-an-array' }, { id: ME, changes: [{ field: 'comments', value: comment() }] }],
    },
    ME,
  );
  assert.equal(events.length, 1);
});
