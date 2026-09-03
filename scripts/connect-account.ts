/**
 * 계정 온보딩 — meta-api.md §4 의 4·6단계를 한 번에 수행한다.
 *
 *   pnpm connect-account ops/accounts/<slug>.json
 *
 * phase-1-pipeline.md §7 은 "SQL 로 직접 삽입"이라고 적혀 있지만 그럴 수 없다.
 * accessTokenEnc / appSecretEnc 는 AES-256-GCM 암호문이고 마스터 키가 필요하다.
 * 캠페인은 암호화 필드가 없으므로 계속 SQL 로 넣으면 된다.
 *
 * 입력은 argv 가 아니라 파일이다 — 토큰이 셸 히스토리와 /proc 에 남지 않게 (AGENTS.md).
 * 전 과정이 멱등하므로 60일 토큰을 갱신할 때 같은 파일만 고쳐 다시 실행하면 된다.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encrypt } from '../apps/api/src/crypto/cipher.ts';
import { getMasterKey } from '../apps/api/src/config/runtime.ts';
import { InstagramApiClient } from '../apps/api/src/instagram/client.ts';
import { getPrisma } from '../apps/api/src/prisma/client.ts';

/** 이 둘이 다 걸려야 파이프라인이 동작한다. 댓글 수신 + 답장 수신. */
const REQUIRED_FIELDS = ['comments', 'messages'];

type AccountFile = {
  email: string;
  slug: string;
  accessToken: string;
  appSecret: string;
  /** 보통 null. 403 이 계속될 때만 채운다 (meta-api.md §1-7). */
  parentAppSecret?: string | null;
  defaultPrivateReplyText?: string | null;
  defaultFollowUpText?: string | null;
  /** DM 발송 후 그 댓글에 공개로 다는 한 줄. null 이면 대댓글을 달지 않는다. */
  defaultCommentReplyText?: string | null;
};

function readAccountFile(path: string): AccountFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AccountFile>;
  for (const field of ['email', 'slug', 'accessToken', 'appSecret'] as const) {
    if (!parsed[field]) throw new Error(`${path}: "${field}" 가 없습니다`);
  }
  return parsed as AccountFile;
}

/**
 * ops/deploy.env 의 스택에서 Function URL 을 읽어 붙여넣을 URL 을 완성한다.
 * 아직 배포 전이면 조용히 포기하고 자리표시자를 돌려준다 — URL 하나 때문에
 * 계정 등록 자체가 막히면 안 된다.
 */
function functionUrl(): string {
  const { AWS_PROFILE, AWS_REGION, STACK_NAME } = process.env;
  if (!AWS_PROFILE || !AWS_REGION || !STACK_NAME) return '<ApiFunctionUrl>';
  try {
    return execFileSync('aws', [
      '--profile', AWS_PROFILE, '--region', AWS_REGION,
      'cloudformation', 'describe-stacks', '--stack-name', STACK_NAME,
      '--query', 'Stacks[0].Outputs[?OutputKey==`ApiFunctionUrl`].OutputValue',
      '--output', 'text',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || '<ApiFunctionUrl>';
  } catch {
    return '<ApiFunctionUrl>';
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: pnpm connect-account ops/accounts/<slug>.json');
    process.exit(1);
  }
  const input = readAccountFile(path);

  // 1) 토큰 검증. DB 를 건드리기 전에 죽는다. igUserId 는 여기서 나오므로
  //    사용자가 대시보드에서 찾을 필요가 없다. (igUserId 옵션은 메시지 발송에만
  //    쓰이고 getMe/subscribeApp 은 /me 를 부르므로 여기선 값이 의미 없다.)
  const client = new InstagramApiClient({ igUserId: 'me', accessToken: input.accessToken });
  const { userId: igUserId, username } = await client.getMe();
  console.log(`✓ 토큰 유효 — igUserId=${igUserId} username=${username || '(없음)'}`);

  // 2) 계정별 구독. 이걸 빠뜨리면 webhook 이 한 건도 오지 않는다 (meta-api.md §1-6).
  //
  //    **응답만 믿으면 안 된다.** 앱 레벨에서 구독하지 않은 필드는 Meta 가 조용히
  //    버리면서도 `{"success":true}` 를 돌려준다. 실제로 대시보드 웹훅 구성 전에
  //    이 스크립트를 돌려 `comments` 가 빠진 채 "성공" 을 받았고, 댓글 웹훅이 한 건도
  //    오지 않는 걸 한참 뒤에야 알았다. 되읽어서 확인한다.
  await client.subscribeApp();
  const subscribed = await client.getSubscribedFields();
  const missing = REQUIRED_FIELDS.filter((f) => !subscribed.includes(f));
  if (missing.length > 0) {
    console.error(`✗ 구독되지 않은 필드: ${missing.join(', ')} (실제 구독: ${subscribed.join(', ') || '없음'})`);
    console.error('  Meta 앱 → Webhooks → Instagram 에서 해당 필드를 구독한 뒤 다시 실행하세요.');
    console.error('  앱 레벨에서 구독하지 않은 필드는 계정 레벨 구독이 조용히 무시됩니다.');
    process.exit(1);
  }
  console.log(`✓ subscribed_apps 확인 — ${subscribed.join(', ')}`);

  const [prisma, masterKey] = await Promise.all([getPrisma(), getMasterKey()]);

  const user = await prisma.user.upsert({
    where: { email: input.email },
    create: { email: input.email, passwordHash: '', status: 'ACTIVE' },
    update: {},
  });

  // verifyToken 은 신규일 때만 만든다. 재실행할 때마다 갈아치우면 Meta 에 등록해 둔
  // 토큰이 죽어 재검증(GET /webhook/:slug)이 403 으로 떨어진다.
  const existing = await prisma.igAccount.findUnique({ where: { igUserId } });
  const verifyToken = existing?.verifyToken ?? randomBytes(24).toString('base64url');

  const credentials = {
    accessTokenEnc: encrypt(input.accessToken, masterKey),
    appSecretEnc: encrypt(input.appSecret, masterKey),
    parentAppSecretEnc: input.parentAppSecret ? encrypt(input.parentAppSecret, masterKey) : null,
  };
  const settings = {
    username: username || null,
    slug: input.slug,
    defaultPrivateReplyText: input.defaultPrivateReplyText ?? null,
    defaultFollowUpText: input.defaultFollowUpText ?? null,
    defaultCommentReplyText: input.defaultCommentReplyText ?? null,
    status: 'CONNECTED' as const,
    subscribedAt: new Date(),
  };

  const account = await prisma.igAccount.upsert({
    where: { igUserId },
    create: { userId: user.id, igUserId, verifyToken, ...credentials, ...settings },
    update: { ...credentials, ...settings },
  });

  const base = functionUrl();
  console.log(`✓ 계정 ${existing ? '갱신' : '등록'} — id=${account.id}\n`);
  console.log('── Meta 앱 → Webhooks 에 아래 두 값을 입력하고 Verify and Save ──');
  console.log(`  Callback URL : ${base.replace(/\/$/, '')}/webhook/${input.slug}`);
  console.log(`  Verify Token : ${verifyToken}`);
  console.log('  구독 필드     : comments, messages');

  // 풀을 닫지 않으면 프로세스가 그대로 매달린다.
  await prisma.$disconnect();
}

void main();
