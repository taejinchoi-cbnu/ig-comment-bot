// Prisma CLI 전용 설정 (Prisma 7).
// 런타임 연결은 여기가 아니라 src/prisma/client.ts 의 어댑터가 담당합니다.
import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// 시크릿은 repo 밖의 ops/ 에만 둡니다 (.gitignore).
loadEnv({ path: '../../ops/deploy.env' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // 마이그레이션은 PgBouncer 를 지원하지 않으므로 직결 URL 을 씁니다.
    // Prisma 6 의 directUrl 이 있던 자리입니다.
    url: env('DATABASE_URL_UNPOOLED'),
  },
});
