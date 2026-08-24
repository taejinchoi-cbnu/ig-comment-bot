import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTrigger } from './trigger.ts';

test('키워드가 없으면 모든 댓글을 통과시킨다', () => {
  assert.equal(shouldTrigger('아무 말', []), true);
  assert.equal(shouldTrigger('', []), true);
  assert.equal(shouldTrigger(undefined, []), true);
});

test('키워드가 있으면 포함될 때만 통과시킨다', () => {
  assert.equal(shouldTrigger('예약하고 싶어요', ['예약']), true);
  assert.equal(shouldTrigger('예뻐요', ['예약']), false);
});

test('텍스트가 없는 댓글은 키워드가 있으면 통과하지 못한다', () => {
  assert.equal(shouldTrigger(undefined, ['예약']), false);
  assert.equal(shouldTrigger('', ['예약']), false);
});

test('대소문자를 구분하지 않는다', () => {
  assert.equal(shouldTrigger('SEND me INFO', ['info']), true);
  assert.equal(shouldTrigger('info', ['INFO']), true);
});

test('키워드 하나만 맞아도 통과한다', () => {
  assert.equal(shouldTrigger('자료 주세요', ['예약', '자료', '참여']), true);
});

test('빈 문자열 키워드는 무시한다 — 전부 통과시키면 안 된다', () => {
  // "예약,,참여" 처럼 사용자가 쉼표를 잘못 넣은 경우
  assert.equal(shouldTrigger('안녕하세요', ['예약', '', '참여']), false);
});
