const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProxyConfig,
  createProxySession,
  buildProxyLaunchArgs,
  parseExtractedProxyLine
} = require('../proxy-pool');

test('normalizeProxyConfig defaults to disabled and merges env credentials', () => {
  const config = normalizeProxyConfig(
    { enabled: true, server: 'http://gate.example:8080', usernameTemplate: 'user-session-{sessionId}' },
    { YIYUAN_PROXY_PASSWORD: 'secret', YIYUAN_PROXY_USERNAME: 'baseuser' }
  );
  assert.equal(config.enabled, true);
  assert.equal(config.server, 'http://gate.example:8080');
  assert.equal(config.password, 'secret');
  assert.equal(config.usernameTemplate, 'user-session-{sessionId}');
  assert.equal(config.fallbackUsername, 'baseuser');
});

test('createProxySession builds sticky credentials from template', async () => {
  const session = await createProxySession(
    {
      enabled: true,
      mode: 'gateway',
      server: 'http://gate.example:9000',
      usernameTemplate: 'acct-session-{sessionId}-country-us',
      password: 'pw'
    },
    { sessionId: 'user5abc', testName: 'test_user_5' }
  );

  assert.equal(session.enabled, true);
  assert.equal(session.sessionId, 'user5abc');
  assert.equal(session.username, 'acct-session-user5abc-country-us');
  assert.equal(session.password, 'pw');
  assert.equal(session.puppeteerProxy, 'http://gate.example:9000');
  assert.deepEqual(session.authenticate, { username: 'acct-session-user5abc-country-us', password: 'pw' });
  assert.deepEqual(buildProxyLaunchArgs(session), ['--proxy-server=http://gate.example:9000']);
});

test('createProxySession is disabled when config off or incomplete', async () => {
  assert.equal((await createProxySession({ enabled: false }, { sessionId: 'x' })).enabled, false);
  assert.equal((await createProxySession({
    enabled: true,
    mode: 'gateway',
    server: '',
    password: 'pw'
  }, { sessionId: 'x' })).enabled, false);
});

test('parseExtractedProxyLine accepts host:port and host:port:user:pass', () => {
  assert.deepEqual(parseExtractedProxyLine('1.2.3.4:8080'), {
    host: '1.2.3.4',
    port: '8080',
    username: '',
    password: ''
  });
  assert.deepEqual(parseExtractedProxyLine('1.2.3.4:8080:u:p'), {
    host: '1.2.3.4',
    port: '8080',
    username: 'u',
    password: 'p'
  });
});

test('createProxySession api_extract mode uses first valid line from fetch body', async () => {
  const session = await createProxySession(
    {
      enabled: true,
      mode: 'api_extract',
      extractUrl: 'https://api.example/get?num=1',
      password: 'ignored-if-line-has-pass'
    },
    {
      sessionId: 's1',
      fetchImpl: async () => ({
        ok: true,
        text: async () => '10.0.0.9:6000:user9:pass9\n'
      })
    }
  );

  assert.equal(session.enabled, true);
  assert.equal(session.puppeteerProxy, 'http://10.0.0.9:6000');
  assert.equal(session.username, 'user9');
  assert.equal(session.password, 'pass9');
});
