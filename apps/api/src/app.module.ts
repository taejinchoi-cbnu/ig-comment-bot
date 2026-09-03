import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.ts';
import { LegalController } from './legal.controller.ts';
import { WebhookController } from './webhook/webhook.controller.ts';

@Module({
  controllers: [HealthController, LegalController, WebhookController],
})
export class AppModule {}
