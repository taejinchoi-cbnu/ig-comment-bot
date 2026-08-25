import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

/**
 * 로컬/셀프호스팅에서는 repo 루트의 ops/deploy.env 를 읽습니다 (.gitignore 대상).
 * Lambda 에서는 그 파일이 없고 환경변수가 이미 주입돼 있으므로 아무것도 하지 않습니다.
 *
 * __dirname 을 쓰지 않는 이유: 빌드 산출물은 CJS 이고 node --test 는 ESM 이라
 * 양쪽에서 동작하는 방식이 필요합니다. cwd 에서 위로 올라가며 찾습니다.
 */
function loadLocalEnvFile(): void {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'ops', 'deploy.env');
    if (existsSync(candidate)) {
      loadEnv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadLocalEnvFile();

/** 없으면 즉시 죽습니다. 런타임 중간에 undefined 로 터지는 것보다 낫습니다. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 설정되지 않았습니다 (ops/deploy.env 또는 Lambda 환경변수)`);
  return v;
}
