import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccountBySlug, type AccountLookup } from './account.service.ts';
import { encrypt, generateKey } from '../crypto/cipher.ts';

const MASTER_KEY = generateKey();
const OTHER_KEY = generateKey();

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc_1',
    igUserId: 'ig_1',
    slug: 'abc123',
    verifyToken: 'verify-token',
    accessTokenEnc: encrypt('access-token', MASTER_KEY),
    appSecretEnc: encrypt('primary-secret', MASTER_KEY),
    parentAppSecretEnc: null,
    defaultPrivateReplyText: null,
    defaultFollowUpText: null,
    ...overrides,
  };
}

function lookupOf(row: ReturnType<typeof buildRow> | null): AccountLookup {
  return { igAccount: { findUnique: async () => row } } as unknown as AccountLookup;
}

test('없는 slug 는 null', async () => {
  const result = await resolveAccountBySlug('nope', lookupOf(null), MASTER_KEY);
  assert.equal(result, null);
});

test('parentAppSecretEnc 가 없으면 후보가 하나뿐이다 (대부분의 경우)', async () => {
  const result = await resolveAccountBySlug('abc123', lookupOf(buildRow()), MASTER_KEY);
  assert.deepEqual(result?.appSecrets, ['primary-secret']);
});

test('parentAppSecretEnc 가 있으면 두 번째 후보로 들어간다', async () => {
  const row = buildRow({ parentAppSecretEnc: encrypt('parent-secret', MASTER_KEY) });
  const result = await resolveAccountBySlug('abc123', lookupOf(row), MASTER_KEY);
  assert.deepEqual(result?.appSecrets, ['primary-secret', 'parent-secret']);
});

test('appSecretEnc 복호화 실패는 전체를 null 로 만든다 — 검증할 방법이 없다', async () => {
  const row = buildRow({ appSecretEnc: 'v1.corrupted.garbage.data' });
  const result = await resolveAccountBySlug('abc123', lookupOf(row), MASTER_KEY);
  assert.equal(result, null);
});

test('parentAppSecretEnc 복호화 실패는 기본 후보만으로 계속한다 — 정상 서명 검증을 막지 않는다', async () => {
  const row = buildRow({ parentAppSecretEnc: 'v1.corrupted.garbage.data' });
  const result = await resolveAccountBySlug('abc123', lookupOf(row), MASTER_KEY);
  assert.deepEqual(result?.appSecrets, ['primary-secret']);
});

test('다른 마스터 키로는 appSecretEnc 를 못 풀어 null 이다', async () => {
  const row = buildRow({ appSecretEnc: encrypt('primary-secret', OTHER_KEY) });
  const result = await resolveAccountBySlug('abc123', lookupOf(row), MASTER_KEY);
  assert.equal(result, null);
});

test('accessToken 은 이 경로 결과에 없다 — webhook 은 Instagram API 를 호출하지 않는다', async () => {
  const result = await resolveAccountBySlug('abc123', lookupOf(buildRow()), MASTER_KEY);
  assert.equal((result as unknown as Record<string, unknown>)?.['accessToken'], undefined);
});
