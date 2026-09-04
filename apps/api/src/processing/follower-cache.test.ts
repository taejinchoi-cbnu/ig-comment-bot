import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOWER_TTL_MS, isKnownFollower } from './follower-cache.ts';

const NOW = 1_800_000_000_000;
const ago = (ms: number) => new Date(NOW - ms);

test('팔로워로 확인됐고 TTL 이내면 참', () => {
  assert.equal(isKnownFollower({ isFollower: true, followerCheckedAt: ago(1000) }, NOW), true);
});

test('TTL 이 지나면 거짓 — 그 사이 언팔했을 수 있다', () => {
  assert.equal(
    isKnownFollower({ isFollower: true, followerCheckedAt: ago(FOLLOWER_TTL_MS + 1) }, NOW),
    false,
  );
});

test('TTL 경계에서는 거짓 (미만일 때만 유효)', () => {
  assert.equal(
    isKnownFollower({ isFollower: true, followerCheckedAt: ago(FOLLOWER_TTL_MS) }, NOW),
    false,
  );
});

// false(비팔로워로 확인됨)와 null(모름)을 구분하지 않는다. 참일 때만 단계를 건너뛰므로
// 애매하면 기존 2단계로 가는 쪽이 안전하다.
test('비팔로워로 확인됐으면 거짓', () => {
  assert.equal(isKnownFollower({ isFollower: false, followerCheckedAt: ago(1000) }, NOW), false);
});

test('아직 모르면 거짓', () => {
  assert.equal(isKnownFollower({ isFollower: null, followerCheckedAt: null }, NOW), false);
});

test('대화 자체가 없으면 거짓 — 처음 보는 사람', () => {
  assert.equal(isKnownFollower(null, NOW), false);
  assert.equal(isKnownFollower(undefined, NOW), false);
});

// 값만 있고 시점이 없으면 만료 판정이 불가능하므로 신뢰하지 않는다.
test('followerCheckedAt 이 없으면 isFollower 가 참이어도 거짓', () => {
  assert.equal(isKnownFollower({ isFollower: true, followerCheckedAt: null }, NOW), false);
});

test('TTL 은 주입할 수 있다', () => {
  const cache = { isFollower: true, followerCheckedAt: ago(5000) };
  assert.equal(isKnownFollower(cache, NOW, 10_000), true);
  assert.equal(isKnownFollower(cache, NOW, 1_000), false);
});
