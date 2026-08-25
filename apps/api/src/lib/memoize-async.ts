/**
 * "실패는 캐시하지 않는 모듈 스코프 비동기 메모이즈"를 한 곳에 모읍니다.
 *
 * 이 프로젝트에서 4번 손으로 복사된 패턴이었습니다 — Secrets Manager 조회, DB 연결,
 * Lambda 부트스트랩처럼 콜드 스타트당 한 번만 하고 싶은데 실패하면 다음 호출이
 * 다시 시도해야 하는 경우. 캐싱 의미론을 고칠 일이 생기면 여기 한 곳만 고치면 됩니다.
 *
 * 데코레이터를 쓰지 않는 순수 모듈입니다 (node --test 대상).
 */

export type Memoized<Args extends unknown[], T> = {
  /** 진행 중이거나 완료된 Promise 를 재사용합니다. 없으면 factory 를 호출합니다. */
  run: (...args: Args) => Promise<T>;
  /** 테스트 전용. 다음 run() 이 factory 를 다시 호출하게 만듭니다. */
  reset: () => void;
};

export function memoizeAsync<Args extends unknown[], T>(
  factory: (...args: Args) => Promise<T>,
): Memoized<Args, T> {
  let cached: Promise<T> | null = null;

  return {
    run: (...args: Args): Promise<T> => {
      if (cached) return cached;
      cached = factory(...args).catch((cause) => {
        // 실패한 Promise 를 캐시로 남기면 컨테이너가 살아있는 내내 계속 실패합니다.
        cached = null;
        throw cause;
      });
      return cached;
    },
    reset: () => {
      cached = null;
    },
  };
}
