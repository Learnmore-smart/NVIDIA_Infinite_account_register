const test = require('node:test');
const assert = require('node:assert/strict');

const { createBackgroundBrowserLauncher } = require('../windows-focus');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

test('serializes Chrome startup and restores the active window without minimizing Chrome', async () => {
  const events = [];
  const firstGate = deferred();
  let activeWindow = 'dashboard';
  let launchCount = 0;
  const launchInBackground = createBackgroundBrowserLauncher({
    platform: 'win32',
    captureForegroundWindow: async () => {
      events.push(`capture:${activeWindow}`);
      return activeWindow;
    },
    minimizeBrowserWithoutActivation: async browser => {
      events.push(`minimize:${browser.name}`);
      activeWindow = `chrome:${browser.name}`;
    },
    restoreForegroundWindow: async windowHandle => {
      events.push(`restore:${windowHandle}`);
      activeWindow = windowHandle;
    }
  });
  const browserLauncher = async () => {
    launchCount++;
    const name = launchCount === 1 ? 'one' : 'two';
    events.push(`launch:${name}`);
    activeWindow = `chrome:${name}`;
    if (name === 'one') await firstGate.promise;
    return { name };
  };

  const first = launchInBackground(browserLauncher, { worker: 1 });
  const second = launchInBackground(browserLauncher, { worker: 2 });
  await flush();

  assert.equal(launchCount, 1);
  assert.deepEqual(events, ['capture:dashboard', 'launch:one']);

  firstGate.resolve();
  const [firstBrowser, secondBrowser] = await Promise.all([first, second]);

  assert.deepEqual([firstBrowser.name, secondBrowser.name], ['one', 'two']);
  assert.deepEqual(events, [
    'capture:dashboard',
    'launch:one',
    'restore:dashboard',
    'capture:dashboard',
    'launch:two',
    'restore:dashboard'
  ]);
  assert.equal(activeWindow, 'dashboard');
});

test('restores the prior foreground window when Chrome launch fails', async () => {
  const restored = [];
  const launchInBackground = createBackgroundBrowserLauncher({
    platform: 'win32',
    captureForegroundWindow: async () => 'current-worker',
    minimizeBrowserWithoutActivation: async () => {},
    restoreForegroundWindow: async handle => restored.push(handle)
  });

  await assert.rejects(
    () => launchInBackground(async () => { throw new Error('launch failed'); }, {}),
    /launch failed/
  );
  assert.deepEqual(restored, ['current-worker']);
});

test('uses the browser launcher directly outside Windows', async () => {
  let nativeCalls = 0;
  const browser = { name: 'portable' };
  const launchInBackground = createBackgroundBrowserLauncher({
    platform: 'linux',
    captureForegroundWindow: async () => { nativeCalls++; },
    minimizeBrowserWithoutActivation: async () => { nativeCalls++; },
    restoreForegroundWindow: async () => { nativeCalls++; }
  });

  assert.equal(await launchInBackground(async options => {
    assert.deepEqual(options, { worker: 1 });
    return browser;
  }, { worker: 1 }), browser);
  assert.equal(nativeCalls, 0);
});
