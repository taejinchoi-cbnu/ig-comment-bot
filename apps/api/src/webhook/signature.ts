import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta webhook 의 X-Hub-Signature-256 검증.
 *
 * docs/meta-api.md 의 두 가지 함정을 여기서 처리합니다:
 *  · 앱 구성에 따라 서명 키가 Instagram app secret 이거나 상위 Meta app secret 입니다.
 *    한쪽만 시도하면 403 만 반복되고 원인을 찾기 어렵습니다 — 둘 다 시도합니다.
 *  · Function URL / API Gateway 가 본문을 base64 로 줄 수 있습니다.
 *    HMAC 은 반드시 디코드한 원본 바이트로 계산해야 합니다.
 *
 * 순수 함수로 유지하세요 (node --test 대상).
 */

const PREFIX = 'sha256=';
const HEX_LENGTH = 64; // sha256 hex digest

/**
 * API Gateway / Lambda Function URL 이 준 본문을 HMAC 계산용 원본 바이트로 되돌립니다.
 * JSON.parse 한 객체를 다시 문자열로 만들면 키 순서·공백이 달라져 서명이 깨집니다.
 * 반드시 이 함수의 결과로 검증하세요.
 */
export function rawBody(body: string | undefined, isBase64Encoded?: boolean): Buffer {
  if (!body) return Buffer.alloc(0);
  return isBase64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
}

export function verifySignature(
  body: Buffer | string,
  signatureHeader: string | undefined,
  appSecrets: readonly (string | undefined)[],
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(PREFIX)) return false;

  const received = signatureHeader.slice(PREFIX.length).toLowerCase();
  // timingSafeEqual 은 길이가 다르면 던집니다. 먼저 걸러냅니다.
  if (received.length !== HEX_LENGTH || !/^[0-9a-f]+$/.test(received)) return false;

  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const receivedBuf = Buffer.from(received, 'utf8');

  let matched = false;
  for (const secret of appSecrets) {
    if (!secret) continue;
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    // 하나를 찾아도 끝까지 돕니다 — 어느 시크릿이 맞았는지 시간으로 새지 않게.
    if (timingSafeEqual(Buffer.from(expected, 'utf8'), receivedBuf)) matched = true;
  }
  return matched;
}

/** 테스트·개발용. 운영 코드에서 서명을 만들 일은 없습니다. */
export function signBody(body: Buffer | string, secret: string): string {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return PREFIX + createHmac('sha256', secret).update(payload).digest('hex');
}
