import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/semaphore.js';

/**
 * 评分原则：只断言对外契约，不断言内部字段。
 *
 * 说明：不同实现可能用 available / active / peak 等不同方式记内部账，
 * 断言内部字段会把正确实现误判为失败。所以这里全部通过**可观测行为**判定：
 * 同时进行数、是否阻塞、顺序、异常后是否归还、许可能否循环复用。
 */

/** 跑一批并发任务，返回观测到的最大同时进行数。 */
async function measurePeak(sem, taskCount, holdMs = 5) {
  let inFlight = 0;
  let observedPeak = 0;

  const tasks = Array.from({ length: taskCount }, () =>
    sem.run(async () => {
      inFlight += 1;
      if (inFlight > observedPeak) observedPeak = inFlight;
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      else await Promise.resolve();
      inFlight -= 1;
    }),
  );

  await Promise.all(tasks);
  return observedPeak;
}

/** 用"是否在超时前放行"判断一个 acquire 是被阻塞还是立即通过。 */
function admitted(promise, ms) {
  return Promise.race([
    promise.then(() => true),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);
}

test('并发 50 个任务、limit=3 时，同时进行数绝不超过 3', async () => {
  const sem = new Semaphore(3);
  const peak = await measurePeak(sem, 50, 1);
  assert.ok(peak <= 3, `观测到 ${peak} 个任务同时进行，超过了 limit=3`);
});

test('并发 40 个任务、limit=1 时严格串行', async () => {
  const sem = new Semaphore(1);
  const peak = await measurePeak(sem, 40, 1);
  assert.equal(peak, 1, `limit=1 时观测到 ${peak} 个任务同时进行`);
});

test('多轮并发后仍不超限（许可没有泄漏或被重复发放）', async () => {
  const sem = new Semaphore(4);
  for (let round = 0; round < 5; round++) {
    const peak = await measurePeak(sem, 20, 1);
    assert.ok(peak <= 4, `第 ${round + 1} 轮观测到 ${peak} 个并发，超过 limit=4`);
  }
});

test('直接配额：许可用尽后，后续 acquire 必须等待，不能直接放行', async () => {
  const limit = 2;
  const sem = new Semaphore(limit);

  for (let i = 0; i < limit; i++) await sem.acquire();
  const extra = await admitted(sem.acquire(), 250);
  assert.equal(
    extra,
    false,
    `limit=${limit} 且许可已被全部占用时，第 ${limit + 1} 个 acquire 必须排队，不能立即返回`,
  );
});

test('许可用尽且无人释放时应阻塞（失败即悬挂，成功即泄漏）', async () => {
  const sem = new Semaphore(1);
  await sem.acquire();
  let leaked = false;
  sem.acquire().then(() => {
    leaked = true;
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(leaked, false, 'limit=1 且许可已被占用时，第二个 acquire 不应该拿到许可');
});

test('run 抛异常时也必须释放许可（否则后续任务永久阻塞）', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(
    () =>
      sem.run(async () => {
        throw new Error('任务内部失败');
      }),
    /任务内部失败/,
  );

  const done = await admitted(
    sem.run(async () => {
      return 'ok';
    }),
    1200,
  );
  assert.equal(done, true, '前一个任务抛异常后许可没有归还，后续任务被永久阻塞');
});

test('release 应把许可交给等待队列最前面的调用者（FIFO）', async () => {
  const sem = new Semaphore(1);
  const order = [];

  const first = sem.run(async () => {
    order.push('running');
    await new Promise((r) => setTimeout(r, 30));
  });
  await new Promise((r) => setTimeout(r, 5));

  const waiters = ['w1', 'w2', 'w3'].map((name) =>
    sem.run(async () => {
      order.push(name);
    }),
  );

  await Promise.all([first, ...waiters]);
  assert.deepEqual(order, ['running', 'w1', 'w2', 'w3'], '等待者应按先来后到依次获得许可');
});

test('许可可循环复用：100 轮串行 run 全部完成', async () => {
  const sem = new Semaphore(2);
  let completed = 0;
  for (let i = 0; i < 100; i++) {
    await sem.run(async () => {
      await Promise.resolve();
      completed += 1;
    });
  }
  assert.equal(completed, 100, `只完成了 ${completed}/100 轮`);

  // 循环之后仍然要能满额并发
  const peak = await measurePeak(sem, 12, 1);
  assert.ok(peak <= 2, `循环复用后出现 ${peak} 个并发，超过 limit=2`);
  assert.ok(peak >= 1, '循环复用后竟然无法并发运行，许可可能没有归还');
});

test('交替 acquire/release 大量次数后仍能满额并发', async () => {
  const limit = 3;
  const sem = new Semaphore(limit);
  for (let i = 0; i < 60; i++) {
    await sem.acquire();
    sem.release();
  }
  const peak = await measurePeak(sem, 30, 1);
  assert.equal(peak, limit, `交替 ${60} 次后应能跑满 ${limit} 个并发，实际峰值 ${peak}`);
});

test('大量任务全部完成，且都真正进入过临界区', async () => {
  const sem = new Semaphore(2);
  let entered = 0;
  await Promise.all(
    Array.from({ length: 30 }, () =>
      sem.run(async () => {
        entered += 1;
        await new Promise((r) => setTimeout(r, 1));
      }),
    ),
  );
  assert.equal(entered, 30, `只有 ${entered}/30 个任务进入临界区，可能存在永久阻塞`);
});
