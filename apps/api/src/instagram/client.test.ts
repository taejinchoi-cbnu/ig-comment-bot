import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramApiClient } from './client.ts';
import { InstagramApiError } from './errors.ts';

const IG_USER_ID = '17841400000000000';
const ACCESS_TOKEN = 'super-secret-long-lived-token';

type Call = { url: string; init: RequestInit };

/** 호출을 calls 배열에 기록하고 지정된 Response(들)를 순서대로 돌려주는 가짜 fetch. */
function fakeFetch(calls: Call[], ...responses: Response[]): typeof fetch {
  let i = 0;
  return (async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const res = responses[i];
    i += 1;
    if (!res) throw new Error('fakeFetch: 준비된 응답보다 많이 호출됨');
    return res;
  }) as typeof fetch;
}

function throwingFetch(cause: Error): typeof fetch {
  return (async () => {
    throw cause;
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('sendPrivateReply는 정확한 URL/메서드/헤더/본문(recipient.comment_id)을 만든다', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, jsonResponse(200, { recipient_id: 'igsid-1', message_id: 'mid-1' })),
  });

  await client.sendPrivateReply('comment-123', '안녕하세요');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `https://graph.instagram.com/v25.0/${IG_USER_ID}/messages`);
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body as string), {
    recipient: { comment_id: 'comment-123' },
    message: { text: '안녕하세요' },
  });
});

test('sendMessage는 정확한 URL/메서드/헤더/본문(recipient.id)을 만든다', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, jsonResponse(200, { recipient_id: 'igsid-2', message_id: 'mid-2' })),
  });

  await client.sendMessage('igsid-2', '네 확인했습니다');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `https://graph.instagram.com/v25.0/${IG_USER_ID}/messages`);
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(JSON.parse(call.init.body as string), {
    recipient: { id: 'igsid-2' },
    message: { text: '네 확인했습니다' },
  });
});

test('성공 응답을 recipientId/messageId로 파싱한다', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, jsonResponse(200, { recipient_id: 'igsid-3', message_id: 'mid-3' })),
  });

  const result = await client.sendMessage('igsid-3', 'ok');
  assert.deepEqual(result, { recipientId: 'igsid-3', messageId: 'mid-3' });
});

test('429는 InstagramApiError이고 retryable === true', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, jsonResponse(429, { error: { message: 'rate limited', code: 4 } })),
  });

  await assert.rejects(
    () => client.sendMessage('igsid', 'text'),
    (err: unknown) => {
      assert.ok(err instanceof InstagramApiError);
      assert.equal(err.retryable, true);
      assert.equal(err.status, 429);
      return true;
    },
  );
});

test('500/503은 retryable === true', async () => {
  for (const status of [500, 503]) {
    const calls: Call[] = [];
    const client = new InstagramApiClient({
      igUserId: IG_USER_ID,
      accessToken: ACCESS_TOKEN,
      fetchImpl: fakeFetch(calls, jsonResponse(status, { error: { message: 'server error' } })),
    });

    await assert.rejects(
      () => client.sendPrivateReply('comment', 'text'),
      (err: unknown) => {
        assert.ok(err instanceof InstagramApiError);
        assert.equal(err.retryable, true);
        assert.equal(err.status, status);
        return true;
      },
    );
  }
});

test('400/401/403은 retryable === false', async () => {
  for (const status of [400, 401, 403]) {
    const calls: Call[] = [];
    const client = new InstagramApiClient({
      igUserId: IG_USER_ID,
      accessToken: ACCESS_TOKEN,
      fetchImpl: fakeFetch(calls, jsonResponse(status, { error: { message: '권한이 없습니다' } })),
    });

    await assert.rejects(
      () => client.sendPrivateReply('comment', 'text'),
      (err: unknown) => {
        assert.ok(err instanceof InstagramApiError);
        assert.equal(err.retryable, false);
        assert.equal(err.status, status);
        return true;
      },
    );
  }
});

test('fetch가 throw하면(네트워크 오류) InstagramApiError이고 retryable === true', async () => {
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: throwingFetch(new Error('ECONNRESET')),
  });

  await assert.rejects(
    () => client.sendMessage('igsid', 'text'),
    (err: unknown) => {
      assert.ok(err instanceof InstagramApiError);
      assert.equal(err.retryable, true);
      assert.equal(err.status, undefined);
      return true;
    },
  );
});

test('에러 메시지에 access token과 DM 문구가 들어있지 않다', async () => {
  const dmText = '이것은 절대 로그에 남으면 안 되는 개인정보 DM 문구입니다';
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, jsonResponse(400, { error: { message: '잘못된 요청', code: 100 } })),
  });

  await assert.rejects(
    () => client.sendMessage('igsid', dmText),
    (err: unknown) => {
      assert.ok(err instanceof InstagramApiError);
      assert.equal(err.message.includes(ACCESS_TOKEN), false);
      assert.equal(err.message.includes(dmText), false);
      return true;
    },
  );
});

test('Meta의 error.message는 에러 메시지에 포함된다 (400 진단에 필요)', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(
      calls,
      jsonResponse(400, { error: { message: 'Private reply already sent for this comment', code: 10 } }),
    ),
  });

  await assert.rejects(
    () => client.sendPrivateReply('comment-1', 'hi'),
    (err: unknown) => {
      assert.ok(err instanceof InstagramApiError);
      assert.match(err.message, /Private reply already sent for this comment/);
      return true;
    },
  );
});

test('apiVersion을 덮어쓰면 URL이 바뀐다', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    apiVersion: 'v99.0',
    fetchImpl: fakeFetch(calls, jsonResponse(200, { recipient_id: 'a', message_id: 'b' })),
  });

  await client.sendMessage('igsid', 'text');

  assert.equal(calls[0]!.url, `https://graph.instagram.com/v99.0/${IG_USER_ID}/messages`);
});

test('subscribeApp은 올바른 쿼리스트링으로 POST한다', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, jsonResponse(200, { success: true })),
  });

  await client.subscribeApp();

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(
    call.url,
    'https://graph.instagram.com/v25.0/me/subscribed_apps?subscribed_fields=comments,messages',
  );
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
});

test('getMe는 GET /me?fields=user_id,username 을 호출하고 결과를 파싱한다', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, jsonResponse(200, { user_id: IG_USER_ID, username: 'my_shop' })),
  });

  const me = await client.getMe();

  assert.equal(calls[0]!.url, 'https://graph.instagram.com/v25.0/me?fields=user_id,username');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.deepEqual(me, { userId: IG_USER_ID, username: 'my_shop' });
});

test('getMe 응답에 user_id 가 없으면 실패로 본다 — 빈 값으로 검증 통과시키지 않는다', async () => {
  const client = new InstagramApiClient({
    igUserId: 'me',
    accessToken: 'tok',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ username: 'someone' }), { status: 200 })) as unknown as typeof fetch,
  });
  await assert.rejects(() => client.getMe());
});

test('getSubscribedFields: 여러 구독 항목의 필드를 평평하게 모은다', async () => {
  const client = new InstagramApiClient({
    igUserId: 'ig-1',
    accessToken: 'tok',
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ subscribed_fields: ['comments', 'messages'] }] }), { status: 200 }),
  });
  assert.deepEqual(await client.getSubscribedFields(), ['comments', 'messages']);
});

// 이게 이 메서드가 존재하는 이유다. Meta 는 앱 레벨에서 구독하지 않은 필드를 조용히
// 버리면서도 subscribeApp 에는 success:true 를 돌려준다 — 되읽기만이 진실을 말한다.
test('getSubscribedFields: 일부만 걸린 상태를 그대로 드러낸다', async () => {
  const client = new InstagramApiClient({
    igUserId: 'ig-1',
    accessToken: 'tok',
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ subscribed_fields: ['messages'] }] }), { status: 200 }),
  });
  assert.deepEqual(await client.getSubscribedFields(), ['messages']);
});

test('getSubscribedFields: data 가 비면 빈 배열', async () => {
  const client = new InstagramApiClient({
    igUserId: 'ig-1',
    accessToken: 'tok',
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  });
  assert.deepEqual(await client.getSubscribedFields(), []);
});

// ── 공개 대댓글 ───────────────────────────────────────────────────

test('replyToComment: /{commentId}/replies 로 message 를 POST 한다', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, new Response(JSON.stringify({ id: '17873440459141029' }), { status: 200 })),
  });

  const result = await client.replyToComment('comment_1', 'DM 발송 완료!');

  assert.equal(result.id, '17873440459141029');
  assert.equal(calls[0]?.url, 'https://graph.instagram.com/v25.0/comment_1/replies');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { message: 'DM 발송 완료!' });
});

test('replyToComment: 실패는 InstagramApiError 로 변환된다', async () => {
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch([], new Response(JSON.stringify({ error: { message: 'bad', code: 100 } }), { status: 400 })),
  });

  await assert.rejects(() => client.replyToComment('comment_1', '안녕'), InstagramApiError);
});

// ── 팔로워 여부 ───────────────────────────────────────────────────

test('isUserFollowBusiness: IGSID 노드에서 필드를 읽는다', async () => {
  const calls: Call[] = [];
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch(calls, new Response(JSON.stringify({ is_user_follow_business: true }), { status: 200 })),
  });

  assert.equal(await client.isUserFollowBusiness('igsid_1'), true);
  assert.equal(
    calls[0]?.url,
    'https://graph.instagram.com/v25.0/igsid_1?fields=is_user_follow_business',
  );
});

// 던지면 양식 발송 흐름이 깨진다. 팔로워 여부는 발송의 전제조건이 아니다.
test('isUserFollowBusiness: 실패하면 던지지 않고 null 을 돌려준다', async () => {
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch([], new Response(JSON.stringify({ error: { message: 'no' } }), { status: 400 })),
  });

  assert.equal(await client.isUserFollowBusiness('igsid_1'), null);
});

test('isUserFollowBusiness: 필드가 없으면 null (false 로 단정하지 않는다)', async () => {
  const client = new InstagramApiClient({
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    fetchImpl: fakeFetch([], new Response(JSON.stringify({ id: 'igsid_1' }), { status: 200 })),
  });

  assert.equal(await client.isUserFollowBusiness('igsid_1'), null);
});
