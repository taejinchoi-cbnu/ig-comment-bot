import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { loadSecrets, resetSecretsCache } from './secrets.ts';

const VALID_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const VALID_JSON = JSON.stringify({
  DATABASE_URL: 'postgresql://user:pw@host/db',
  MASTER_KEY: VALID_KEY_B64,
});

/** 호출 횟수를 세는 가짜 SecretsManagerClient. */
function fakeClient(secretString: string | undefined, callCount: { count: number }): SecretsManagerClient {
  return {
    send: async () => {
      callCount.count += 1;
      return { SecretString: secretString };
    },
  } as unknown as SecretsManagerClient;
}

test('정상 로드: JSON 이 AppSecrets 로 파싱된다 (masterKey 32바이트 Buffer)', async () => {
  resetSecretsCache();
  const calls = { count: 0 };
  const secrets = await loadSecrets({ secretId: 'test/secret', client: fakeClient(VALID_JSON, calls) });

  assert.equal(secrets.databaseUrl, 'postgresql://user:pw@host/db');
  assert.ok(Buffer.isBuffer(secrets.masterKey));
  assert.equal(secrets.masterKey.length, 32);
});

test('캐시: loadSecrets 를 두 번 불러도 client.send 는 1회만 호출된다', async () => {
  resetSecretsCache();
  const calls = { count: 0 };
  const client = fakeClient(VALID_JSON, calls);

  await loadSecrets({ secretId: 'test/secret', client });
  await loadSecrets({ secretId: 'test/secret', client });

  assert.equal(calls.count, 1);
});

test('동시 호출: Promise.all 로 여러 번 불러도 client.send 는 1회만 호출된다', async () => {
  resetSecretsCache();
  const calls = { count: 0 };
  const client = fakeClient(VALID_JSON, calls);

  await Promise.all([
    loadSecrets({ secretId: 'test/secret', client }),
    loadSecrets({ secretId: 'test/secret', client }),
    loadSecrets({ secretId: 'test/secret', client }),
  ]);

  assert.equal(calls.count, 1);
});

test('실패는 캐시하지 않는다: 첫 호출이 실패하면 두 번째 호출이 다시 fetch 를 시도한다', async () => {
  resetSecretsCache();
  const calls = { count: 0 };
  // 첫 호출은 SecretString 없이 실패, 두 번째부터는 정상 값을 주는 가짜 클라이언트
  const client = {
    send: async () => {
      calls.count += 1;
      if (calls.count === 1) return { SecretString: undefined };
      return { SecretString: VALID_JSON };
    },
  } as unknown as SecretsManagerClient;

  await assert.rejects(loadSecrets({ secretId: 'test/secret', client }));
  const secrets = await loadSecrets({ secretId: 'test/secret', client });

  assert.equal(secrets.databaseUrl, 'postgresql://user:pw@host/db');
  assert.equal(calls.count, 2);
});

test('APP_SECRET_ID 도 secretId 도 없으면 throw 한다', async () => {
  resetSecretsCache();
  const prev = process.env.APP_SECRET_ID;
  delete process.env.APP_SECRET_ID;
  try {
    await assert.rejects(loadSecrets({ client: fakeClient(VALID_JSON, { count: 0 }) }), /APP_SECRET_ID/);
  } finally {
    if (prev !== undefined) process.env.APP_SECRET_ID = prev;
  }
});

test('SecretString 이 JSON 이 아니면 throw 한다', async () => {
  resetSecretsCache();
  const calls = { count: 0 };
  await assert.rejects(loadSecrets({ secretId: 'test/secret', client: fakeClient('이건 JSON 이 아님', calls) }));
});

test('DATABASE_URL 이 없으면 throw 한다', async () => {
  resetSecretsCache();
  const json = JSON.stringify({ MASTER_KEY: VALID_KEY_B64 });
  const calls = { count: 0 };
  await assert.rejects(
    loadSecrets({ secretId: 'test/secret', client: fakeClient(json, calls) }),
    /DATABASE_URL/,
  );
});

test('MASTER_KEY 가 없으면 throw 한다', async () => {
  resetSecretsCache();
  const json = JSON.stringify({ DATABASE_URL: 'postgresql://user:pw@host/db' });
  const calls = { count: 0 };
  await assert.rejects(loadSecrets({ secretId: 'test/secret', client: fakeClient(json, calls) }), /MASTER_KEY/);
});

test('MASTER_KEY 가 16바이트면 throw 한다', async () => {
  resetSecretsCache();
  const json = JSON.stringify({
    DATABASE_URL: 'postgresql://user:pw@host/db',
    MASTER_KEY: Buffer.alloc(16, 1).toString('base64'),
  });
  const calls = { count: 0 };
  await assert.rejects(loadSecrets({ secretId: 'test/secret', client: fakeClient(json, calls) }), /32/);
});

test('MASTER_KEY 가 64바이트면 throw 한다', async () => {
  resetSecretsCache();
  const json = JSON.stringify({
    DATABASE_URL: 'postgresql://user:pw@host/db',
    MASTER_KEY: Buffer.alloc(64, 1).toString('base64'),
  });
  const calls = { count: 0 };
  await assert.rejects(loadSecrets({ secretId: 'test/secret', client: fakeClient(json, calls) }), /32/);
});

test('에러 메시지에 시크릿 값이 들어있지 않다', async () => {
  const dbUrl = 'postgresql://secretuser:secretpass@host/db';
  const badKeyB64 = Buffer.alloc(16, 9).toString('base64');
  const json = JSON.stringify({ DATABASE_URL: dbUrl, MASTER_KEY: badKeyB64 });

  resetSecretsCache();
  const calls = { count: 0 };
  try {
    await loadSecrets({ secretId: 'test/secret', client: fakeClient(json, calls) });
    assert.fail('throw 했어야 한다');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(dbUrl), 'DATABASE_URL 값이 에러 메시지에 노출됨');
    assert.ok(!message.includes(badKeyB64), 'MASTER_KEY 원문이 에러 메시지에 노출됨');
  }

  // JSON 파싱 실패 케이스도 원문이 노출되지 않는지 확인
  resetSecretsCache();
  const secretLookingText = 'MASTER_KEY=super-secret-not-json';
  try {
    await loadSecrets({ secretId: 'test/secret', client: fakeClient(secretLookingText, { count: 0 }) });
    assert.fail('throw 했어야 한다');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(secretLookingText), '원문 SecretString 이 에러 메시지에 노출됨');
  }
});
