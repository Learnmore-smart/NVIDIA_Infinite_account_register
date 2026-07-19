const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findEdgeExecutable,
  findChromeExecutable,
  findChromeProfile,
  createEdgeLaunchOptions,
  createEdgeExtensionSetupOptions,
  createChromeTargetLaunchOptions,
  resetChromeAutomationProfile,
  syncEdgeExtensionProfile,
  syncChromeExtensionProfile
} = require('../edge-launch');

test('creates launch options for local Edge in InPrivate mode', () => {
  const env = {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
  };
  const installedPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDataDir = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\Edge\\User Data';
  const localStatePath = `${userDataDir}\\Local State`;
  const existingPaths = new Set([installedPath, userDataDir, localStatePath]);
  const existsSync = candidate => existingPaths.has(candidate);
  const readFileSync = candidate => {
    assert.equal(candidate, localStatePath);
    return JSON.stringify({ profile: { last_used: 'Profile 1' } });
  };

  const workspaceDir = 'D:\\automation';
  const extensionPaths = ['D:\\automation\\.edge_automation_user_data\\Profile 1\\Extensions\\tamper\\1.0'];
  const options = createEdgeLaunchOptions({
    env,
    existsSync,
    readFileSync,
    workspaceDir,
    extensionPaths
  });

  assert.equal(options.executablePath, installedPath);
  assert.equal(options.headless, false);
  assert.equal(options.defaultViewport, null);
  assert.ok(options.args.includes('--inprivate'));
  assert.ok(options.args.includes('--start-maximized'));
  assert.equal(options.userDataDir, 'D:\\automation\\.edge_automation_user_data');
  assert.ok(options.args.includes('--profile-directory=Profile 1'));
  assert.ok(options.ignoreDefaultArgs.includes('--disable-extensions'));
  assert.ok(options.args.includes(`--load-extension=${extensionPaths[0]}`));
});

test('creates normal local Chrome target options on a project-only profile', () => {
  const env = {
    PROGRAMFILES: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
  };
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const existsSync = candidate => candidate === chromePath;
  const extensionPaths = ['D:\\automation\\tampermonkey'];

  const options = createChromeTargetLaunchOptions({
    env,
    existsSync,
    workspaceDir: 'D:\\automation',
    extensionPaths
  });

  assert.equal(findChromeExecutable({ env, existsSync }), chromePath);
  assert.equal(options.executablePath, chromePath);
  assert.equal(options.userDataDir, 'D:\\automation\\.chrome_automation_user_data');
  assert.equal(options.args.includes('--inprivate'), false);
  assert.equal(options.args.includes('--incognito'), false);
  assert.equal(options.args.includes('--start-minimized'), false);
  assert.equal(options.args.includes('--start-maximized'), false);
  assert.ok(options.args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(options.args.includes('--disable-renderer-backgrounding'));
  assert.ok(options.args.includes('--disable-background-timer-throttling'));
  assert.ok(options.args.includes(`--load-extension=${extensionPaths[0]}`));
  assert.ok(options.ignoreDefaultArgs.includes('--disable-extensions'));
});

test('finds the last-used local Chrome profile', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };
  const userDataDir = 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data';
  const localStatePath = `${userDataDir}\\Local State`;

  assert.deepEqual(findChromeProfile({
    env,
    existsSync: candidate => [userDataDir, localStatePath].includes(candidate),
    readFileSync: () => JSON.stringify({ profile: { last_used: 'Profile 2' } })
  }), {
    userDataDir,
    profileDirectory: 'Profile 2'
  });
});

test('copies Chrome extension state without browsing or login data', () => {
  const copied = [];
  const made = [];
  const fakeFs = {
    existsSync: () => true,
    mkdirSync: target => made.push(target),
    copyFileSync: (source, target) => copied.push([source, target]),
    cpSync: (source, target) => copied.push([source, target]),
    readdirSync: source => source.endsWith('dhdgffkkebhmkfjojejmpbldmpobfkfo')
      ? [{ name: '5.5.0_0', isDirectory: () => true }]
      : []
  };

  const extensionPath = syncChromeExtensionProfile({
    sourceUserDataDir: 'C:\\ChromeData',
    sourceProfileDirectory: 'Default',
    targetUserDataDir: 'D:\\automation\\.chrome_automation_user_data',
    fsImpl: fakeFs
  });

  const copiedSources = copied.map(([source]) => source);
  assert.ok(copiedSources.some(source => source.endsWith('Local State')));
  assert.ok(copiedSources.some(source => source.endsWith('Default\\Preferences')));
  assert.ok(copiedSources.some(source => source.endsWith('Default\\Secure Preferences')));
  assert.ok(copiedSources.some(source => source.endsWith('Extensions')));
  assert.ok(copiedSources.some(source => source.endsWith('Local Extension Settings')));
  assert.equal(copiedSources.some(source => /Cookies|History|Sessions|Login Data/.test(source)), false);
  assert.ok(made.length > 0);
  assert.equal(
    extensionPath,
    'D:\\automation\\.chrome_automation_user_data\\Default\\Extensions\\dhdgffkkebhmkfjojejmpbldmpobfkfo\\5.5.0_0'
  );
});

test('resets only the project Chrome automation profile', () => {
  const removed = [];
  const target = resetChromeAutomationProfile({
    workspaceDir: 'D:\\automation',
    fsImpl: {
      rmSync: (pathToRemove, options) => removed.push([pathToRemove, options])
    }
  });

  assert.equal(target, 'D:\\automation\\.chrome_automation_user_data');
  assert.deepEqual(removed, [[target, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 200
  }]]);
});

test('uses distinct project-owned profile paths for concurrent Chrome sessions', () => {
  const env = { PROGRAMFILES: 'C:\\Program Files' };
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const existsSync = candidate => candidate === chromePath;
  const firstDir = 'D:\\automation\\.chrome_automation_profiles\\run-1\\worker-1';
  const secondDir = 'D:\\automation\\.chrome_automation_profiles\\run-1\\worker-2';

  const first = createChromeTargetLaunchOptions({
    env,
    existsSync,
    workspaceDir: 'D:\\automation',
    targetUserDataDir: firstDir
  });
  const second = createChromeTargetLaunchOptions({
    env,
    existsSync,
    workspaceDir: 'D:\\automation',
    targetUserDataDir: secondDir
  });

  assert.equal(first.userDataDir, firstDir);
  assert.equal(second.userDataDir, secondDir);
  assert.notEqual(first.userDataDir, second.userDataDir);
});

test('cleans only validated children of the isolated Chrome profile root', () => {
  const removed = [];
  const targetUserDataDir = 'D:\\automation\\.chrome_automation_profiles\\run-1\\worker-3';
  const target = resetChromeAutomationProfile({
    workspaceDir: 'D:\\automation',
    targetUserDataDir,
    fsImpl: { rmSync: candidate => removed.push(candidate) }
  });

  assert.equal(target, targetUserDataDir);
  assert.deepEqual(removed, [targetUserDataDir]);
  assert.throws(() => resetChromeAutomationProfile({
    workspaceDir: 'D:\\automation',
    targetUserDataDir: 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data',
    fsImpl: { rmSync() {} }
  }), /Unsafe Chrome automation profile path/);
  assert.throws(() => resetChromeAutomationProfile({
    workspaceDir: 'D:\\automation',
    targetUserDataDir: 'D:\\automation\\.chrome_automation_profiles',
    fsImpl: { rmSync() {} }
  }), /Unsafe Chrome automation profile path/);
});

test('creates a normal setup window on the target profile for extension authorization', () => {
  const env = {
    PROGRAMFILES: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
  };
  const installedPath = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDataDir = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\Edge\\User Data';
  const localStatePath = `${userDataDir}\\Local State`;
  const existsSync = candidate => [installedPath, userDataDir, localStatePath].includes(candidate);
  const extensionPaths = ['D:\\automation\\tampermonkey'];

  const options = createEdgeExtensionSetupOptions({
    env,
    existsSync,
    readFileSync: () => JSON.stringify({ profile: { last_used: 'Profile 1' } }),
    workspaceDir: 'D:\\automation',
    extensionPaths
  });

  assert.equal(options.userDataDir, 'D:\\automation\\.edge_automation_user_data');
  assert.equal(options.args.includes('--inprivate'), false);
  assert.ok(options.args.includes(`--load-extension=${extensionPaths[0]}`));
  assert.ok(options.ignoreDefaultArgs.includes('--disable-extensions'));
});

test('syncs extension state without copying browsing or login data', () => {
  const copied = [];
  const made = [];
  const directory = name => ({ name, isDirectory: () => true });
  const fakeFs = {
    existsSync: () => true,
    mkdirSync: target => made.push(target),
    copyFileSync: (source, target) => copied.push([source, target]),
    cpSync: (source, target) => copied.push([source, target]),
    readFileSync: source => {
      assert.ok(source.endsWith('Secure Preferences'));
      return JSON.stringify({
        extensions: {
          settings: {
            dhdgffkkebhmkfjojejmpbldmpobfkfo: { incognito: false, location: 1 },
            anotherAllowed: { incognito: true, location: 1 },
            normalOnly: { incognito: false, location: 1 },
            edgeInternal: { incognito: true, location: 10 }
          }
        }
      });
    },
    readdirSync: source => {
      if (source.endsWith('Extensions')) {
        return [
          directory('dhdgffkkebhmkfjojejmpbldmpobfkfo'),
          directory('anotherAllowed'),
          directory('normalOnly'),
          directory('edgeInternal')
        ];
      }
      return [directory('1.0_0')];
    }
  };

  const extensionPaths = syncEdgeExtensionProfile({
    sourceUserDataDir: 'C:\\EdgeData',
    sourceProfileDirectory: 'Profile 1',
    targetUserDataDir: 'D:\\automation\\.edge_automation_user_data',
    fsImpl: fakeFs
  });

  const copiedSources = copied.map(([source]) => source);
  assert.ok(copiedSources.some(source => source.endsWith('Local State')));
  assert.ok(copiedSources.some(source => source.endsWith('Secure Preferences')));
  assert.ok(copiedSources.some(source => source.endsWith('Extensions')));
  assert.equal(copiedSources.some(source => /Cookies|History|Sessions/.test(source)), false);
  assert.ok(made.length > 0);
  assert.deepEqual(extensionPaths, [
    'D:\\automation\\.edge_automation_user_data\\Profile 1\\Extensions\\dhdgffkkebhmkfjojejmpbldmpobfkfo\\1.0_0'
  ]);
});

test('throws a clear error when Microsoft Edge is not installed', () => {
  assert.throws(
    () => findEdgeExecutable({ env: {}, existsSync: () => false }),
    /Microsoft Edge.*not found/i
  );
});
