import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// 로컬/셀프호스팅 진입점. Lambda에서는 lambda/*.ts 어댑터가 같은 AppModule을 씁니다.
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`api listening on :${port}`);
}

void bootstrap();
