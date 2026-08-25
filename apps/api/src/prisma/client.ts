import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { loadSecrets } from '../config/secrets.ts';
import { memoizeAsync } from '../lib/memoize-async.ts';
import './../env.ts';

/**
 * 런타임 PrismaClient.
 *
 * 연결 문자열은 **Secrets Manager 에서** 가져옵니다 — Lambda 환경변수에 두면
 * `lambda:GetFunctionConfiguration` 권한이 있는 누구에게나 DB 비밀번호가 보입니다.
 * 그래서 생성이 비동기이고, 모듈 스코프에 메모이즈합니다 (lib/memoize-async.ts).
 *
 * 마이그레이션이 쓰는 직결 URL 은 prisma.config.ts 에 따로 있습니다 (pooled 아님).
 *
 * 로컬 개발에서는 env.ts 가 ops/deploy.env 를 읽어 process.env.DATABASE_URL 을
 * 채워두므로 Secrets Manager 없이도 동작합니다.
 */

const prismaCache = memoizeAsync(async (): Promise<PrismaClient> => {
  // 로컬(ops/deploy.env)에 값이 있으면 그걸 쓰고, 없으면 Secrets Manager 로 갑니다.
  const connectionString = process.env.DATABASE_URL ?? (await loadSecrets()).databaseUrl;
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
});

export function getPrisma(): Promise<PrismaClient> {
  return prismaCache.run();
}

/** 테스트 전용. 운영 코드에서 쓰지 마세요. */
export function resetPrismaCache(): void {
  prismaCache.reset();
}
