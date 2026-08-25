import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';

/**
 * 로컬/셀프호스팅 진입점. Lambda 에서는 lambda/http.ts 가 같은 AppModule 을 씁니다.
 *
 * `rawBody: true` 가 핵심입니다 — 이게 없으면 body 파서가 원본 바이트를 버려서
 * HMAC 서명 검증이 불가능해집니다.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`api listening on :${port}`);
}

void bootstrap();
