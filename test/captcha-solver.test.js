const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCaptchaConfig,
  createCaptchaSolver,
  mapCaptchaTypeToTask,
  buildInjectTokenScriptArgs
} = require('../captcha-solver');

test('normalizeCaptchaConfig reads CapSolver key from env', () => {
  const config = normalizeCaptchaConfig(
    { provider: 'capsolver', fallbackToHuman: true },
    { CAPSOLVER_API_KEY: 'CAP-TEST' }
  );
  assert.equal(config.provider, 'capsolver');
  assert.equal(config.apiKey, 'CAP-TEST');
  assert.equal(config.enabled, true);
  assert.equal(config.fallbackToHuman, true);
});

test('solver is disabled without API key', () => {
  const solver = createCaptchaSolver({ provider: 'capsolver', apiKey: '' });
  assert.equal(solver.isEnabled(), false);
});

test('mapCaptchaTypeToTask maps known providers', () => {
  assert.equal(mapCaptchaTypeToTask('hcaptcha', false), 'HCaptchaTaskProxyLess');
  assert.equal(mapCaptchaTypeToTask('hcaptcha', true), 'HCaptchaTask');
  assert.equal(mapCaptchaTypeToTask('recaptcha', false), 'ReCaptchaV2TaskProxyLess');
  assert.equal(mapCaptchaTypeToTask('turnstile', false), 'AntiTurnstileTaskProxyLess');
});

test('solve polls CapSolver until ready and returns token', async () => {
  const calls = [];
  const solver = createCaptchaSolver({
    provider: 'capsolver',
    apiKey: 'CAP-KEY',
    pollIntervalMs: 0,
    timeoutMs: 5000,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/createTask')) {
        return { ok: true, json: async () => ({ errorId: 0, taskId: 'task-1' }) };
      }
      return {
        ok: true,
        json: async () => ({
          errorId: 0,
          status: 'ready',
          solution: { gRecaptchaResponse: 'token-abc' }
        })
      };
    }
  });

  const token = await solver.solve({
    type: 'hcaptcha',
    websiteURL: 'https://login.nvidia.com/v1/create-account',
    websiteKey: 'site-key'
  });

  assert.equal(token, 'token-abc');
  assert.equal(calls[0].body.task.type, 'HCaptchaTaskProxyLess');
  assert.equal(calls[0].body.task.websiteKey, 'site-key');
});

test('buildInjectTokenScriptArgs carries token for page evaluate', () => {
  assert.deepEqual(buildInjectTokenScriptArgs('tok-1'), { token: 'tok-1' });
});
