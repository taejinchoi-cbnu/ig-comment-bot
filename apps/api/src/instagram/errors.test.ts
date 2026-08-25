import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramApiError, isRetryableStatus, networkError, toApiError } from './errors.ts';

function metaErrorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

test('429는 재시도 가능으로 분류한다', () => {
  assert.equal(isRetryableStatus(429), true);
});

test('5xx는 재시도 가능으로 분류한다', () => {
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
});

test('400/401/403은 재시도 불가로 분류한다', () => {
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
});

test('status가 없으면(네트워크 오류) 재시도 가능으로 분류한다', () => {
  assert.equal(isRetryableStatus(undefined), true);
});

test('Meta 에러 본문의 message/code/error_subcode/type을 파싱한다', async () => {
  const res = metaErrorResponse(400, {
    error: { message: '잘못된 comment_id 입니다', code: 100, error_subcode: 33, type: 'OAuthException' },
  });
  const err = await toApiError(res, 'sendPrivateReply');
  assert.ok(err instanceof InstagramApiError);
  assert.equal(err.status, 400);
  assert.equal(err.code, 100);
  assert.equal(err.errorSubcode, 33);
  assert.equal(err.type, 'OAuthException');
  assert.equal(err.retryable, false);
  // 회귀 방지: Meta의 message는 400 진단에 필요해 포함해야 한다
  assert.match(err.message, /잘못된 comment_id 입니다/);
});

test('Meta message가 512자를 넘으면 잘라서 담는다', async () => {
  const longMessage = 'a'.repeat(600);
  const res = metaErrorResponse(400, { error: { message: longMessage, code: 1 } });
  const err = await toApiError(res, 'sendMessage');
  const includedMessage = err.message.split('message=')[1];
  assert.ok(includedMessage);
  assert.equal(includedMessage!.length, 512);
});

test('에러 본문이 JSON이 아니어도 던지지 않고 InstagramApiError를 만든다', async () => {
  const res = new Response('<html>not json</html>', { status: 500 });
  const err = await toApiError(res, 'getMe');
  assert.ok(err instanceof InstagramApiError);
  assert.equal(err.status, 500);
  assert.equal(err.retryable, true);
});

test('에러 본문이 비어 있어도 InstagramApiError를 만든다', async () => {
  const res = new Response('', { status: 401 });
  const err = await toApiError(res, 'subscribeApp');
  assert.ok(err instanceof InstagramApiError);
  assert.equal(err.status, 401);
  assert.equal(err.retryable, false);
  assert.equal(err.code, undefined);
});

test('networkError는 항상 retryable true인 InstagramApiError를 만든다', () => {
  const err = networkError(new Error('fetch failed: ECONNRESET'), 'sendMessage');
  assert.ok(err instanceof InstagramApiError);
  assert.equal(err.retryable, true);
  assert.equal(err.status, undefined);
});
