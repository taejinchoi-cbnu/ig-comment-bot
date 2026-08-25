import type { AccountLookup, ResolvedAccount } from './account.service.ts';
import { resolveAccountBySlug } from './account.service.ts';
import { normalize, type NormalizeResult } from './normalize.ts';
import { verifySignature } from './signature.ts';
import type { EventProducer } from '../queue/producer.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';

/**
 * webhook 수신의 순수 로직. NestJS 데코레이터는 컨트롤러에만 두고 여기엔 두지 않습니다
 * — 타입 스트리핑으로 테스트를 컴파일 없이 돌리기 위함입니다.
 *
 * 이 경로는 **Instagram API 를 절대 호출하지 않습니다.** 검증 → 정규화 → enqueue 까지만
 * 하고 즉시 200 을 돌려줍니다. Meta 는 비200 이 반복되면 구독을 끊습니다.
 */

export type WebhookDeps = {
  prisma: AccountLookup & Pick<PrismaClient, 'event'>;
  producer: Pick<EventProducer, 'enqueue'>;
  masterKey: Buffer;
};

export type VerifyOutcome =
  | { status: 200; body: string }
  | { status: 403 | 404; body: string };

/** GET — Meta 가 callback URL 을 등록할 때 하는 확인 절차. */
export async function handleVerification(
  slug: string,
  query: Record<string, string | undefined>,
  deps: WebhookDeps,
): Promise<VerifyOutcome> {
  const account = await resolveAccountBySlug(slug, deps.prisma, deps.masterKey);
  if (!account) return { status: 404, body: 'not found' };

  if (query['hub.mode'] !== 'subscribe') return { status: 403, body: 'forbidden' };
  if (query['hub.verify_token'] !== account.verifyToken) return { status: 403, body: 'forbidden' };

  return { status: 200, body: query['hub.challenge'] ?? '' };
}

export type ReceiveOutcome = {
  status: 200 | 403 | 404;
  enqueued: number;
  skipped: number;
};

/**
 * POST — 실제 이벤트 수신.
 *
 * slug 로 테넌트를 **먼저** 확정한 뒤 그 계정의 App Secret 으로 서명을 검증합니다.
 * 본문을 파싱해서 테넌트를 정하면 검증 전에 신뢰할 수 없는 값을 믿게 됩니다.
 */
export async function handleReceive(
  slug: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
  deps: WebhookDeps,
): Promise<ReceiveOutcome> {
  const account = await resolveAccountBySlug(slug, deps.prisma, deps.masterKey);
  if (!account) return { status: 404, enqueued: 0, skipped: 0 };

  if (!verifySignature(rawBody, signatureHeader, account.appSecrets)) {
    return { status: 403, enqueued: 0, skipped: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // 서명은 맞는데 JSON 이 아니면 우리가 모르는 형식입니다. 200 으로 넘깁니다.
    return { status: 200, enqueued: 0, skipped: 0 };
  }

  const result: NormalizeResult = normalize(parsed, account.igUserId);

  await recordSkipped(result, account, deps);

  if (result.events.length > 0) {
    const outcome = await deps.producer.enqueue(result.events);
    if (outcome.failed.length > 0) {
      // enqueue 실패는 삼키되 사유는 남깁니다. 비200 을 돌려주면 Meta 가 구독을 끊습니다.
      console.error('일부 이벤트를 큐에 넣지 못했습니다', {
        slug,
        failed: outcome.failed.map((f) => f.reason),
      });
    }
  }

  return { status: 200, enqueued: result.events.length, skipped: result.skipped.length };
}

/**
 * 버려진 이벤트를 통계에 남깁니다 — "왜 DM 이 안 갔지?" 에 답하려면 기록이 필요합니다.
 *
 * 단 **ECHO 는 남기지 않습니다.** 우리가 DM 을 보낼 때마다 하나씩 되돌아오므로
 * 기록하면 Event 테이블이 순수 노이즈로 두 배가 되고 분석에 아무 도움이 안 됩니다.
 */
async function recordSkipped(
  result: NormalizeResult,
  account: ResolvedAccount,
  deps: WebhookDeps,
): Promise<void> {
  const worth = result.skipped.filter((s) => s.reason !== 'ECHO');
  if (worth.length === 0) return;

  try {
    await deps.prisma.event.createMany({
      data: worth.map((s) => ({
        igAccountId: account.handler.id,
        type: 'COMMENT_SKIPPED' as const,
        skipReason: s.reason,
        mediaId: s.mediaId ?? null,
        igsid: s.igsid ?? null,
        username: s.username ?? null,
      })),
    });
  } catch (cause) {
    // 통계 기록 실패가 수신을 막으면 안 됩니다.
    console.error('skipped 이벤트 기록 실패', { cause: String(cause) });
  }
}
