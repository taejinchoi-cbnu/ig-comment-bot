# AGENTS.md

Rules for agents and contributors working in this repo.
Written in English on purpose — a second translated copy would drift, and a rule file that
contradicts itself is worse than none. Product docs live in Korean under `docs/`.

**Read [`docs/meta-api.md`](docs/meta-api.md) before touching anything that parses a webhook
payload or calls the Instagram API.** It lists 14 verified constraints; five of them are things
the original design got wrong, and getting them wrong fails silently rather than loudly.

## What this is

Instagram comment → auto-DM, plus the analytics that make the auto-DM worth having.
The whole point is "easy to use" + "easy to understand results" — see [`docs/why.md`](docs/why.md).

Stack: React+Vite+TS (web) / NestJS+TS (api) / PostgreSQL+Prisma / AWS Lambda + SQS + CloudFront.
One NestJS app, two Lambda entry points (`lambda/http.ts`, `lambda/sqs.ts`).

## Architectural invariants

Breaking any of these breaks the system in ways that are hard to notice:

1. **The webhook path never calls the Instagram API.** It verifies, normalizes, enqueues, returns 200.
   Meta disables subscriptions after repeated non-200s.
2. **All outbound side effects happen in the worker**, so SQS retry and DLQ actually mean something.
3. **Every query is scoped by `igAccountId`.** No exceptions. Cross-account leakage is the one bug
   that would be unforgivable in a service holding other people's Instagram tokens.
4. **`normalize.ts` stays a pure function.** No I/O, no DB. It is the highest-value test target.
5. **Every branch writes an `Event` row**, including skips (`COMMENT_SKIPPED` + `skipReason`).
   "Why didn't the DM go out?" is the most common user question and Phase 3 depends on this data.
6. **Idempotency is two SQL statements**, not a framework. See `docs/architecture.md`.
   Do not introduce a lock table, a lease, or a distributed mutex.

## Silent-failure traps

Full list with details in `docs/meta-api.md`. The ones that bite most:

- Comments arrive under `entry[].changes[]`, messages under `entry[].messaging[]` — different shapes
- Filter `message.is_echo` / `is_self`, or the bot answers its own DMs forever
- Filter self-comments (`value.from.id === entry.id`)
- `POST /me/subscribed_apps` per account, or **no webhooks arrive at all**
- HMAC: try both the Instagram app secret and the parent Meta app secret
- Decode base64 body (`isBase64Encoded`) before computing the HMAC

## Privacy

- **Never store or log comment/DM message bodies.** Username is fine (public); body is not.
- Never log access tokens, app secrets, or verify tokens.
- CloudWatch Logs retention is 7 days — this is a cost control as much as a privacy one.

## Product constraints (from `docs/why.md`)

- **Adding a feature must not add a concept the user has to learn.** The mental model is
  "one post = one auto-DM". Anything else goes under collapsed "advanced settings", or doesn't ship.
- **The UI never says "campaign", "trigger", or "sequence".** Internal code may; screens say
  "자동 DM" and "게시글".
- Prefer tables and sentences over charts.

## Commands

```bash
pnpm install
pnpm typecheck        # tsc --noEmit
pnpm test             # node --test (Node 24 type stripping, no test framework)
pnpm -F api dev
pnpm -F web dev
scripts/deploy.sh     # SAM CLI is NOT installed; deploy via aws cloudformation
```

## Do not

- Commit anything under `ops/` (gitignored — operator config, customer working files)
- Accept secrets as CLI arguments (shell history). Use stdin or a file
- Add `@ts-nocheck`, or silence type errors instead of fixing them
- Install a test framework, a chart library, or a queue library — see the docs for why
- Install the SAM CLI. `aws cloudformation deploy --capabilities CAPABILITY_AUTO_EXPAND`
  expands the SAM transform server-side
- Create per-customer IAM users. Customers never call AWS; usage is counted in the `Event` table
- Put Lambdas in a VPC (adds a ~$32/mo NAT Gateway for zero benefit)
