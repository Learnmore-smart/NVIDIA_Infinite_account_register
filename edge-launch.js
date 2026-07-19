const fs = require('fs');
const path = require('path');

const TAMPERMONKEY_EXTENSION_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

function getEdgeCandidates(env) {
  return [
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.LOCALAPPDATA
  ]
    .filter(Boolean)
    .map(basePath => path.win32.join(basePath, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
}

function getChromeCandidates(env) {
  return [
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.LOCALAPPDATA
  ]
    .filter(Boolean)
    .map(basePath => path.win32.join(basePath, 'Google', 'Chrome', 'Application', 'chrome.exe'));
}

function findEdgeExecutable({ env = process.env, existsSync = fs.existsSync } = {}) {
  const edgePath = getEdgeCandidates(env).find(existsSync);
  if (!edgePath) {
    throw new Error('Microsoft Edge was not found in the standard Windows installation locations.');
  }
  return edgePath;
}

function findChromeExecutable({ env = process.env, existsSync = fs.existsSync } = {}) {
  const chromePath = getChromeCandidates(env).find(existsSync);
  if (!chromePath) {
    throw new Error('Google Chrome was not found in the standard Windows installation locations.');
  }
  return chromePath;
}

function findChromeProfile({
  env = process.env,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  if (!env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is unavailable, so the Google Chrome profile cannot be located.');
  }

  const userDataDir = path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  const localStatePath = path.win32.join(userDataDir, 'Local State');
  if (!existsSync(userDataDir) || !existsSync(localStatePath)) {
    throw new Error('Google Chrome user profile data was not found. Open Chrome once and try again.');
  }

  let localState;
  try {
    localState = JSON.parse(readFileSync(localStatePath, 'utf8'));
  } catch (error) {
    throw new Error(`Google Chrome profile metadata could not be read: ${error.message}`);
  }

  const profileDirectory = localState.profile?.last_used || 'Default';
  if (path.win32.basename(profileDirectory) !== profileDirectory) {
    throw new Error('Google Chrome returned an invalid profile directory.');
  }

  return { userDataDir, profileDirectory };
}

function findEdgeProfile({
  env = process.env,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  if (!env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is unavailable, so the Microsoft Edge profile cannot be located.');
  }

  const userDataDir = path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
  const localStatePath = path.win32.join(userDataDir, 'Local State');
  if (!existsSync(userDataDir) || !existsSync(localStatePath)) {
    throw new Error('Microsoft Edge user profile data was not found. Open Edge once and try again.');
  }

  let localState;
  try {
    localState = JSON.parse(readFileSync(localStatePath, 'utf8'));
  } catch (error) {
    throw new Error(`Microsoft Edge profile metadata could not be read: ${error.message}`);
  }

  const profileDirectory = localState.profile?.last_used || 'Default';
  if (path.win32.basename(profileDirectory) !== profileDirectory) {
    throw new Error('Microsoft Edge returned an invalid profile directory.');
  }

  return { userDataDir, profileDirectory };
}

function syncEdgeExtensionProfile({
  sourceUserDataDir,
  sourceProfileDirectory,
  targetUserDataDir,
  fsImpl = fs
}) {
  const targetProfileDir = path.win32.join(targetUserDataDir, sourceProfileDirectory);
  const sourceProfileDir = path.win32.join(sourceUserDataDir, sourceProfileDirectory);
  fsImpl.mkdirSync(targetUserDataDir, { recursive: true });
  fsImpl.mkdirSync(targetProfileDir, { recursive: true });

  const copyFileIfPresent = (relativeSource, relativeTarget = relativeSource) => {
    const source = path.win32.join(sourceUserDataDir, relativeSource);
    if (!fsImpl.existsSync(source)) return;
    const target = path.win32.join(targetUserDataDir, relativeTarget);
    fsImpl.mkdirSync(path.win32.dirname(target), { recursive: true });
    fsImpl.copyFileSync(source, target);
  };
  const copyDirectoryIfPresent = relativePath => {
    const source = path.win32.join(sourceProfileDir, relativePath);
    if (!fsImpl.existsSync(source)) return;
    const target = path.win32.join(targetProfileDir, relativePath);
    fsImpl.cpSync(source, target, { recursive: true, force: true });
  };

  copyFileIfPresent('Local State');
  for (const fileName of ['Preferences', 'Secure Preferences']) {
    const relativePath = path.win32.join(sourceProfileDirectory, fileName);
    copyFileIfPresent(relativePath);
  }
  for (const directoryName of [
    'Extensions',
    'Extension Rules',
    'Extension Scripts',
    'Extension State',
    'Local Extension Settings',
    'Sync Extension Settings'
  ]) {
    copyDirectoryIfPresent(directoryName);
  }

  const extensionsRoot = path.win32.join(targetProfileDir, 'Extensions');
  if (!fsImpl.existsSync(extensionsRoot) || typeof fsImpl.readdirSync !== 'function') {
    return [];
  }
  const securePreferencesPath = path.win32.join(targetProfileDir, 'Secure Preferences');
  let extensionSettings = {};
  try {
    const securePreferences = JSON.parse(fsImpl.readFileSync(securePreferencesPath, 'utf8'));
    extensionSettings = securePreferences.extensions?.settings || {};
  } catch (error) {
    throw new Error(`Edge extension permissions could not be read: ${error.message}`);
  }
  return fsImpl.readdirSync(extensionsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => {
      const settings = extensionSettings[entry.name];
      return entry.name === TAMPERMONKEY_EXTENSION_ID
        && settings?.location === 1;
    })
    .flatMap(extensionEntry => {
      const extensionRoot = path.win32.join(extensionsRoot, extensionEntry.name);
      const versions = fsImpl.readdirSync(extensionRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
        .reverse();
      return versions.length > 0 ? [path.win32.join(extensionRoot, versions[0])] : [];
    });
}

function syncChromeExtensionProfile({
  sourceUserDataDir,
  sourceProfileDirectory,
  targetUserDataDir,
  fsImpl = fs
}) {
  const sourceProfileDir = path.win32.join(sourceUserDataDir, sourceProfileDirectory);
  const targetProfileDir = path.win32.join(targetUserDataDir, sourceProfileDirectory);
  fsImpl.mkdirSync(targetUserDataDir, { recursive: true });
  fsImpl.mkdirSync(targetProfileDir, { recursive: true });

  const copyFile = (source, target) => {
    if (!fsImpl.existsSync(source)) {
      throw new Error(`Required Chrome extension state was not found: ${source}`);
    }
    fsImpl.mkdirSync(path.win32.dirname(target), { recursive: true });
    fsImpl.copyFileSync(source, target);
  };
  const copyDirectoryIfPresent = relativePath => {
    const source = path.win32.join(sourceProfileDir, relativePath);
    if (!fsImpl.existsSync(source)) return;
    const target = path.win32.join(targetProfileDir, relativePath);
    fsImpl.mkdirSync(path.win32.dirname(target), { recursive: true });
    fsImpl.cpSync(source, target, { recursive: true, force: true });
  };

  copyFile(
    path.win32.join(sourceUserDataDir, 'Local State'),
    path.win32.join(targetUserDataDir, 'Local State')
  );
  for (const fileName of ['Preferences', 'Secure Preferences']) {
    copyFile(
      path.win32.join(sourceProfileDir, fileName),
      path.win32.join(targetProfileDir, fileName)
    );
  }

  for (const directoryName of [
    'Extensions',
    'Extension Rules',
    'Extension Scripts',
    'Extension State',
    'Local Extension Settings',
    'Sync Extension Settings'
  ]) {
    copyDirectoryIfPresent(directoryName);
  }

  const extensionRoot = path.win32.join(
    targetProfileDir,
    'Extensions',
    TAMPERMONKEY_EXTENSION_ID
  );
  if (!fsImpl.existsSync(extensionRoot)) {
    throw new Error(`Tampermonkey is not installed in Chrome profile ${sourceProfileDirectory}.`);
  }
  const versions = fsImpl.readdirSync(extensionRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .reverse();
  if (versions.length === 0) {
    throw new Error(`Tampermonkey has no installed version in Chrome profile ${sourceProfileDirectory}.`);
  }
  return path.win32.join(extensionRoot, versions[0]);
}

function createEdgeLaunchOptions(options = {}) {
  const { profileDirectory } = findEdgeProfile(options);
  const workspaceDir = options.workspaceDir || __dirname;
  const extensionPaths = options.extensionPaths || [];
  const args = [
    '--inprivate',
    `--profile-directory=${profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--start-maximized',
    '--blink-settings=primaryHoverType=2,primaryPointerType=4',
    '--disable-blink-features=AutomationControlled'
  ];
  if (extensionPaths.length > 0) {
    args.push(`--load-extension=${extensionPaths.join(',')}`);
  }
  return {
    executablePath: findEdgeExecutable(options),
    userDataDir: path.win32.join(workspaceDir, '.edge_automation_user_data'),
    headless: false,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    args
  };
}

function createEdgeExtensionSetupOptions(options = {}) {
  const launchOptions = createEdgeLaunchOptions(options);
  launchOptions.args = launchOptions.args.filter(arg => arg !== '--inprivate');
  return launchOptions;
}

function createChromeTargetLaunchOptions(options = {}) {
  const workspaceDir = options.workspaceDir || __dirname;
  const extensionPaths = options.extensionPaths || [];
  const targetUserDataDir = resolveChromeAutomationProfile({
    workspaceDir,
    targetUserDataDir: options.targetUserDataDir
  });
  const args = [
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-dev-shm-usage'
  ];
  if (extensionPaths.length > 0) {
    args.push(`--load-extension=${extensionPaths.join(',')}`);
  }
  return {
    executablePath: findChromeExecutable(options),
    userDataDir: targetUserDataDir,
    headless: false,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    args
  };
}

function resolveChromeAutomationProfile({ workspaceDir = __dirname, targetUserDataDir } = {}) {
  const resolvedWorkspace = path.win32.resolve(workspaceDir);
  const legacyTarget = path.win32.join(resolvedWorkspace, '.chrome_automation_user_data');
  const profilesRoot = path.win32.join(resolvedWorkspace, '.chrome_automation_profiles');
  const resolvedTarget = path.win32.resolve(targetUserDataDir || legacyTarget);
  const relative = path.win32.relative(profilesRoot, resolvedTarget);
  const isLegacyTarget = resolvedTarget.toLowerCase() === legacyTarget.toLowerCase();
  const isIsolatedChild = Boolean(relative)
    && relative !== '.'
    && !relative.startsWith('..')
    && !path.win32.isAbsolute(relative);
  if (!isLegacyTarget && !isIsolatedChild) {
    throw new Error(`Unsafe Chrome automation profile path: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function resetChromeAutomationProfile({ workspaceDir = __dirname, targetUserDataDir, fsImpl = fs } = {}) {
  const resolvedTarget = resolveChromeAutomationProfile({ workspaceDir, targetUserDataDir });
  fsImpl.rmSync(resolvedTarget, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 200
  });
  return resolvedTarget;
}

module.exports = {
  findEdgeExecutable,
  findChromeExecutable,
  findChromeProfile,
  findEdgeProfile,
  syncEdgeExtensionProfile,
  syncChromeExtensionProfile,
  createEdgeLaunchOptions,
  createEdgeExtensionSetupOptions,
  createChromeTargetLaunchOptions,
  resolveChromeAutomationProfile,
  resetChromeAutomationProfile
};
