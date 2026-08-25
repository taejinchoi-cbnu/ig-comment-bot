import { decrypt } from '../crypto/cipher.ts';
import type { HandlerAccount } from '../processing/context.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';

/**
 * webhook 경로의 slug 로 계정을 찾고 자격증명을 복호화합니다.
 *
 * **순서가 보안의 핵심입니다**: 경로(slug)로 테넌트를 먼저 확정한 뒤,
 * 그 계정의 App Secret 으로 서명을 검증합니다. 본문을 파싱해서 테넌트를
 * 정하면 검증 전에 신뢰할 수 없는 값을 믿게 됩니다 (docs/meta-api.md §4).
 *
 * 데코레이터를 쓰지 않는 평범한 함수입니다 — NestJS 서비스로 만들면
 * 타입 스트리핑이 깨져 테스트를 컴파일 없이 못 돌립니다.
 */

export type ResolvedAccount = {
  handler: HandlerAccount;
  igUserId: string;
  verifyToken: string;
  /** HMAC 검증에 쓸 후보. Instagram app secret 과 상위 Meta app secret 이 다를 수 있습니다. */
  appSecrets: string[];
  accessToken: string;
};

export type AccountLookup = Pick<PrismaClient, 'igAccount'>;

/**
 * @param masterKey 토큰 복호화용 마스터 키 (Secrets Manager 에서 가져온 값)
 */
export async function resolveAccountBySlug(
  slug: string,
  prisma: AccountLookup,
  masterKey: Buffer,
): Promise<ResolvedAccount | null> {
  const row = await prisma.igAccount.findUnique({ where: { slug } });
  if (!row) return null;

  // 복호화 실패는 마스터 키가 바뀌었거나 데이터가 손상된 경우입니다.
  // 여기서 던지면 webhook 이 500 을 내고 Meta 가 재시도하므로, null 로 돌려
  // 404 처리하고 로그로만 남깁니다. 복호화 에러 메시지에는 값이 들어있지 않습니다.
  let accessToken: string;
  let appSecret: string;
  try {
    accessToken = decrypt(row.accessTokenEnc, masterKey);
    appSecret = decrypt(row.appSecretEnc, masterKey);
  } catch (cause) {
    console.error('계정 자격증명 복호화 실패', { slug, cause: String(cause) });
    return null;
  }

  return {
    handler: {
      id: row.id,
      igUserId: row.igUserId,
      defaultPrivateReplyText: row.defaultPrivateReplyText,
      defaultFollowUpText: row.defaultFollowUpText,
    },
    igUserId: row.igUserId,
    verifyToken: row.verifyToken,
    // 상위 Meta app secret 이 별도로 설정되면 여기 두 번째 후보로 들어옵니다.
    appSecrets: [appSecret, process.env.META_APP_SECRET].filter((s): s is string => Boolean(s)),
    accessToken,
  };
}
