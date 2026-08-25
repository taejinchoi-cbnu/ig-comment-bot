import type { BotEvent, CommentEvent, MessageEvent } from '../webhook/normalize.ts';
import type { HandlerContext } from './context.ts';
import { handleComment } from './comment.handler.ts';
import { handleMessage } from './message.handler.ts';

/**
 * 이벤트 종류 → 핸들러 매핑. **기능 추가 지점은 여기 한 줄이다.**
 *
 * 새 이벤트를 다루려면 (1) normalize 에 케이스 추가 (2) 핸들러 파일 추가
 * (3) 아래 표에 한 줄. `satisfies` 가 빠뜨린 종류를 **컴파일 타임에** 잡는다.
 *
 * 데코레이터를 쓰지 않는 평범한 모듈로 유지한다 — NestJS 서비스로 만들면
 * 타입 스트리핑이 깨져 핸들러 테스트를 컴파일 없이 못 돌린다.
 */

type HandlerFor<E extends BotEvent> = (event: E, ctx: HandlerContext) => Promise<void>;

const handlers = {
  COMMENT: handleComment,
  MESSAGE: handleMessage,
} satisfies {
  COMMENT: HandlerFor<CommentEvent>;
  MESSAGE: HandlerFor<MessageEvent>;
};

/**
 * 이벤트 하나를 처리한다. 던지면 SQS 가 재시도하고, 5회 실패하면 DLQ 로 간다.
 * 어떤 에러를 던지고 어떤 것을 삼킬지는 각 핸들러가 정한다 (context.ts 의 isRetryableError).
 */
export async function dispatch(event: BotEvent, ctx: HandlerContext): Promise<void> {
  switch (event.kind) {
    case 'COMMENT':
      return handlers.COMMENT(event, ctx);
    case 'MESSAGE':
      return handlers.MESSAGE(event, ctx);
  }
}
