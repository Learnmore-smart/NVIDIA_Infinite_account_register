const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function createElement() {
  return {
    addEventListener() {},
    appendChild() {},
    classList: { add() {}, remove() {}, toggle() {} },
    innerHTML: '',
    value: ''
  };
}

function loadClient({ fetchImpl }) {
  const elements = new Map();
  const context = vm.createContext({
    alert() {},
    confirm: () => true,
    console,
    document: {
      createElement,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement());
        return elements.get(id);
      },
      querySelectorAll: () => []
    },
    EventSource: class {},
    fetch: fetchImpl,
    window: { addEventListener() {} }
  });

  const source = fs.readFileSync(path.join(root, 'public', 'index.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'public/index.js' });
  return context;
}

test('dashboard deletes one user through the dedicated server endpoint', async () => {
  const requests = [];
  const context = loadClient({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return { json: async () => ({ success: true }) };
    }
  });

  vm.runInContext("usersList = [{ testName: 'first' }, { testName: 'second' }]", context);
  await vm.runInContext('deleteUser(1)', context);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/users/1');
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(requests[0].options.body, undefined);
  const remainingNames = vm.runInContext(
    'JSON.stringify(usersList.map(user => user.testName))',
    context
  );
  assert.deepEqual(JSON.parse(remainingNames), ['first']);
});

function loadServerWithUsers(initialUsers) {
  const routes = new Map();
  let storedUsers = JSON.stringify(initialUsers);
  const app = {
    delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    listen() {},
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    use() {}
  };
  const express = () => app;
  express.static = () => () => {};
  const fsImpl = {
    existsSync: () => true,
    readFileSync(filePath) {
      if (filePath.endsWith('users_config.json')) return storedUsers;
      return '{}';
    },
    writeFileSync(filePath, value) {
      if (filePath.endsWith('users_config.json')) storedUsers = value;
    }
  };
  const requireImpl = request => {
    if (request === 'express') return express;
    if (request === 'body-parser') return { json: () => () => {} };
    if (request === 'fs') return fsImpl;
    if (request === 'path') return path;
    if (request === './load-env') {
      return {
        bootstrapProjectEnv: () => ({ loaded: false, path: '', keys: [], bareApiKeys: 0 })
      };
    }
    if (request === './gmail-oauth') {
      return {
        getGmailConnectionStatus: () => ({
          clientConfigured: false,
          connected: false,
          mailbox: null
        }),
        buildGoogleAuthUrl: () => ({ url: 'https://accounts.google.com/' }),
        completeGmailOAuth: async () => ({ success: true }),
        renderOAuthResultPage: () => '<html></html>'
      };
    }
    if (request === './parallel-runner') {
      class ParallelPuppeteerRunner {}
      ParallelPuppeteerRunner.clampParallelism = value => Number.parseInt(value, 10) || 3;
      return ParallelPuppeteerRunner;
    }
    throw new Error(`Unexpected dependency: ${request}`);
  };

  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  vm.runInNewContext(source, {
    __dirname: root,
    console,
    require: requireImpl
  }, { filename: 'server.js' });

  return {
    getStoredUsers: () => JSON.parse(storedUsers),
    routes
  };
}

function createResponse() {
  return {
    body: null,
    statusCode: 200,
    json(body) {
      this.body = body;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    }
  };
}

test('server deletes exactly the requested user from the latest stored list', () => {
  const harness = loadServerWithUsers([
    { testName: 'first' },
    { testName: 'second' },
    { testName: 'third' }
  ]);
  const handler = harness.routes.get('DELETE /api/users/:index');

  assert.equal(typeof handler, 'function');
  const response = createResponse();
  handler({ params: { index: '1' } }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body)), {
    success: true,
    deletedUser: { testName: 'second' }
  });
  assert.deepEqual(harness.getStoredUsers(), [
    { testName: 'first' },
    { testName: 'third' }
  ]);
});

test('server rejects an out-of-range user index without changing storage', () => {
  const original = [{ testName: 'only' }];
  const harness = loadServerWithUsers(original);
  const handler = harness.routes.get('DELETE /api/users/:index');

  assert.equal(typeof handler, 'function');
  const response = createResponse();
  handler({ params: { index: '5' } }, response);

  assert.equal(response.statusCode, 404);
  assert.match(response.body.error, /不存在/);
  assert.deepEqual(harness.getStoredUsers(), original);
});

test('server discards the removed cloud-account property when saving users', () => {
  const harness = loadServerWithUsers([]);
  const handler = harness.routes.get('POST /api/users');
  const response = createResponse();

  handler({
    body: [{
      testName: 'test_user_5',
      testCompany: 'CloudNine-Research',
      testEmail: 'redacted@example.test',
      testUsername: 'redacted',
      testDOB: '1995-02-19',
      testPassword: 'redacted',
      testCloudAccount: 'obsolete-value'
    }]
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(harness.getStoredUsers(), [{
    testName: 'test_user_5',
    testCompany: 'CloudNine-Research',
    testEmail: 'redacted@example.test',
    testUsername: 'redacted',
    testDOB: '1995-02-19',
    testPassword: 'redacted'
  }]);
});
