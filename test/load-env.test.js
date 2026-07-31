const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseEnvLine,
  loadEnvFile,
  ensureEnvTemplate,
  bootstrapProjectEnv
} = require('../load-env');

test('parseEnvLine handles quotes, comments, and bare nvapi keys', () => {
  assert.equal(parseEnvLine('# comment'), null);
  assert.deepEqual(parseEnvLine('CAPSOLVER_API_KEY=abc'), { key: 'CAPSOLVER_API_KEY', value: 'abc' });
  assert.deepEqual(parseEnvLine('GMAIL_MAILBOX="a@b.com"'), { key: 'GMAIL_MAILBOX', value: 'a@b.com' });
  assert.deepEqual(parseEnvLine('nvapi-ABC_def-123'), { bareApiKey: 'nvapi-ABC_def-123' });
});

test('loadEnvFile loads KEY=value and skips bare nvapi lines', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, [
    'CAPSOLVER_API_KEY=cap-1',
    'nvapi-alreadythere',
    'GMAIL_MAILBOX=me@gmail.com',
    ''
  ].join('\n'));
  const env = {};
  const result = loadEnvFile(envPath, { env });
  assert.equal(result.loaded, true);
  assert.equal(env.CAPSOLVER_API_KEY, 'cap-1');
  assert.equal(env.GMAIL_MAILBOX, 'me@gmail.com');
  assert.equal(env['nvapi-alreadythere'], undefined);
  assert.equal(result.bareApiKeys, 1);
});

test('bootstrapProjectEnv appends missing automation keys without wiping nvapi lines', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'nvapi-one\nnvapi-two\n');
  const env = {};
  bootstrapProjectEnv({ workspaceDir: dir, env });
  const content = fs.readFileSync(envPath, 'utf8');
  assert.match(content, /nvapi-one/);
  assert.match(content, /CAPSOLVER_API_KEY=/);
  assert.match(content, /GMAIL_REFRESH_TOKEN=/);
  assert.equal(env.CAPSOLVER_API_KEY, '');
});
