# ig-comment-bot

인스타그램 게시물에 키워드 댓글이 달리면 **자동으로 DM을 보내고, 그게 얼마나 먹혔는지 보여주는** 웹 서비스.

사용자가 하는 일은 두 가지뿐 — 게시글 URL 붙여넣기, 보낼 DM 쓰기.
그 다음 대시보드에서 `댓글 84 → DM 79 → 답장 41 → 양식 38` 을 본다.

> 지인들이 상용 자동 DM 서비스에 가진 불만은 "기능이 부족하다"가 아니라
> **"쓰기가 어렵다"와 "통계가 어렵다"** 였다. 그 둘을 해결하려고 만든다.

**React + Vite + TS / NestJS + TS / PostgreSQL + Prisma / AWS Lambda + SQS + CloudFront** · 월 ~$1~2

## 📖 문서는 [`docs/README.md`](docs/README.md) 에서 시작

| | |
|---|---|
| [`docs/why.md`](docs/why.md) | 배경 · 시장 조사 · 제품 원칙 |
| [`docs/architecture.md`](docs/architecture.md) | 스택 결정 근거 · 데이터 모델 · 코드 구조 |
| [`docs/meta-api.md`](docs/meta-api.md) | Meta API 검증된 제약과 함정 ★ |
| [`docs/phase-2-web.md`](docs/phase-2-web.md) | 현재 단계 (Phase 1 완료) |

회고는 [`study/`](study/) — PAAR 구조로 판단 과정을 기록.
에이전트/기여자 규칙은 [`AGENTS.md`](AGENTS.md).
