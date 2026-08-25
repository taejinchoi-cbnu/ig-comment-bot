import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawBody, signBody, verifySignature } from './signature.ts';

const IG_SECRET = 'instagram-app-secret';
const META_SECRET = 'parent-meta-app-secret';
const BODY = JSON.stringify({ object: 'instagram', entry: [{ id: '1' }] });

test('Instagram app secret 으로 서명된 요청을 통과시킨다', () => {
  const sig = signBody(BODY, IG_SECRET);
  assert.equal(verifySignature(BODY, sig, [IG_SECRET, META_SECRET]), true);
});

test('상위 Meta app secret 으로 서명돼도 통과시킨다', () => {
  // 앱 구성에 따라 서명 키가 달라진다. 한쪽만 보면 403 만 반복된다
  const sig = signBody(BODY, META_SECRET);
  assert.equal(verifySignature(BODY, sig, [IG_SECRET, META_SECRET]), true);
});

test('둘 다 아닌 시크릿으로 서명하면 거부한다', () => {
  const sig = signBody(BODY, 'wrong-secret');
  assert.equal(verifySignature(BODY, sig, [IG_SECRET, META_SECRET]), false);
});

test('본문이 한 바이트라도 다르면 거부한다', () => {
  const sig = signBody(BODY, IG_SECRET);
  assert.equal(verifySignature(BODY + ' ', sig, [IG_SECRET]), false);
});

test('base64 로 전달된 본문도 디코드 후 검증하면 통과한다', () => {
  // Function URL / API Gateway 가 isBase64Encoded 로 줄 수 있다
  const encoded = Buffer.from(BODY, 'utf8').toString('base64');
  const sig = signBody(BODY, IG_SECRET);
  assert.equal(verifySignature(rawBody(encoded, true), sig, [IG_SECRET]), true);
});

test('base64 본문을 디코드하지 않으면 당연히 실패한다 — 회귀 방지', () => {
  const encoded = Buffer.from(BODY, 'utf8').toString('base64');
  const sig = signBody(BODY, IG_SECRET);
  assert.equal(verifySignature(rawBody(encoded, false), sig, [IG_SECRET]), false);
});

test('JSON 을 다시 직렬화하면 서명이 깨질 수 있다 — 원본 바이트를 써야 하는 이유', () => {
  const pretty = JSON.stringify(JSON.parse(BODY), null, 2); // 공백이 추가된 같은 객체
  const sig = signBody(BODY, IG_SECRET);
  assert.equal(verifySignature(pretty, sig, [IG_SECRET]), false);
});

test('헤더가 없거나 접두사가 틀리면 거부한다', () => {
  const hex = signBody(BODY, IG_SECRET).slice('sha256='.length);
  assert.equal(verifySignature(BODY, undefined, [IG_SECRET]), false);
  assert.equal(verifySignature(BODY, '', [IG_SECRET]), false);
  assert.equal(verifySignature(BODY, hex, [IG_SECRET]), false);
  assert.equal(verifySignature(BODY, 'sha1=' + hex, [IG_SECRET]), false);
});

test('길이가 다른 서명에도 예외를 던지지 않는다', () => {
  // timingSafeEqual 은 길이가 다르면 throw 한다. 먼저 걸러야 한다
  for (const bad of ['sha256=', 'sha256=abc', 'sha256=' + 'a'.repeat(63), 'sha256=' + 'a'.repeat(65)]) {
    assert.equal(verifySignature(BODY, bad, [IG_SECRET]), false, bad);
  }
});

test('hex 가 아닌 문자가 섞이면 거부한다', () => {
  assert.equal(verifySignature(BODY, 'sha256=' + 'z'.repeat(64), [IG_SECRET]), false);
});

test('대문자 hex 도 받아들인다', () => {
  const sig = signBody(BODY, IG_SECRET).toUpperCase().replace('SHA256=', 'sha256=');
  assert.equal(verifySignature(BODY, sig, [IG_SECRET]), true);
});

test('시크릿이 없거나 비어 있으면 무조건 거부한다', () => {
  const sig = signBody(BODY, IG_SECRET);
  assert.equal(verifySignature(BODY, sig, []), false);
  assert.equal(verifySignature(BODY, sig, [undefined, '']), false);
});

test('빈 본문도 일관되게 처리한다', () => {
  const sig = signBody('', IG_SECRET);
  assert.equal(verifySignature(rawBody(undefined, false), sig, [IG_SECRET]), true);
});
