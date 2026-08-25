import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { requireEnv } from '../env.ts';

/**
 * 런타임은 pooled URL 을 씁니다 (짧은 연결이 많은 서버리스에 적합).
 * 마이그레이션이 쓰는 직결 URL 은 prisma.config.ts 에 따로 있습니다.
 *
 * Lambda 컨테이너 재사용을 위해 모듈 스코프에 한 번만 만듭니다.
 */
const adapter = new PrismaPg({ connectionString: requireEnv('DATABASE_URL') });

export const prisma = new PrismaClient({ adapter });
