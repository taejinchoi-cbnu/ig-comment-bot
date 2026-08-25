import 'reflect-metadata';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { getPrisma } from '../prisma/client.ts';
import { getMasterKey } from '../config/runtime.ts';
import { decrypt } from '../crypto/cipher.ts';
import { InstagramApiClient } from '../instagram/client.ts';
import { dispatch } from '../processing/registry.ts';
import type { HandlerContext } from '../processing/context.ts';
import type { BotEvent } from '../webhook/normalize.ts';

/**
 * SQS 워커 진입점. webhook 이 넣은 이벤트를 꺼내 Instagram API 를 호출합니다.
 *
 * **부분 배치 응답을 씁니다** — 실패한 메시지만 재시도하도록 `batchItemFailures` 로
 * 돌려줍니다. 이게 없으면 배치 10건 중 1건이 실패해도 전부 재처리되어
 * 성공한 9건에 중복 발송을 시도하게 됩니다.
 * (infra/template.yaml 의 FunctionResponseTypes: ReportBatchItemFailures 와 한 쌍)
 */

/** 계정별 컨텍스트를 배치 안에서 재사용합니다. 같은 계정 이벤트가 몰려 오는 게 보통입니다. */
async function buildContext(igUserId: string): Promise<HandlerContext | null> {
  const [prisma, masterKey] = await Promise.all([getPrisma(), getMasterKey()]);
  const row = await prisma.igAccount.findUnique({ where: { igUserId } });
  if (!row) return null;

  const accessToken = decrypt(row.accessTokenEnc, masterKey);

  return {
    account: {
      id: row.id,
      igUserId: row.igUserId,
      defaultPrivateReplyText: row.defaultPrivateReplyText,
      defaultFollowUpText: row.defaultFollowUpText,
    },
    prisma,
    instagram: new InstagramApiClient({ igUserId: row.igUserId, accessToken }),
  };
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const contexts = new Map<string, HandlerContext | null>();

  for (const record of event.Records as SQSRecord[]) {
    try {
      const botEvent = JSON.parse(record.body) as BotEvent;

      if (!contexts.has(botEvent.igUserId)) {
        contexts.set(botEvent.igUserId, await buildContext(botEvent.igUserId));
      }
      const ctx = contexts.get(botEvent.igUserId) ?? null;

      if (!ctx) {
        // 계정이 사라졌거나 연결이 해제됐습니다. 재시도해도 달라지지 않으므로
        // 실패로 보고하지 않고 넘깁니다 — DLQ 로 보내봐야 노이즈입니다.
        console.warn('알 수 없는 계정의 이벤트를 건너뜁니다', { igUserId: botEvent.igUserId });
        continue;
      }

      await dispatch(botEvent, ctx);
    } catch (cause) {
      // 본문에는 댓글·DM 텍스트가 들어 있으므로 로그에 남기지 않습니다.
      console.error('이벤트 처리 실패', { messageId: record.messageId, cause: String(cause) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
