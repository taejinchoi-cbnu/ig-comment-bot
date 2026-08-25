import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.ts';
import { WebhookController } from './webhook/webhook.controller.ts';

@Module({
  controllers: [HealthController, WebhookController],
})
export class AppModule {}
