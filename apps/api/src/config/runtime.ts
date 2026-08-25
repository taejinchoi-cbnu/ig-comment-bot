import { loadSecrets } from './secrets.ts';
import '../env.ts';

/**
 * 마스터 키를 얻습니다.
 *
 * 로컬/셀프호스팅에서는 `ops/deploy.env` 의 `MASTER_KEY`(base64)를 쓰고,
 * Lambda 에서는 Secrets Manager 로 갑니다 — `prisma/client.ts` 의 `DATABASE_URL`
 * 처리와 같은 규칙입니다. 한쪽만 env 폴백이 있으면 로컬에서 절반만 뜨는
 * 비대칭이 생깁니다.
 */

const MASTER_KEY_LENGTH = 32;
let cached: Promise<Buffer> | null = null;

export function getMasterKey(): Promise<Buffer> {
  cached ??= (async () => {
    const fromEnv = process.env.MASTER_KEY;
    if (fromEnv) {
      const key = Buffer.from(fromEnv, 'base64');
      if (key.length !== MASTER_KEY_LENGTH) {
        // 값은 담지 않습니다. 길이만 알려줍니다.
        throw new Error(
          `MASTER_KEY 는 base64 로 인코딩된 ${MASTER_KEY_LENGTH}바이트여야 합니다 (디코드 길이: ${key.length})`,
        );
      }
      return key;
    }
    return (await loadSecrets()).masterKey;
  })().catch((cause) => {
    cached = null; // 실패를 캐시하면 컨테이너가 사는 내내 계속 실패합니다.
    throw cause;
  });
  return cached;
}

/** 테스트 전용. */
export function resetMasterKeyCache(): void {
  cached = null;
}
