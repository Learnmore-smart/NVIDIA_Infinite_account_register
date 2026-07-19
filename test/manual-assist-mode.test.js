const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PuppeteerRunner = require('../runner');

const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'runner.js'), 'utf8');
const legacyScriptSource = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

test('runner activates only cookie consent, verified email Next, the sole account action, and passkey Later', () => {
  assert.equal([...runnerSource.matchAll(/\.click\s*\(/g)].length, 4);
  assert.doesNotMatch(runnerSource, /page\.click\s*\(/);
  assert.doesNotMatch(runnerSource, /Runtime\.callFunctionOn/);
  assert.doesNotMatch(runnerSource, /clickButtonByText|submitExistingLogin/);
  assert.doesNotMatch(runnerSource, /resubmitCreateAccountAfterCaptcha|waitForRegistrationNavigationAfterCaptcha|submitAccountForm|accountMode/);
  assert.match(runnerSource, /submitVisibleAccountAction[\s\S]*?handleCaptchaIntervention[\s\S]*?submitVisibleAccountAction[\s\S]*?waitForFunction/);
  assert.match(runnerSource, /skipPasskeyCreation[\s\S]*?稍后再说/);
  assert.match(runnerSource, /await this\.page\.goto[\s\S]*?await this\.dismissCookieBanner\(\);[\s\S]*?await this\.fillEmailInput[\s\S]*?await this\.clickEmailNextAfterVerification/);
  assert.equal([...legacyScriptSource.matchAll(/\.click\s*\(/g)].length, 1);
  assert.doesNotMatch(legacyScriptSource, /page\.click\s*\(|Runtime\.callFunctionOn/);
  assert.match(legacyScriptSource, /await page\.goto[\s\S]*?await dismissCookieBanner\(page\);[\s\S]*?await fillStandardInput/);
});

test('prepares a clean cache and storage boundary for every user attempt', async () => {
  const commands = [];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    target: () => ({
      createCDPSession: async () => ({
        send: async (method, params) => commands.push({ method, params })
      })
    })
  };

  await runner.prepareCleanUserSession();

  assert.deepEqual(commands.slice(0, 3).map(command => command.method), [
    'Network.clearBrowserCookies',
    'Network.clearBrowserCache',
    'Network.setCacheDisabled'
  ]);
  assert.equal(commands[2].params.cacheDisabled, true);
  const clearedOrigins = commands
    .filter(command => command.method === 'Storage.clearDataForOrigin')
    .map(command => command.params.origin);
  assert.deepEqual(clearedOrigins, [
    'https://nvidia.com',
    'https://login.nvidia.com',
    'https://login.nvgs.nvidia.com',
    'https://static-login.nvidia.com',
    'https://cloudaccounts.nvidia.com',
    'https://build.nvidia.com',
    'https://api.ngc.nvidia.com'
  ]);
  assert.equal(commands.every(command => command.params?.storageTypes !== 'cookies' || command.method !== 'Storage.clearDataForOrigin'), true);
});

test('waits for the human to navigate without inspecting or activating controls', async () => {
  const calls = [];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    waitForFunction: async (fn, options, previousUrl) => {
      calls.push({ options, previousUrl });
      global.location = { href: 'https://next.example.test/' };
      try {
        assert.equal(fn(previousUrl), true);
      } finally {
        delete global.location;
      }
    }
  };

  assert.equal(await runner.waitForHumanNavigation('https://start.example.test/', 'test step'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].previousUrl, 'https://start.example.test/');
});
