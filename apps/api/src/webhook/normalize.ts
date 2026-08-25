/**
 * Meta webhook payload → 내부 이벤트로 정규화합니다.
 *
 * 제약과 payload 실제 형태는 docs/meta-api.md 참조. 요약하면:
 *  · 댓글은 entry[].changes[], 메시지는 entry[].messaging[] — 구조가 다릅니다
 *  · is_echo / is_self 를 거르지 않으면 봇이 자기 DM 에 반응해 무한루프가 됩니다
 *  · 셀프 댓글(value.from.id === entry.id)은 자기 자신에게 DM 이라 발송이 실패합니다
 *
 * 순수 함수로 유지하세요 — I/O, DB, 데코레이터, 생성된 Prisma 코드를 들이지 않습니다.
 * (Node 타입 스트리핑으로 `node --test` 가 컴파일 없이 돌리는 대상입니다)
 */

export type CommentEvent = {
  kind: 'COMMENT';
  igUserId: string; // entry[].id — 어느 계정으로 온 이벤트인가
  commentId: string;
  mediaId: string;
  igsid: string; // 댓글 작성자
  username?: string;
  text?: string;
};

export type MessageEvent = {
  kind: 'MESSAGE';
  igUserId: string;
  messageId: string;
  igsid: string; // 보낸 사람
  text: string;
};

export type BotEvent = CommentEvent | MessageEvent;

/** DB의 SkipReason enum 중 normalize 단계에서 판정 가능한 것들 */
export type NormalizeSkipReason = 'SELF_COMMENT' | 'ECHO' | 'NO_TEXT' | 'ACCOUNT_MISMATCH';

export type SkippedEvent = {
  reason: NormalizeSkipReason;
  igUserId?: string;
  igsid?: string;
  username?: string;
  mediaId?: string;
};

export type NormalizeResult = {
  events: BotEvent[];
  /** 버린 것도 남깁니다 — "왜 DM 이 안 갔지?" 에 답하려면 기록이 있어야 합니다 */
  skipped: SkippedEvent[];
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * @param body   파싱된 webhook 본문 (신뢰할 수 없는 입력)
 * @param expectedIgUserId 이 slug 에 연결된 계정의 IG User ID
 */
export function normalize(body: unknown, expectedIgUserId: string): NormalizeResult {
  const events: BotEvent[] = [];
  const skipped: SkippedEvent[] = [];

  if (!isRecord(body) || body.object !== 'instagram') return { events, skipped };

  for (const entry of arr(body.entry)) {
    if (!isRecord(entry)) continue;

    const igUserId = str(entry.id);
    if (!igUserId) continue;

    // 경로의 계정과 본문의 계정이 다르면 잘못 배달된 이벤트입니다
    if (igUserId !== expectedIgUserId) {
      skipped.push({ reason: 'ACCOUNT_MISMATCH', igUserId });
      continue;
    }

    for (const change of arr(entry.changes)) {
      readComment(change, igUserId, events, skipped);
    }
    for (const messaging of arr(entry.messaging)) {
      readMessage(messaging, igUserId, events, skipped);
    }
  }

  return { events, skipped };
}

function readComment(
  change: unknown,
  igUserId: string,
  events: BotEvent[],
  skipped: SkippedEvent[],
): void {
  if (!isRecord(change) || change.field !== 'comments') return;

  const value = change.value;
  if (!isRecord(value)) return;

  // 댓글 삭제/수정 알림에는 반응하지 않습니다. verb 가 없으면 생성으로 봅니다.
  const verb = str(value.verb);
  if (verb && verb !== 'add') return;

  const from = isRecord(value.from) ? value.from : undefined;
  const igsid = str(from?.id);
  const username = str(from?.username);
  const media = isRecord(value.media) ? value.media : undefined;
  const mediaId = str(media?.id);

  // 내 계정이 내 글에 단 댓글도 webhook 이 발사됩니다.
  // Private Reply 는 자기 자신에게 DM 하는 셈이라 반드시 실패합니다.
  if (igsid && igsid === igUserId) {
    skipped.push({ reason: 'SELF_COMMENT', igUserId, igsid, username, mediaId });
    return;
  }

  const commentId = str(value.id);
  if (!commentId || !igsid || !mediaId) return; // 우리가 아는 형태가 아님

  events.push({
    kind: 'COMMENT',
    igUserId,
    commentId,
    mediaId,
    igsid,
    ...(username ? { username } : {}),
    ...(str(value.text) ? { text: str(value.text)! } : {}),
  });
}

function readMessage(
  messaging: unknown,
  igUserId: string,
  events: BotEvent[],
  skipped: SkippedEvent[],
): void {
  if (!isRecord(messaging)) return;

  const message = isRecord(messaging.message) ? messaging.message : undefined;
  if (!message) return; // read / delivery / postback 등은 대상이 아닙니다

  const sender = isRecord(messaging.sender) ? messaging.sender : undefined;
  const igsid = str(sender?.id);

  // 봇이 보낸 DM 이 되돌아오는 경로. 거르지 않으면 자기 메시지에 자기가 반응합니다.
  // is_echo/is_self 플래그와 sender 동일성 — 어느 쪽이든 잡습니다.
  if (message.is_echo === true || message.is_self === true || (igsid && igsid === igUserId)) {
    skipped.push({ reason: 'ECHO', igUserId, igsid });
    return;
  }

  const text = str(message.text);
  if (!text) {
    // 스티커·리액션·첨부만 있는 메시지
    skipped.push({ reason: 'NO_TEXT', igUserId, ...(igsid ? { igsid } : {}) });
    return;
  }

  const messageId = str(message.mid);
  if (!messageId || !igsid) return;

  events.push({ kind: 'MESSAGE', igUserId, messageId, igsid, text });
}
