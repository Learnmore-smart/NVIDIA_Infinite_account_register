const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseVerificationCode,
  gmailBaseAddress,
  normalizeEmailConfig,
  createEmailCodeFetcher,
  messageMatchesRecipient
} = require('../email-code');

test('parseVerificationCode extracts a 6-digit code', () => {
  assert.equal(parseVerificationCode('Your NVIDIA code is 482913. Do not share it.'), '482913');
  assert.equal(parseVerificationCode('no code here'), null);
});

test('gmailBaseAddress strips plus tags', () => {
  assert.equal(gmailBaseAddress('owner+test_user_5@gmail.com'), 'owner@gmail.com');
  assert.equal(gmailBaseAddress('plain@gmail.com'), 'plain@gmail.com');
});

test('messageMatchesRecipient accepts plus-addressed To headers', () => {
  assert.equal(messageMatchesRecipient({
    to: ['owner+test_user_5@gmail.com'],
    deliveredTo: []
  }, 'owner+test_user_5@gmail.com'), true);
  assert.equal(messageMatchesRecipient({
    to: ['owner@gmail.com'],
    deliveredTo: ['owner+test_user_5@gmail.com']
  }, 'owner+test_user_5@gmail.com'), true);
  assert.equal(messageMatchesRecipient({
    to: ['other@gmail.com'],
    deliveredTo: []
  }, 'owner+test_user_5@gmail.com'), false);
});

test('normalizeEmailConfig prefers gmail_api when credentials present', () => {
  const config = normalizeEmailConfig(
    { provider: 'gmail_api', mailbox: 'owner@gmail.com' },
    {
      GMAIL_CLIENT_ID: 'cid',
      GMAIL_CLIENT_SECRET: 'sec',
      GMAIL_REFRESH_TOKEN: 'ref'
    }
  );
  assert.equal(config.provider, 'gmail_api');
  assert.equal(config.enabled, true);
  assert.equal(config.mailbox, 'owner@gmail.com');
  assert.equal(config.clientId, 'cid');
});

test('manual provider fetcher returns null immediately', async () => {
  const fetcher = createEmailCodeFetcher({ provider: 'manual' });
  assert.equal(fetcher.isEnabled(), false);
  assert.equal(await fetcher.waitForCode({ toEmail: 'a+b@gmail.com' }), null);
});

test('gmail_api fetcher returns code from matching message body', async () => {
  let listCalls = 0;
  const fetcher = createEmailCodeFetcher({
    provider: 'gmail_api',
    mailbox: 'owner@gmail.com',
    clientId: 'cid',
    clientSecret: 'sec',
    refreshToken: 'ref',
    pollIntervalMs: 0,
    timeoutMs: 2000,
    fetchImpl: async (url, options) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'atok' }) };
      }
      if (String(url).includes('/messages?')) {
        listCalls++;
        return {
          ok: true,
          json: async () => ({ messages: [{ id: 'm1' }] })
        };
      }
      if (String(url).includes('/messages/m1')) {
        return {
          ok: true,
          json: async () => ({
            payload: {
              headers: [
                { name: 'To', value: 'owner+test_user_5@gmail.com' },
                { name: 'Subject', value: 'NVIDIA verification' }
              ],
              body: {
                data: Buffer.from('Your verification code is 135790').toString('base64url')
              }
            },
            snippet: 'Your verification code is 135790'
          })
        };
      }
      throw new Error(`unexpected url ${url}`);
    }
  });

  const code = await fetcher.waitForCode({
    toEmail: 'owner+test_user_5@gmail.com',
    sinceMs: Date.now() - 60_000
  });
  assert.equal(code, '135790');
  assert.ok(listCalls >= 1);
});
