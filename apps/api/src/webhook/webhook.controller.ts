import { Controller, Get, Headers, Param, Post, Query, RawBodyRequest, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getPrisma } from '../prisma/client.ts';
import { getMasterKey } from '../config/runtime.ts';
import { EventProducer } from '../queue/producer.ts';
import { requireEnv } from '../env.ts';
import { handleReceive, handleVerification, type WebhookDeps } from './webhook.service.ts';

/**
 * Meta webhook 수신 엔드포인트.
 *
 * 데코레이터는 이 파일에만 있습니다. 실제 로직은 webhook.service.ts 의 순수 함수라
 * `node --test` 로 컴파일 없이 검증됩니다.
 *
 * **이 경로는 Instagram API 를 호출하지 않습니다.** 검증 → 정규화 → enqueue 까지만
 * 하고 즉시 200 을 돌려줍니다 (docs/architecture.md §결정과 근거).
 */
@Controller('webhook')
export class WebhookController {
  private producer: EventProducer | null = null;

  private async deps(): Promise<WebhookDeps> {
    const [prisma, masterKey] = await Promise.all([getPrisma(), getMasterKey()]);
    this.producer ??= new EventProducer({ queueUrl: requireEnv('EVENT_QUEUE_URL') });
    return { prisma, producer: this.producer, masterKey };
  }

  /** Meta 가 callback URL 을 등록할 때 하는 확인 절차. challenge 를 그대로 돌려줍니다. */
  @Get(':slug')
  async verify(
    @Param('slug') slug: string,
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const outcome = await handleVerification(slug, query, await this.deps());
    res.status(outcome.status).type('text/plain').send(outcome.body);
  }

  @Post(':slug')
  async receive(
    @Param('slug') slug: string,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    // rawBody 가 있어야 HMAC 을 검증할 수 있습니다. 파싱된 객체를 다시 직렬화하면
    // 공백·키 순서가 달라져 서명이 깨집니다 (signature.test.ts 에 회귀 테스트 있음).
    const raw = req.rawBody ?? Buffer.alloc(0);

    try {
      const outcome = await handleReceive(slug, raw, signature, await this.deps());
      res.status(outcome.status).type('text/plain').send(outcome.status === 200 ? 'OK' : '');
    } catch (cause) {
      // 처리 중 예외가 나도 Meta 에는 200 을 돌려줍니다. 비200 이 반복되면
      // Meta 가 구독을 끊어 이후 모든 이벤트가 오지 않습니다.
      console.error('webhook 처리 실패', { slug, cause: String(cause) });
      res.status(200).type('text/plain').send('OK');
    }
  }
}
