/**
 * Instagram Graph API 에러 처리.
 *
 * 재시도 분류 근거는 docs/meta-api.md §3:
 *  · 429 / 5xx / 네트워크 오류(fetch 자체가 throw) → 재시도하면 성공할 수 있음
 *  · 400 (잘못된 comment_id, 만료된 Private Reply 7일 창·24시간 후속 창) / 401·403 (토큰·권한)
 *    → 재시도해도 절대 성공하지 않음. SQS 로 돌려보내면 5회 재시도 후 DLQ 로 가서 노이즈만 만든다.
 *
 * 순수 함수 + 평범한 클래스로 유지하세요 (node --test 대상, 데코레이터 금지).
 */

const MESSAGE_MAX_LENGTH = 512;

export type InstagramApiErrorInfo = {
  status?: number;
  code?: number;
  errorSubcode?: number;
  type?: string;
  retryable: boolean;
};

export class InstagramApiError extends Error {
  readonly status?: number;
  readonly code?: number;
  readonly errorSubcode?: number;
  readonly type?: string;
  readonly retryable: boolean;

  constructor(message: string, info: InstagramApiErrorInfo) {
    super(message);
    this.name = 'InstagramApiError';
    this.status = info.status;
    this.code = info.code;
    this.errorSubcode = info.errorSubcode;
    this.type = info.type;
    this.retryable = info.retryable;
  }
}

/** HTTP status → 재시도 가능 여부. status 가 없으면 네트워크 오류로 취급합니다. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // 네트워크 오류 (fetch 자체가 throw)
  if (status === 429) return true;
  if (status >= 500) return true;
  return false; // 400 / 401 / 403 등
}

type MetaErrorBody = {
  message?: string;
  code?: number;
  errorSubcode?: number;
  type?: string;
};

/** Meta 에러 응답 본문 파싱. JSON 이 아니거나 error 필드가 없어도 던지지 않고 빈 값을 돌려줍니다. */
function parseMetaErrorBody(rawText: string): MetaErrorBody {
  if (!rawText) return {};
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const error = (parsed as Record<string, unknown>).error;
    if (typeof error !== 'object' || error === null) return {};
    const e = error as Record<string, unknown>;
    return {
      message: typeof e.message === 'string' ? e.message : undefined,
      code: typeof e.code === 'number' ? e.code : undefined,
      errorSubcode: typeof e.error_subcode === 'number' ? e.error_subcode : undefined,
      type: typeof e.type === 'string' ? e.type : undefined,
    };
  } catch {
    return {}; // JSON 파싱 실패 — 빈 값으로 계속 진행 (throw 하지 않음)
  }
}

/**
 * HTTP 에러 응답 → InstagramApiError.
 *
 * Meta 의 error.message 는 400 진단(잘못된 comment_id / 7일·24시간 창 만료 / 권한 부족 구분)에
 * 사실상 유일한 단서라 메시지에 포함합니다 (로그 오염 방지를 위해 512자로 자릅니다).
 *
 * 절대 넣지 않는 것: 우리가 보낸 요청 본문(DM 문구)과 access token.
 * 이 함수가 조합하는 값은 res(Meta 가 돌려준 응답)와 context(호출한 메서드 이름) 뿐입니다.
 * 나중에 "디버깅에 편하게 요청 본문도 넣자"는 유혹이 있어도, DM 문구는 개인정보이고
 * access token 은 비밀값이라 로그·에러 메시지에 남기면 안 됩니다 — 여기 조합에 추가하지 마세요.
 */
export async function toApiError(res: Response, context: string): Promise<InstagramApiError> {
  const rawText = await res.text().catch(() => '');
  const meta = parseMetaErrorBody(rawText);
  const truncatedMessage = meta.message ? meta.message.slice(0, MESSAGE_MAX_LENGTH) : undefined;

  const parts = [`Instagram API 요청 실패: ${context}`, `status=${res.status}`];
  if (meta.type) parts.push(`type=${meta.type}`);
  if (meta.code !== undefined) parts.push(`code=${meta.code}`);
  if (truncatedMessage) parts.push(`message=${truncatedMessage}`);

  return new InstagramApiError(parts.join(' '), {
    status: res.status,
    code: meta.code,
    errorSubcode: meta.errorSubcode,
    type: meta.type,
    retryable: isRetryableStatus(res.status),
  });
}

/** fetch 자체가 throw 했을 때 (네트워크 오류). 항상 재시도 가능으로 취급합니다. */
export function networkError(cause: unknown, context: string): InstagramApiError {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return new InstagramApiError(`Instagram API 요청 실패: ${context} — 네트워크 오류: ${causeMessage}`, {
    retryable: true,
  });
}
