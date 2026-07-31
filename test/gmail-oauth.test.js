const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getGmailOAuthConfig,
  getGmailConnectionStatus,
  buildGoogleAuthUrl,
  completeGmailOAuth,
  consumeOAuthState,
  createOAuthState
} = require('../gmail-oauth');

test('getGmailOAuthConfig requires client id/secret', () => {
  const cfg = getGmailOAuthConfig({ GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'sec' }, { port: 8080 });
  assert.equal(cfg.ready, true);
  assert.equal(cfg.redirectUri, 'http://localhost:8080/api/gmail/callback');
});

test('buildGoogleAuthUrl includes offline consent and gmail.readonly scope', () => {
  const { url, state } = buildGoogleAuthUrl({
    GMAIL_CLIENT_ID: 'cid',
    GMAIL_CLIENT_SECRET: 'csec'
  }, { port: 8080 });
  assert.match(url, /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  assert.match(url, /access_type=offline/);
  assert.match(url, /prompt=consent/);
  assert.match(url, /gmail\.readonly/);
  assert.match(url, new RegExp(`state=${state}`));
  assert.equal(consumeOAuthState(state), true);
  assert.equal(consumeOAuthState(state), false);
});

test('completeGmailOAuth writes refresh token and mailbox into .env', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-oauth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'GMAIL_CLIENT_ID=cid\nGMAIL_CLIENT_SECRET=csec\n');
  const env = {
    GMAIL_CLIENT_ID: 'cid',
    GMAIL_CLIENT_SECRET: 'csec'
  };
  const state = createOAuthState();
  const calls = [];
  const result = await completeGmailOAuth({
    code: 'auth-code',
    state,
    workspaceDir: dir,
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options?.body });
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'atok',
            refresh_token: 'rtok-123',
            expires_in: 3600,
            token_type: 'Bearer'
          })
        };
      }
      if (String(url).includes('userinfo')) {
        return {
          ok: true,
          json: async () => ({ email: 'owner@gmail.com' })
        };
      }
      throw new Error(`unexpected ${url}`);
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.mailbox, 'owner@gmail.com');
  assert.equal(env.GMAIL_REFRESH_TOKEN, 'rtok-123');
  assert.equal(env.GMAIL_MAILBOX, 'owner@gmail.com');
  const file = fs.readFileSync(envPath, 'utf8');
  assert.match(file, /GMAIL_REFRESH_TOKEN=rtok-123/);
  assert.match(file, /GMAIL_MAILBOX=owner@gmail.com/);
  assert.ok(calls.length >= 2);
});

test('getGmailConnectionStatus reflects refresh token', () => {
  assert.equal(getGmailConnectionStatus({
    GMAIL_CLIENT_ID: 'a',
    GMAIL_CLIENT_SECRET: 'b',
    GMAIL_REFRESH_TOKEN: 'r',
    GMAIL_MAILBOX: 'x@gmail.com'
  }).connected, true);
  assert.equal(getGmailConnectionStatus({
    GMAIL_CLIENT_ID: 'a',
    GMAIL_CLIENT_SECRET: 'b'
  }).connected, false);
});
