import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 고객의 Instagram access token / App secret 을 DB 컬럼(String)에 암호문으로
 * 저장하기 위한 대칭키 암호화입니다.
 *
 * AES-256-GCM 을 씁니다 — 인증 태그 덕분에 변조된 암호문을 조용히 통과시키지
 * 않습니다. IV 는 레코드마다 랜덤 12바이트(GCM 권장 길이)를 씁니다.
 *
 * 마스터 키는 이 모듈이 직접 만들지 않습니다. 호출자가 Buffer 로 주입합니다
 * (운영에서는 KMS/Secrets Manager 등에서 가져온 값). AWS SDK 의존을 피해야
 * node --test 로 그대로 테스트할 수 있습니다.
 *
 * 출력 형식: `v1.<iv>.<tag>.<ciphertext>` (각각 base64url).
 * 버전 접두사를 두는 이유는 나중에 알고리즘/파라미터를 바꿀 때 옛 암호문을
 * 구분해 마이그레이션할 수 있어야 하기 때문입니다.
 *
 * 순수 함수로 유지하세요 (node --test 대상, Nest 데코레이터 금지).
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM 권장 nonce 길이
const TAG_LENGTH = 16; // GCM 인증 태그. 아래 decrypt 의 길이 검사 참고
const SEPARATOR = '.';

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    const gotLength = Buffer.isBuffer(key) ? key.length : 'not-a-buffer';
    throw new Error(`암호화 키는 ${KEY_LENGTH}바이트여야 합니다 (받은 길이: ${gotLength})`);
  }
}

/** 운영자가 마스터 키를 새로 만들 때 / 테스트용. */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function encrypt(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    SEPARATOR,
  );
}

export function decrypt(payload: string, key: Buffer): string {
  assertKey(key);

  const parts = payload.split(SEPARATOR);
  if (parts.length !== 4) {
    throw new Error('암호문 형식이 올바르지 않습니다 (구분자 개수 불일치)');
  }
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (version !== VERSION) {
    // payload에서 뽑은 버전 문자열을 에러 메시지에 그대로 넣지 않습니다 — 공격자가
    // 통제하는 값이 로그에 그대로 찍히면 로그를 오염시키거나 후속 파서를 속일 수
    // 있고("로그 인젝션"), "형식이 틀렸다"는 사실 이상으로 얻는 진단 이득도 없습니다.
    throw new Error('지원하지 않는 암호문 형식입니다');
  }
  if (ivB64 === undefined || tagB64 === undefined || ciphertextB64 === undefined) {
    throw new Error('암호문 형식이 올바르지 않습니다');
  }

  try {
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const ciphertext = Buffer.from(ciphertextB64, 'base64url');
    if (iv.length !== IV_LENGTH) {
      throw new Error('IV 길이가 올바르지 않습니다');
    }
    // 태그 길이를 반드시 검사합니다. Node 의 setAuthTag 는 GCM 에서 4바이트처럼
    // 잘린 태그도 받아들이는데, 그러면 위조 난이도가 2^128 에서 2^32 로 떨어집니다.
    // 우리는 항상 16바이트로 만들므로 그 외는 조작된 값으로 봅니다.
    if (tag.length !== TAG_LENGTH) {
      throw new Error('인증 태그 길이가 올바르지 않습니다');
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // base64 디코딩 실패, IV/태그 길이 오류, GCM 인증 실패(변조 또는 키 불일치)를
    // 모두 하나의 메시지로 묶습니다. 세분화해서 노출하면 공격자에게 어느
    // 지점이 틀렸는지 알려주는 오라클이 됩니다. 평문·키·암호문은 절대 담지 않습니다.
    throw new Error('복호화에 실패했습니다: 손상된 데이터이거나 키가 일치하지 않습니다');
  }
}
