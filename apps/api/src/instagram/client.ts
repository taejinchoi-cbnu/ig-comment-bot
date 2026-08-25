import { networkError, toApiError } from './errors.ts';

/**
 * Instagram Graph API 클라이언트.
 *
 * NestJS 데코레이터를 쓰지 않는 평범한 클래스입니다. Node 타입 스트리핑으로
 * `node --test` 가 컴파일 없이 이 파일을 돌리는데, 타입 스트리핑은 데코레이터를
 * 변환하지 못해 넣는 순간 깨집니다.
 *
 * fetch 는 생성자로 주입받습니다 — 테스트에서 가짜 함수로 교체하기 위함이고,
 * 전역 fetch 를 몽키패치하지 않기 위함입니다. Node 24 내장 global fetch 를 기본값으로 씁니다.
 */

export type SendMessageResult = {
  recipientId: string;
  messageId: string;
};

export type InstagramApiClientOptions = {
  igUserId: string;
  accessToken: string;
  /** 기본 'v25.0'. 덮어쓸 수 있습니다. */
  apiVersion?: string;
  /** 테스트 주입용. 기본값은 global fetch. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_API_VERSION = 'v25.0';
const BASE_URL = 'https://graph.instagram.com';

export class InstagramApiClient {
  private readonly igUserId: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: InstagramApiClientOptions) {
    this.igUserId = opts.igUserId;
    this.accessToken = opts.accessToken;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * 댓글에 대한 Private Reply. 댓글당 1회만, 게시 후 7일 이내만 성공합니다
   * (docs/meta-api.md §1-9). 창이 지나면 400 이 오고 재시도해도 성공하지 않습니다.
   */
  async sendPrivateReply(commentId: string, text: string): Promise<SendMessageResult> {
    return this.postMessage({ recipient: { comment_id: commentId }, message: { text } }, 'sendPrivateReply');
  }

  /**
   * 사용자가 답장한 뒤의 후속 메시지. 응답 후 24시간 이내만 성공합니다 (docs/meta-api.md §1-10).
   */
  async sendMessage(igsid: string, text: string): Promise<SendMessageResult> {
    return this.postMessage({ recipient: { id: igsid }, message: { text } }, 'sendMessage');
  }

  /** 토큰 유효성 확인용. */
  async getMe(): Promise<{ userId: string; username: string }> {
    const url = `${BASE_URL}/${this.apiVersion}/me?fields=user_id,username`;
    const res = await this.request(url, { method: 'GET' }, 'getMe');
    if (!res.ok) throw await toApiError(res, 'getMe');
    const body = (await res.json()) as { user_id?: string; username?: string };
    // 토큰 검증과 계정 동일성 확인에 쓰이는 값입니다. 빈 문자열로 넘기면
    // "검증 성공인데 계정을 모른다"는 상태가 되어 연결 마법사가 잘못된 계정을
    // connected 로 저장할 수 있습니다. 없으면 실패로 취급합니다.
    if (!body.user_id) throw new Error('getMe 응답에 user_id 가 없습니다');
    return { userId: body.user_id, username: body.username ?? '' };
  }

  /**
   * 계정 연결 절차의 필수 단계. App Dashboard 에서 필드를 구독하는 것만으로는 부족하고,
   * 계정마다 이 호출이 있어야 합니다. 빠뜨리면 webhook 이 한 건도 오지 않습니다 —
   * 가장 흔한 실패 지점입니다 (docs/meta-api.md §1-6, §4).
   */
  async subscribeApp(): Promise<void> {
    const url = `${BASE_URL}/${this.apiVersion}/me/subscribed_apps?subscribed_fields=comments,messages`;
    const res = await this.request(url, { method: 'POST' }, 'subscribeApp');
    if (!res.ok) throw await toApiError(res, 'subscribeApp');
  }

  private async postMessage(body: unknown, context: string): Promise<SendMessageResult> {
    const url = `${BASE_URL}/${this.apiVersion}/${this.igUserId}/messages`;
    const res = await this.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      context,
    );
    if (!res.ok) throw await toApiError(res, context);
    const parsed = (await res.json()) as { recipient_id?: string; message_id?: string };
    return { recipientId: parsed.recipient_id ?? '', messageId: parsed.message_id ?? '' };
  }

  /** 인증 헤더 부착 + fetch 자체 오류를 InstagramApiError 로 감싸는 공통 경로. */
  private async request(url: string, init: RequestInit, context: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.accessToken}` },
      });
    } catch (cause) {
      throw networkError(cause, context);
    }
  }
}
