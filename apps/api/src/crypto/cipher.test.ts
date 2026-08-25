import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt, encrypt, generateKey } from './cipher.ts';

const KEY = generateKey();

function flipOneBit(base64url: string): string {
  const buf = Buffer.from(base64url, 'base64url');
  buf[0] = (buf[0] ?? 0) ^ 0x01; // 첫 바이트의 최하위 비트를 뒤집는다
  return buf.toString('base64url');
}

// ── 왕복 ──────────────────────────────────────────────────────────

const roundTripCases: readonly [string, string][] = [
  ['ASCII', 'hello instagram token'],
  ['한국어', '안녕하세요, 인스타그램 액세스 토큰입니다'],
  ['이모지', '토큰이에요 🔐🎉😀'],
  ['빈 문자열', ''],
  ['매우 긴 문자열', 'a'.repeat(100_000)],
];

for (const [label, plaintext] of roundTripCases) {
  test(`왕복: ${label} 평문이 그대로 복호화된다`, () => {
    const encrypted = encrypt(plaintext, KEY);
    assert.equal(decrypt(encrypted, KEY), plaintext);
  });
}

test('같은 평문을 두 번 암호화하면 결과가 다르다 (랜덤 IV)', () => {
  const plaintext = 'duplicate-token-value';
  const a = encrypt(plaintext, KEY);
  const b = encrypt(plaintext, KEY);
  assert.notEqual(a, b);
  assert.equal(decrypt(a, KEY), plaintext);
  assert.equal(decrypt(b, KEY), plaintext);
});

test('다른 키로 복호화하면 실패한다', () => {
  const encrypted = encrypt('secret-token', KEY);
  const wrongKey = generateKey();
  assert.throws(() => decrypt(encrypted, wrongKey));
});

// ── 변조 ──────────────────────────────────────────────────────────

test('IV를 변조하면 복호화가 실패한다', () => {
  const encrypted = encrypt('secret-token', KEY);
  const [version, iv, tag, ciphertext] = encrypted.split('.');
  const tampered = [version, flipOneBit(iv!), tag, ciphertext].join('.');
  assert.throws(() => decrypt(tampered, KEY));
});

test('인증 태그를 변조하면 복호화가 실패한다', () => {
  const encrypted = encrypt('secret-token', KEY);
  const [version, iv, tag, ciphertext] = encrypted.split('.');
  const tampered = [version, iv, flipOneBit(tag!), ciphertext].join('.');
  assert.throws(() => decrypt(tampered, KEY));
});

test('암호문을 변조하면 복호화가 실패한다', () => {
  const encrypted = encrypt('secret-token', KEY);
  const [version, iv, tag, ciphertext] = encrypted.split('.');
  const tampered = [version, iv, tag, flipOneBit(ciphertext!)].join('.');
  assert.throws(() => decrypt(tampered, KEY));
});

// ── 잘못된 형식 ───────────────────────────────────────────────────

test('구분자 개수가 안 맞으면 던진다', () => {
  assert.throws(() => decrypt('v1.onlyoneparts', KEY));
  assert.throws(() => decrypt('v1.a.b.c.d', KEY)); // 너무 많음
});

test('버전 접두사가 다르면 던진다', () => {
  const encrypted = encrypt('secret-token', KEY);
  const withoutVersion = encrypted.split('.').slice(1).join('.');
  assert.throws(() => decrypt(`v2.${withoutVersion}`, KEY));
});

test('완전히 무작위한 문자열이면 던진다', () => {
  assert.throws(() => decrypt('this-is-not-a-valid-payload-at-all', KEY));
});

test('잘린 payload 는 던진다', () => {
  const encrypted = encrypt('secret-token', KEY);
  const truncated = encrypted.slice(0, Math.floor(encrypted.length / 2));
  assert.throws(() => decrypt(truncated, KEY));
});

// ── 키 검증 ───────────────────────────────────────────────────────

test('32바이트가 아닌 키로 암호화하면 던진다', () => {
  assert.throws(() => encrypt('token', Buffer.alloc(16)));
  assert.throws(() => encrypt('token', Buffer.alloc(64)));
});

test('32바이트가 아닌 키로 복호화하면 던진다', () => {
  const encrypted = encrypt('token', KEY);
  assert.throws(() => decrypt(encrypted, Buffer.alloc(16)));
});

// ── generateKey ──────────────────────────────────────────────────

test('generateKey 는 32바이트 키를 만든다', () => {
  assert.equal(generateKey().length, 32);
});

test('generateKey 는 호출마다 다른 값을 반환한다', () => {
  assert.notEqual(generateKey().toString('hex'), generateKey().toString('hex'));
});

test('잘린 인증 태그를 거부한다 — 위조 난이도가 떨어지는 것을 막는다', () => {
  // Node 의 setAuthTag 는 GCM 에서 4바이트 태그도 받아들인다. 검사하지 않으면
  // 공격자가 태그를 잘라 위조 비용을 2^128 에서 2^32 로 낮출 수 있다.
  const key = generateKey();
  const payload = encrypt('토큰', key);
  const parts = payload.split('.');
  const shortTag = Buffer.from(parts[2]!, 'base64url').subarray(0, 4).toString('base64url');
  const tampered = [parts[0], parts[1], shortTag, parts[3]].join('.');
  assert.throws(() => decrypt(tampered, key));
});

test('길이가 맞아도 태그가 다르면 거부한다', () => {
  const key = generateKey();
  const payload = encrypt('토큰', key);
  const parts = payload.split('.');
  const wrongTag = Buffer.alloc(16, 0x41).toString('base64url');
  const tampered = [parts[0], parts[1], wrongTag, parts[3]].join('.');
  assert.throws(() => decrypt(tampered, key));
});
