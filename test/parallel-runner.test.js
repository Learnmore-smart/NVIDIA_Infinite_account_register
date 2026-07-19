const test = require('node:test');
const assert = require('node:assert/strict');

const ParallelPuppeteerRunner = require('../parallel-runner');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function createHarness({ completed = [] } = {}) {
  const saved = completed.map(testName => ({ testName, apiKey: `nvapi-${testName}` }));
  const children = [];
  const resultStore = {
    read: () => saved.map(result => ({ ...result })),
    has: testName => saved.some(result => result.testName === testName),
    upsert(result) {
      const index = saved.findIndex(row => row.testName === result.testName);
      if (index === -1) saved.push({ ...result });
      else saved[index] = { ...result };
    }
  };
  const childRunnerFactory = options => {
    const gate = deferred();
    const child = {
      options,
      isStopped: false,
      async run() {
        const result = await gate.promise;
        if (result && !this.isStopped) await options.onUserSuccess(result);
      },
      complete(result) { gate.resolve(result); },
      stop() {
        this.isStopped = true;
        gate.resolve(null);
      }
    };
    children.push(child);
    return child;
  };
  return { saved, children, resultStore, childRunnerFactory };
}

test('runs three isolated users by default and fills a freed worker slot', async () => {
  const harness = createHarness();
  const finished = [];
  const users = [1, 2, 3, 4].map(number => ({ testName: `test_user_${number}` }));
  const runner = new ParallelPuppeteerRunner({
    users,
    automationConfig: {},
    workspaceDir: 'D:\\automation',
    resultStore: harness.resultStore,
    childRunnerFactory: harness.childRunnerFactory,
    runIdFactory: () => 'run-fixed',
    onFinished: () => finished.push('finished')
  });

  const runPromise = runner.run();
  await flush();

  assert.equal(harness.children.length, 3);
  assert.equal(new Set(harness.children.map(child => child.options.targetUserDataDir)).size, 3);
  for (const child of harness.children) {
    assert.match(child.options.targetUserDataDir, /\.chrome_automation_profiles\\run-fixed\\worker-\d+-claim-\d+$/);
    assert.equal(child.options.persistResults, false);
  }

  harness.children[0].complete({ testName: 'test_user_1', apiKey: 'nvapi-one' });
  await flush();
  assert.equal(harness.children.length, 4);

  harness.children[1].complete({ testName: 'test_user_2', apiKey: 'nvapi-two' });
  harness.children[2].complete({ testName: 'test_user_3', apiKey: 'nvapi-three' });
  harness.children[3].complete({ testName: 'test_user_4', apiKey: 'nvapi-four' });
  await runPromise;

  assert.deepEqual(harness.saved.map(result => result.testName).sort(), users.map(user => user.testName));
  assert.deepEqual(finished, ['finished']);
});

test('clamps concurrency to one through five and skips persisted users', async () => {
  const harness = createHarness({ completed: ['test_user_1'] });
  const users = Array.from({ length: 8 }, (_, index) => ({ testName: `test_user_${index + 1}` }));
  const runner = new ParallelPuppeteerRunner({
    users,
    automationConfig: { parallelism: 99 },
    resultStore: harness.resultStore,
    childRunnerFactory: harness.childRunnerFactory,
    runIdFactory: () => 'bounded'
  });

  const runPromise = runner.run();
  await flush();
  assert.equal(runner.parallelism, 5);
  assert.equal(harness.children.length, 5);
  assert.equal(harness.children.some(child => child.options.users[0].testName === 'test_user_1'), false);

  while (harness.children.some(child => !child.isStopped && child.options.users[0])) {
    const incomplete = harness.children.filter(child => !child.completed);
    if (incomplete.length === 0) break;
    for (const child of incomplete) {
      child.completed = true;
      const name = child.options.users[0].testName;
      child.complete({ testName: name, apiKey: `nvapi-${name}` });
    }
    await flush();
    if (harness.saved.length === users.length) break;
  }
  await runPromise;
  assert.equal(harness.saved.length, users.length);

  const one = new ParallelPuppeteerRunner({ users: [], automationConfig: { parallelism: -4 }, resultStore: harness.resultStore });
  assert.equal(one.parallelism, 1);
});

test('stop closes every active child, prevents new claims, and finishes once', async () => {
  const harness = createHarness();
  const finished = [];
  const runner = new ParallelPuppeteerRunner({
    users: [1, 2, 3, 4].map(number => ({ testName: `test_user_${number}` })),
    automationConfig: { parallelism: 2 },
    resultStore: harness.resultStore,
    childRunnerFactory: harness.childRunnerFactory,
    onFinished: () => finished.push('finished')
  });

  const runPromise = runner.run();
  await flush();
  assert.equal(harness.children.length, 2);

  runner.stop();
  await runPromise;

  assert.equal(harness.children.every(child => child.isStopped), true);
  assert.equal(harness.children.length, 2);
  assert.deepEqual(harness.saved, []);
  assert.deepEqual(finished, ['finished']);
});
