# Isolated Parallel User Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run up to five human-assisted NVIDIA test-user sessions concurrently, with three by default and a separate Chrome process, disposable profile, cache, and state boundary for every active account.

**Architecture:** Keep `PuppeteerRunner` as the single-user session engine and add `ParallelPuppeteerRunner` as the batch orchestrator. A central `ResultStore` is the only API-key report writer, while profile helpers accept validated per-session directories beneath `.chrome_automation_profiles`.

**Tech Stack:** Node.js, Puppeteer, Express, browser JavaScript, Chrome DevTools Protocol, `node:test`.

---

### Task 1: Centralize successful-result persistence

**Files:**
- Create: `result-store.js`
- Create: `.ai/result-store.md`
- Create: `test/result-store.test.js`
- Create: `.ai/test/result-store.test.md`
- Modify: `runner.js`

- [ ] **Step 1: Write failing result-store tests**

Cover parsing only valid `nvapi-` rows, idempotent upsert by `testName`, and two immediate completions surviving in the same markdown snapshot:

```js
const store = new ResultStore({ resultsFile, fsImpl });
store.upsert({ testName: 'test_user_1', apiKey: 'nvapi-one' });
store.upsert({ testName: 'test_user_2', apiKey: 'nvapi-two' });
assert.deepEqual(store.read().map(row => row.testName), ['test_user_1', 'test_user_2']);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/result-store.test.js`

Expected: FAIL because `result-store.js` does not exist.

- [ ] **Step 3: Implement the single-writer store**

Expose `isSuccessfulResult`, `read`, `has`, `replaceAll`, and `upsert`. `upsert` must synchronously update one owned accumulator and write one full markdown snapshot:

```js
class ResultStore {
  constructor({ resultsFile, fsImpl = fs }) {
    this.resultsFile = resultsFile;
    this.fs = fsImpl;
    this.results = this.readFromDisk();
  }

  upsert(result) {
    if (!isSuccessfulResult(result)) throw new Error('Only successful API keys may be persisted.');
    const index = this.results.findIndex(row => row.testName === result.testName);
    if (index === -1) this.results.push({ ...result });
    else this.results[index] = { ...result };
    this.writeSnapshot();
  }
}
```

Retain `PuppeteerRunner` compatibility methods by delegating `readExistingResults`, `hasValidKey`, and `exportResults` to the injected/default store.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/result-store.test.js test/manual-assist-mode.test.js`

Expected: all tests pass and failure strings remain excluded.

### Task 2: Add validated per-session profile paths

**Files:**
- Modify: `edge-launch.js`
- Modify: `.ai/edge-launch.md`
- Modify: `test/edge-launch.test.js`
- Modify: `.ai/test/edge-launch.test.md`

- [ ] **Step 1: Write failing isolation tests**

Assert different `targetUserDataDir` values produce different launch options, cleanup accepts only descendants of `.chrome_automation_profiles`, and traversal/daily-profile targets throw:

```js
const first = createChromeTargetLaunchOptions({ targetUserDataDir: 'D:\\app\\.chrome_automation_profiles\\run\\worker-1' });
const second = createChromeTargetLaunchOptions({ targetUserDataDir: 'D:\\app\\.chrome_automation_profiles\\run\\worker-2' });
assert.notEqual(first.userDataDir, second.userDataDir);
assert.throws(() => resetChromeAutomationProfile({ workspaceDir: 'D:\\app', targetUserDataDir: 'C:\\Users\\daily' }), /Unsafe/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/edge-launch.test.js`

Expected: FAIL because launch/reset still force one shared profile path.

- [ ] **Step 3: Implement strict profile resolution**

Add a resolver that permits the legacy exact `.chrome_automation_user_data` path and new descendants of `.chrome_automation_profiles`, while rejecting the root itself and all outside paths:

```js
function resolveChromeAutomationProfile({ workspaceDir = __dirname, targetUserDataDir }) {
  const workspace = path.win32.resolve(workspaceDir);
  const profilesRoot = path.win32.join(workspace, '.chrome_automation_profiles');
  const target = path.win32.resolve(targetUserDataDir || path.win32.join(workspace, '.chrome_automation_user_data'));
  const relative = path.win32.relative(profilesRoot, target);
  const isIsolatedChild = relative && !relative.startsWith('..') && !path.win32.isAbsolute(relative);
  if (target !== path.win32.join(workspace, '.chrome_automation_user_data') && !isIsolatedChild) {
    throw new Error(`Unsafe Chrome automation profile path: ${target}`);
  }
  return target;
}
```

Use the resolved target in both launch options and cleanup.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/edge-launch.test.js`

Expected: all edge-launch tests pass.

### Task 3: Make one runner instance one isolated session owner

**Files:**
- Modify: `runner.js`
- Modify: `.ai/runner.md`
- Modify: `test/runner-browser-lifecycle.test.js`
- Modify: `test/manual-assist-mode.test.js`

- [ ] **Step 1: Write failing session-boundary tests**

Inject `targetUserDataDir` and prove launch, extension seeding, cleanup after launch failure, normal close, and retry all use that exact path. Also assert the injected banner includes the current test name.

```js
const runner = new PuppeteerRunner({
  users: [user],
  targetUserDataDir: 'D:\\app\\.chrome_automation_profiles\\run-1\\worker-1',
  targetLaunchOptionsFactory: options => ({ userDataDir: options.targetUserDataDir })
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/runner-browser-lifecycle.test.js test/manual-assist-mode.test.js`

Expected: FAIL because the runner still hardcodes `.chrome_automation_user_data` and the banner is generic.

- [ ] **Step 3: Implement injected session ownership**

Accept `targetUserDataDir`, `resultStore`, `persistResults`, and `onUserSuccess` in the constructor. Pass the profile path through reset, extension copy, and launch calls. On success:

```js
const resultObj = { testName: user.testName, apiKey: userApiKey };
if (this.persistResults) this.resultStore.upsert(resultObj);
await this.onUserSuccess(resultObj);
```

Change `injectWarningBanner(testName)` so each visible window displays `🤖 自动填充：<testName>（按钮请人工操作）`. Keep cookie dismissal before banner injection and typing.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/runner-browser-lifecycle.test.js test/manual-assist-mode.test.js test/result-store.test.js`

Expected: all focused tests pass and the source scan still finds only the cookie-consent DOM click.

### Task 4: Add the bounded parallel orchestrator

**Files:**
- Create: `parallel-runner.js`
- Create: `.ai/parallel-runner.md`
- Create: `test/parallel-runner.test.js`
- Create: `.ai/test/parallel-runner.test.md`

- [ ] **Step 1: Write failing worker-pool tests**

Use a fake child-runner factory with deferred promises to prove default concurrency three, configured bounds one through five, completed-user skipping, retry ownership delegated to the child, other workers advancing while one waits, single result persistence, stop-all behavior, no post-stop claims, and `onFinished` exactly once.

```js
const runner = new ParallelPuppeteerRunner({ users, childRunnerFactory, resultStore });
const runPromise = runner.run();
assert.equal(createdChildren.length, 3);
createdChildren[1].complete({ testName: 'test_user_2', apiKey: 'nvapi-two' });
await flushPromises();
assert.equal(createdChildren.length, 4);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/parallel-runner.test.js`

Expected: FAIL because `parallel-runner.js` does not exist.

- [ ] **Step 3: Implement the orchestrator**

Clamp concurrency and create worker loops that claim users through a synchronous cursor:

```js
this.parallelism = Math.min(5, Math.max(1, Number.parseInt(automationConfig.parallelism, 10) || 3));

async runWorker(workerIndex) {
  while (!this.isStopped) {
    const user = this.claimNextUser();
    if (!user) return;
    const child = this.createChildRunner(user, workerIndex);
    this.activeRunners.add(child);
    try { await child.run(); }
    finally { this.activeRunners.delete(child); }
  }
}
```

Generate a unique validated profile path per claimed user beneath `.chrome_automation_profiles/<run-id>/`. Child runners receive one user, `persistResults: false`, and an `onUserSuccess` callback that calls the shared store exactly once.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/parallel-runner.test.js test/result-store.test.js test/edge-launch.test.js`

Expected: all orchestration and isolation tests pass.

### Task 5: Wire server and Dashboard configuration

**Files:**
- Modify: `server.js`
- Modify: `.ai/server.md`
- Modify: `public/index.html`
- Modify: `.ai/public/index.html.md`
- Modify: `public/index.js`
- Modify: `.ai/public/index.js.md`
- Modify: `test/dashboard-localization.test.js`
- Modify: `.ai/test/dashboard-localization.test.md`

- [ ] **Step 1: Write failing server/UI contract tests**

Assert the server imports/constructs `ParallelPuppeteerRunner`, configuration normalizes missing/invalid values to three and clamps to one through five, and Dashboard load/save includes `parallelism`.

```js
assert.match(serverSource, /new ParallelPuppeteerRunner/);
assert.match(html, /id="parallelism"/);
assert.match(clientSource, /parallelism:\s*Number\.parseInt/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/dashboard-localization.test.js test/parallel-runner.test.js`

Expected: FAIL because the server and configuration UI still expose only `targetUrl`.

- [ ] **Step 3: Implement server and Dashboard wiring**

Replace the server's batch constructor with `ParallelPuppeteerRunner`. Add this field beside the target URL:

```html
<label for="parallelism">同时运行窗口数（1–5）</label>
<input type="number" id="parallelism" min="1" max="5" value="3" required>
```

On load use `automationConfig.parallelism ?? 3`; on save clamp the integer before posting. Server-side normalization remains authoritative.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/dashboard-localization.test.js test/parallel-runner.test.js`

Expected: all server/UI contract tests pass.

### Task 6: Full verification and handoff

**Files:**
- Modify: `.ai/PROJECT_CONTEXT.md`
- Modify: relevant `.ai` mirrors listed above

- [ ] **Step 1: Run the complete test suite**

Run: `npm.cmd test`

Expected: every test passes.

- [ ] **Step 2: Run syntax checks**

Run: `node --check runner.js; node --check parallel-runner.js; node --check result-store.js; node --check edge-launch.js; node --check server.js; node --check public/index.js`

Expected: exit code zero for every file.

- [ ] **Step 3: Run safety source scans**

Search production JavaScript for `.click(`, `page.click`, `Runtime.callFunctionOn`, `.chrome_automation_user_data`, and `.chrome_automation_profiles`. Confirm the only target-page click is cookie consent and every recursive profile cleanup resolves through the strict validator.

- [ ] **Step 4: Sync documentation**

Mark all `.ai` Open Threads complete, record final test counts, and replace the open project-context entry with the delivered concurrency/isolation contract. Note that the workspace has no usable Git repository, so commit steps are unavailable.
