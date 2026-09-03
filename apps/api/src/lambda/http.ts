import 'reflect-metadata';
import serverlessExpress from '@codegenie/serverless-express';
import type { Handler } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.ts';
import { memoizeAsync } from '../lib/memoize-async.ts';

/**
 * Lambda Function URL 진입점 (webhook 수신 + 향후 API).
 *
 * NestJS 앱을 **모듈 스코프에 메모이즈**합니다 (lib/memoize-async.ts). Lambda 는
 * 컨테이너를 재사용하므로 콜드 스타트에서 한 번만 부트하면 이후 호출은 그대로 씁니다.
 *
 * `rawBody: true` 가 없으면 body 파서가 원본 바이트를 버려 HMAC 검증이 불가능해집니다.
 */

const appCache = memoizeAsync(async (): Promise<Handler> => {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.init();
  return serverlessExpress({ app: app.getHttpAdapter().getInstance() });
});

/**
 * **`callback` 파라미터를 받으면 안 됩니다.** Node.js 24 런타임은 `handler.length === 3`
 * 을 콜백 방식 핸들러로 판정하고 초기화 자체를 거부합니다
 * (`Runtime.CallbackHandlerDeprecated` → 모든 요청이 502). 실제로 첫 배포에서 이걸로
 * 죽었고, 콜백을 넘겨봐야 위 라이브러리는 쓰지도 않습니다.
 */
export const handler: Handler = async (event, context) => {
  const server = await appCache.run();
  // 라이브러리의 타입 선언은 3번째 인자를 요구하지만 실제 구현(`src/configure.js` 의
  // `async function handler (event, context)`)은 쓰지 않습니다. 무시되는 no-op 을 넘겨
  // 타입만 맞춥니다 — 중요한 건 위에서 export 하는 이 함수의 arity 입니다.
  return server(event, context, () => {});
};
