import { decrypt } from '../crypto/cipher.ts';
import type { HandlerAccount } from '../processing/context.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';

/**
 * webhook 경로의 slug 로 계정을 찾고 서명 검증에 필요한 것만 복호화합니다.
 *
 * **순서가 보안의 핵심입니다**: 경로(slug)로 테넌트를 먼저 확정한 뒤,
 * 그 계정의 App Secret 으로 서명을 검증합니다. 본문을 파싱해서 테넌트를
 * 정하면 검증 전에 신뢰할 수 없는 값을 믿게 됩니다 (docs/meta-api.md §4).
 *
 * **`accessToken` 은 여기서 다루지 않습니다.** GET/POST webhook 경로는 Instagram API 를
 * 호출하지 않으므로(architecture.md §결정과 근거) 필요가 없습니다. 여기서 불필요하게
 * 복호화하면 이 프로젝트에서 가장 QPS 가 높은 경로에 쓸모없는 연산이 붙고, 서명 검증과
 * 무관한 accessTokenEnc 가 손상됐을 때 정상 서명된 webhook 까지 404 로 떨어집니다.
 * 워커(sqs.ts)는 발송에 실제로 쓰므로 거기서 별도로 복호화합니다.
 *
 * 데코레이터를 쓰지 않는 평범한 함수입니다 — NestJS 서비스로 만들면
 * 타입 스트리핑이 깨져 테스트를 컴파일 없이 못 돌립니다.
 */

export type ResolvedAccount = {
  handler: HandlerAccount;
  igUserId: string;
  verifyToken: string;
  /**
   * HMAC 검증에 쓸 후보. 앱 구성에 따라 서명 키가 이 계정의 App Secret 이 아니라
   * 상위 Meta App Secret 일 수 있다 (meta-api.md #7). 계정마다 다른 Meta 앱을 쓰는
   * 멀티테넌트 구조라 플랫폼 전역 값일 수 없고, IgAccount.parentAppSecretEnc 에
   * 계정별로 둔다. 없는 게 보통이며 그 경우 후보는 하나뿐이다.
   */
  appSecrets: string[];
};

export type AccountLookup = Pick<PrismaClient, 'igAccount'>;

/**
 * @param masterKey 자격증명 복호화용 마스터 키 (Secrets Manager 에서 가져온 값)
 */
export async function resolveAccountBySlug(
  slug: string,
  prisma: AccountLookup,
  masterKey: Buffer,
): Promise<ResolvedAccount | null> {
  const row = await prisma.igAccount.findUnique({ where: { slug } });
  if (!row) return null;

  // appSecretEnc 는 필수 후보라 실패하면 이 계정의 어떤 webhook 도 검증할 수 없습니다.
  // 여기서 던지면 500 을 내고 Meta 가 재시도하므로, null 로 돌려 404 처리하고
  // 로그로만 남깁니다. 복호화 에러 메시지에는 값이 들어있지 않습니다.
  let appSecret: string;
  try {
    appSecret = decrypt(row.appSecretEnc, masterKey);
  } catch (cause) {
    console.error('계정 App Secret 복호화 실패', { slug, cause: String(cause) });
    return null;
  }

  const appSecrets = [appSecret];

  // parentAppSecretEnc 는 선택 후보입니다. 이게 깨졌다고 appSecretEnc 로 되는
  // 검증까지 막을 이유는 없으므로, 실패하면 후보에서 빼고 넘어갑니다.
  if (row.parentAppSecretEnc) {
    try {
      appSecrets.push(decrypt(row.parentAppSecretEnc, masterKey));
    } catch (cause) {
      console.error('계정 상위 App Secret 복호화 실패 — 기본 후보만으로 계속합니다', {
        slug,
        cause: String(cause),
      });
    }
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
    appSecrets,
  };
}
