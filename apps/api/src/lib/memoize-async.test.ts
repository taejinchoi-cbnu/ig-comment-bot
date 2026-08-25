import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoizeAsync } from './memoize-async.ts';

test('한 번만 factory 를 호출하고 이후는 캐시를 돌려준다', async () => {
  let calls = 0;
  const m = memoizeAsync(async () => {
    calls += 1;
    return 'value';
  });
  assert.equal(await m.run(), 'value');
  assert.equal(await m.run(), 'value');
  assert.equal(calls, 1);
});

test('동시 호출도 factory 를 한 번만 부른다', async () => {
  let calls = 0;
  const m = memoizeAsync(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return 'value';
  });
  const [a, b, c] = await Promise.all([m.run(), m.run(), m.run()]);
  assert.deepEqual([a, b, c], ['value', 'value', 'value']);
  assert.equal(calls, 1);
});

test('실패는 캐시하지 않는다 — 다음 호출이 다시 시도한다', async () => {
  let calls = 0;
  const m = memoizeAsync(async () => {
    calls += 1;
    if (calls === 1) throw new Error('일시적 실패');
    return 'ok';
  });
  await assert.rejects(() => m.run());
  assert.equal(await m.run(), 'ok');
  assert.equal(calls, 2);
});

test('reset() 은 다음 run() 이 factory 를 다시 부르게 만든다', async () => {
  let calls = 0;
  const m = memoizeAsync(async () => {
    calls += 1;
    return calls;
  });
  assert.equal(await m.run(), 1);
  m.reset();
  assert.equal(await m.run(), 2);
});

test('인자를 factory 에 그대로 넘긴다', async () => {
  const m = memoizeAsync(async (a: number, b: number) => a + b);
  assert.equal(await m.run(2, 3), 5);
});
