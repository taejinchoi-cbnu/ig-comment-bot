import 'reflect-metadata';
import serverlessExpress from '@codegenie/serverless-express';
import type { Handler } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.ts';

/**
 * Lambda Function URL 진입점 (webhook 수신 + 향후 API).
 *
 * NestJS 앱을 **모듈 스코프에 메모이즈**합니다. Lambda 는 컨테이너를 재사용하므로
 * 콜드 스타트에서 한 번만 부트하면 이후 호출은 그대로 씁니다.
 *
 * `rawBody: true` 가 없으면 body 파서가 원본 바이트를 버려 HMAC 검증이 불가능해집니다.
 */

let cached: Promise<Handler> | null = null;

function bootstrap(): Promise<Handler> {
  cached ??= (async () => {
    const app = await NestFactory.create(AppModule, { rawBody: true });
    await app.init();
    return serverlessExpress({ app: app.getHttpAdapter().getInstance() });
  })().catch((cause) => {
    // 실패를 캐시하면 컨테이너가 사는 내내 계속 실패합니다.
    cached = null;
    throw cause;
  });
  return cached;
}

export const handler: Handler = async (event, context, callback) => {
  const server = await bootstrap();
  return server(event, context, callback);
};
