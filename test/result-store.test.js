const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ResultStore = require('../result-store');

test('keeps only successful nvapi results and preserves rapid successive upserts', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novapura-result-store-'));
  const resultsFile = path.join(tempDir, 'api_keys_test.md');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(resultsFile, [
    '# Test Automation Results',
    '',
    '| Test Profile Name | API Key (Test) |',
    '|-------------------|----------------|',
    '| completed | nvapi-existing |',
    '| failed | Error: network |',
    '| malformed | not-a-key |'
  ].join('\n'));

  const store = new ResultStore({ resultsFile });
  assert.deepEqual(store.read(), [
    { testName: 'completed', apiKey: 'nvapi-existing' }
  ]);

  store.upsert({ testName: 'test_user_1', apiKey: 'nvapi-one' });
  store.upsert({ testName: 'test_user_2', apiKey: 'nvapi-two' });
  store.upsert({ testName: 'test_user_1', apiKey: 'nvapi-one-replaced' });

  assert.deepEqual(store.read(), [
    { testName: 'completed', apiKey: 'nvapi-existing' },
    { testName: 'test_user_1', apiKey: 'nvapi-one-replaced' },
    { testName: 'test_user_2', apiKey: 'nvapi-two' }
  ]);

  const saved = fs.readFileSync(resultsFile, 'utf8');
  assert.equal((saved.match(/\| test_user_1 \|/g) || []).length, 1);
  assert.match(saved, /\| test_user_2 \| nvapi-two \|/);
  assert.doesNotMatch(saved, /Error: network|not-a-key/);
});

test('rejects failure strings and non-nvapi values', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novapura-result-store-invalid-'));
  const resultsFile = path.join(tempDir, 'api_keys_test.md');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const store = new ResultStore({ resultsFile });
  assert.throws(
    () => store.upsert({ testName: 'failed', apiKey: 'Error: failed' }),
    /Only successful API keys/
  );
  assert.throws(
    () => store.upsert({ testName: 'wrong', apiKey: 'plain-text' }),
    /Only successful API keys/
  );
  assert.deepEqual(store.read(), []);
});

test('orders extracted test-user results numerically regardless of completion order', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novapura-result-store-order-'));
  const resultsFile = path.join(tempDir, 'api_keys_test.md');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const store = new ResultStore({ resultsFile });
  store.upsert({ testName: 'test_user_10', apiKey: 'nvapi-ten' });
  store.upsert({ testName: 'test_user_2', apiKey: 'nvapi-two' });
  store.upsert({ testName: 'test_user_1', apiKey: 'nvapi-one' });

  assert.deepEqual(store.read().map(result => result.testName), [
    'test_user_1',
    'test_user_2',
    'test_user_10'
  ]);
  assert.deepEqual(
    fs.readFileSync(resultsFile, 'utf8')
      .match(/\| test_user_\d+ \|/g),
    ['| test_user_1 |', '| test_user_2 |', '| test_user_10 |']
  );
});

test('rewrites an existing out-of-order report when loaded', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novapura-result-store-load-order-'));
  const resultsFile = path.join(tempDir, 'api_keys_test.md');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(resultsFile, [
    '# Test Automation Results',
    '',
    '| Test Profile Name | API Key (Test) |',
    '|-------------------|----------------|',
    '| test_user_10 | nvapi-ten |',
    '| test_user_2 | nvapi-two |',
    '| test_user_1 | nvapi-one |'
  ].join('\n'));

  new ResultStore({ resultsFile });

  assert.deepEqual(
    fs.readFileSync(resultsFile, 'utf8')
      .match(/\| test_user_\d+ \|/g),
    ['| test_user_1 |', '| test_user_2 |', '| test_user_10 |']
  );
});

test('appends extracted Markdown API keys to env without removing existing keys', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novapura-result-store-env-'));
  const resultsFile = path.join(tempDir, 'api_keys_test.md');
  const envFile = path.join(tempDir, '.env');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(resultsFile, [
    '# Test Automation Results',
    '',
    '| Test Profile Name | API Key (Test) |',
    '|-------------------|----------------|',
    '| test_user_10 | nvapi-ten |',
    '| test_user_2 | nvapi-two |',
    '| test_user_1 | nvapi-one |'
  ].join('\n'));
  fs.writeFileSync(envFile, 'nvapi-manually-added\nnvapi-ten\n');

  new ResultStore({ resultsFile, envFile });

  const envLines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.deepEqual(envLines.slice(0, 2), ['nvapi-manually-added', 'nvapi-ten']);
  assert.deepEqual(envLines.slice(2), ['nvapi-one', 'nvapi-two']);
  assert.ok(envLines.every(line => /^nvapi-[A-Za-z0-9_-]+$/.test(line)));
});
