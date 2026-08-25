import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * AWS Secrets Manager 에서 앱 시크릿을 읽어옵니다.
 *
 * Secrets Manager 에는 마스터 키 1개(월 $0.40)와 DB 접속 문자열을 JSON 으로 묶어 둡니다
 * (docs/architecture.md §토큰 암호화, §리전). 토큰 자체는 이 모듈이 다루지 않고
 * crypto/cipher.ts 가 받는 마스터 키만 여기서 만들어 냅니다.
 *
 * 평범한 함수만 씁니다 (Nest 데코레이터 금지 — 타입 스트리핑이 변환 못 해 node --test 가 깨집니다).
 * SecretsManagerClient 는 주입받을 수 있어 테스트에서 실제 AWS 를 부르지 않습니다.
 */

const MASTER_KEY_LENGTH = 32; // crypto/cipher.ts 의 AES-256 키 길이와 동일해야 함

export type AppSecrets = {
  databaseUrl: string;
  /** 고객 토큰을 암호화하는 마스터 키. 32바이트. */
  masterKey: Buffer;
};

export type LoadSecretsOptions = {
  secretId?: string;
  client?: SecretsManagerClient;
};

type RawSecret = {
  DATABASE_URL?: string;
  MASTER_KEY?: string;
};

// Lambda 는 컨테이너를 재사용합니다. 호출마다 Secrets Manager 를 때리면 지연·비용이 늘어나므로
// 모듈 스코프에 결과(Promise)를 캐시합니다. 진행 중인 Promise 를 그대로 재사용해 콜드 스타트
// 직후 동시에 들어오는 여러 요청이 중복 fetch 를 하지 않게 합니다.
let cached: Promise<AppSecrets> | null = null;

export async function loadSecrets(opts: LoadSecretsOptions = {}): Promise<AppSecrets> {
  if (cached) return cached;

  const promise = fetchSecrets(opts);
  cached = promise;
  try {
    return await promise;
  } catch (err) {
    // 실패는 캐시하지 않습니다 — 실패한 Promise 를 캐시로 남기면 컨테이너가 살아있는
    // 내내 재시도조차 못 하고 계속 실패합니다.
    cached = null;
    throw err;
  }
}

/** 테스트에서 캐시를 비우기 위한 것. 운영 코드에서 쓰지 마라. */
export function resetSecretsCache(): void {
  cached = null;
}

async function fetchSecrets(opts: LoadSecretsOptions): Promise<AppSecrets> {
  const secretId = opts.secretId ?? process.env.APP_SECRET_ID;
  if (!secretId) {
    throw new Error('시크릿 ID 가 없습니다: opts.secretId 또는 환경변수 APP_SECRET_ID 를 설정하세요');
  }

  const client = opts.client ?? new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (!response.SecretString) {
    throw new Error('시크릿에 SecretString 이 없습니다');
  }

  let raw: RawSecret;
  try {
    raw = JSON.parse(response.SecretString) as RawSecret;
  } catch {
    // 파싱 실패 원문(SecretString)은 시크릿 값을 담고 있을 수 있어 에러 메시지에 넣지 않습니다.
    throw new Error('시크릿 JSON 파싱에 실패했습니다');
  }

  if (!raw.DATABASE_URL) {
    throw new Error('시크릿에 DATABASE_URL 필드가 없습니다');
  }
  if (!raw.MASTER_KEY) {
    throw new Error('시크릿에 MASTER_KEY 필드가 없습니다');
  }

  const masterKey = Buffer.from(raw.MASTER_KEY, 'base64');
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    // 디코드된 길이만 밝히고 값 자체(raw.MASTER_KEY)는 절대 포함하지 않습니다.
    throw new Error(`MASTER_KEY 는 base64 로 인코딩된 ${MASTER_KEY_LENGTH}바이트여야 합니다 (디코드 길이: ${masterKey.length})`);
  }

  return { databaseUrl: raw.DATABASE_URL, masterKey };
}
