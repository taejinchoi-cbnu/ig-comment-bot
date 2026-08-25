import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { BotEvent } from '../webhook/normalize.ts';

/**
 * 큐 적재 결과. 부분 실패를 구분해서 돌려줍니다.
 */
export type EnqueueResult = {
  /** 성공한 메시지 수 */
  successful: number;
  /** 실패한 메시지와 그 사유 (원본 이벤트 포함) */
  failed: { event: BotEvent; reason: string }[];
};

/**
 * SQS 이벤트 프로듀서.
 *
 * BotEvent 를 SQS 큐로 보냅니다. SendMessageBatchCommand 로 한 번에 최대 10개씩 배치로 전송합니다.
 * 10개를 넘으면 자동으로 나눕니다. 부분 실패를 그대로 돌려주므로 호출자가 실패한 항목을 재시도할 수 있습니다.
 *
 * 의존성 주입:
 *  · SQSClient 를 주입받습니다 (테스트에서 가짜로 교체 가능).
 *  · 주입하지 않으면 new SQSClient({}) 를 기본값으로 씁니다.
 */
export class EventProducer {
  private readonly queueUrl: string;
  private readonly client: SQSClient;

  constructor(opts: { queueUrl: string; client?: SQSClient }) {
    this.queueUrl = opts.queueUrl;
    this.client = opts.client ?? new SQSClient({});
  }

  /**
   * 이벤트 목록을 큐에 넣습니다.
   *
   * @param events 보낼 이벤트 (빈 배열이면 즉시 반환)
   * @returns 성공/실패 결과. 부분 실패 시 failed 배열에 담겨 옵니다.
   */
  async enqueue(events: readonly BotEvent[]): Promise<EnqueueResult> {
    // 빈 배열은 SQS 를 호출하지 않습니다 (SQS 가 에러를 냅니다)
    if (events.length === 0) {
      return { successful: 0, failed: [] };
    }

    const result: EnqueueResult = { successful: 0, failed: [] };
    // ponytail: SQS 배치 한도는 10건 고정
    const BATCH_SIZE = 10;

    // 10개씩 나눠서 전송
    for (let batchStart = 0; batchStart < events.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, events.length);
      const batch = events.slice(batchStart, batchEnd);

      const response = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: batch.map((event, idx) => ({
            // 배치 안에서 유일한 ID (인덱스 사용)
            Id: idx.toString(),
            MessageBody: JSON.stringify(event),
          })),
        }),
      );

      // 성공한 개수 누적
      result.successful += response.Successful?.length ?? 0;

      // 실패한 항목 수집 (원본 이벤트와 함께)
      if (response.Failed && response.Failed.length > 0) {
        for (const failedEntry of response.Failed) {
          const failedIdx = parseInt(failedEntry.Id!, 10);
          const failedEvent = batch[failedIdx];
          if (failedEvent) {
            result.failed.push({
              event: failedEvent,
              // 실패 사유만 로그합니다 (이벤트 내용은 개인정보이므로 기록하지 않음)
              reason: String(failedEntry.Message || 'Unknown error'),
            });
          }
        }
      }
    }

    return result;
  }
}
