const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PuppeteerRunner = require('../runner');

test('uses one extended timeout for every human-paced route transition', async () => {
  const manualStepTimeoutMs = 30 * 60 * 1000;
  const observedTimeouts = [];
  const stateHandle = {
    jsonValue: async () => 'api-key',
    dispose: async () => {}
  };
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    manualStepTimeoutMs
  });
  runner.page = {
    url: () => 'https://cloudaccounts.nvidia.com/create',
    waitForFunction: async (_fn, options) => {
      observedTimeouts.push(options.timeout);
      return stateHandle;
    }
  };
  runner.fillStandardInput = async () => {};

  await runner.waitForHumanNavigation('https://before.example', 'manual step');
  await runner.createCloudAccount({ testCompany: 'Test Company' });
  await runner.waitForApiKeyPage();
  await runner.waitForPostAuthenticationState();

  assert.equal(observedTimeouts.length, 5);
  assert.equal(observedTimeouts.every(timeout => timeout === manualStepTimeoutMs), true);
});

test('keeps only successful API keys when loading and exporting results', t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novapura-results-'));
  const resultsFile = path.join(tempDir, 'api_keys_test.md');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(resultsFile, [
    '# Test Automation Results',
    '',
    '| Test Profile Name | API Key (Test) |',
    '|-------------------|----------------|',
    '| test_user_4 | nvapi-success |',
    '| test_user_5 | 处理失败: temporary failure |',
    '| test_user_6 | Error: temporary failure |'
  ].join('\n'), 'utf8');

  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.resultsFile = resultsFile;

  assert.deepEqual(runner.readExistingResults(), [
    { testName: 'test_user_4', apiKey: 'nvapi-success' }
  ]);

  runner.exportResults([
    { testName: 'test_user_4', apiKey: 'nvapi-success' },
    { testName: 'test_user_5', apiKey: '处理失败: temporary failure' }
  ]);

  const exported = fs.readFileSync(resultsFile, 'utf8');
  assert.match(exported, /test_user_4/);
  assert.doesNotMatch(exported, /test_user_5|处理失败|Error:/);
});

test('keeps retrying the same user after ten errors without exporting a failure', async () => {
  let attempts = 0;
  const exportedSnapshots = [];
  const runner = new PuppeteerRunner({
    users: [{ testName: 'test_user_4' }],
    automationConfig: {}
  });
  runner.readExistingResults = () => [];
  runner.exportResults = results => {
    exportedSnapshots.push(results.map(result => ({ ...result })));
  };
  runner.resetTargetProfile = () => {};
  runner.launchTargetBrowser = async () => {
    attempts++;
    if (attempts === 10) runner.stop();
    throw new Error('temporary failure');
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = callback => {
    callback();
    return 0;
  };
  try {
    await runner.run();
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(attempts, 10);
  assert.deepEqual(exportedSnapshots, [[]]);
});

test('targets the editable NVIDIA email input instead of its visible #email wrapper', async () => {
  const expectedEmail = 'a@b.co';
  const wrapper = { tagName: 'DIV', id: 'email' };
  const input = {
    tagName: 'INPUT',
    name: 'email',
    type: 'text',
    value: '',
    dispatchEvent: () => {}
  };
  const resolvesBareEmailId = selector => selector
    .split(',')
    .some(part => part.trim() === '#email');
  const resolveElement = selector => resolvesBareEmailId(selector) ? wrapper : input;
  let focusedElement = null;
  const selectors = [];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    cookieConsentPollIntervalMs: 0,
    cookieConsentMaxAttempts: 3
  });
  runner.page = {
    waitForSelector: async selector => {
      selectors.push(selector);
      return resolveElement(selector);
    },
    evaluate: async (fn, ...args) => {
      global.document = { querySelector: resolveElement };
      global.Event = class Event {};
      try {
        return fn(...args);
      } finally {
        delete global.document;
        delete global.Event;
      }
    },
    focus: async selector => {
      focusedElement = resolveElement(selector);
    },
    keyboard: {
      down: async () => {},
      up: async () => {},
      press: async key => {
        if (key === 'Backspace' && typeof focusedElement?.value === 'string') {
          focusedElement.value = '';
        }
      },
      sendCharacter: async character => {
        if (typeof focusedElement?.value === 'string') {
          focusedElement.value += character;
        }
      }
    }
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = callback => {
    callback();
    return 0;
  };
  try {
    await runner.fillEmailInput(expectedEmail);
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(input.value, expectedEmail);
  assert.equal(focusedElement, input);
  assert.ok(selectors.length > 0);
  assert.equal(selectors.some(resolvesBareEmailId), false);
});

test('waits for both registration password fields instead of typing into the transient login field', async () => {
  const expectedPassword = 'S3cure!Password';
  const transientLoginInput = {
    id: 'mat-input-1',
    type: 'password',
    value: '',
    dispatchEvent: () => {}
  };
  const registrationPassword = {
    id: 'registration_password',
    type: 'password',
    value: '',
    dispatchEvent: () => {}
  };
  const registrationConfirmation = {
    id: 'registration_passwordConfirm',
    type: 'password',
    value: '',
    dispatchEvent: () => {}
  };
  const resolveElement = selector => {
    if (selector.includes('registration_passwordConfirm') || selector.includes('confirmPassword')) {
      return registrationConfirmation;
    }
    if (selector.includes('registration_password') || selector.includes('formcontrolname="password"')) {
      return registrationPassword;
    }
    return transientLoginInput;
  };
  const events = [];
  let focusedElement = null;
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    waitForSelector: async selector => {
      events.push(`wait:${selector}`);
      return resolveElement(selector);
    },
    evaluate: async (fn, ...args) => {
      global.document = { querySelector: resolveElement };
      global.Event = class Event {};
      try {
        return fn(...args);
      } finally {
        delete global.document;
        delete global.Event;
      }
    },
    focus: async selector => {
      focusedElement = resolveElement(selector);
      events.push(`focus:${focusedElement.id}`);
    },
    keyboard: {
      down: async () => {},
      up: async () => {},
      press: async key => {
        if (key === 'Backspace') focusedElement.value = '';
      },
      sendCharacter: async character => {
        focusedElement.value += character;
      }
    }
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = callback => {
    callback();
    return 0;
  };
  try {
    await runner.fillRegistrationPasswords(expectedPassword);
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(transientLoginInput.value, '');
  assert.equal(registrationPassword.value, expectedPassword);
  assert.equal(registrationConfirmation.value, expectedPassword);
  assert.equal(events.some(event => event === 'wait:input[type="password"]'), false);
  assert.ok(events.findIndex(event => event.includes('registration_passwordConfirm'))
    < events.findIndex(event => event === 'focus:registration_password'));
});

test('fills the stable existing-account password page without using the transient identifier route', async () => {
  const loginPassword = {
    type: 'password',
    value: '',
    getBoundingClientRect: () => ({ width: 320, height: 40 })
  };
  const withLoginDom = fn => {
    global.location = { pathname: '/v1/login/password' };
    global.document = {
      querySelector: selector => selector === 'input[type="password"]' ? loginPassword : null
    };
    global.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
    };
    try {
      return fn();
    } finally {
      delete global.location;
      delete global.document;
      delete global.window;
    }
  };
  const fills = [];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.fillStandardInput = async (selector, value) => fills.push({ selector, value });
  runner.page = {
    waitForFunction: async fn => {
      assert.equal(withLoginDom(fn), true);
    },
    evaluate: async fn => withLoginDom(fn)
  };

  assert.equal(await runner.fillAccountPassword('Existing!Password'), 'login');
  assert.deepEqual(fills, [{ selector: 'input[type="password"]', value: 'Existing!Password' }]);
});

test('existing-account authentication fills the password and automatically submits Login', async () => {
  const events = [];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {}
  });
  runner.fillAccountPassword = async () => {
    events.push('fill-login-password');
    return 'login';
  };
  runner.page = { url: () => 'https://login.nvidia.com/v1/login/password' };
  runner.waitForAccountNavigationAfterCaptcha = async (_url, user) => {
    events.push(`submit-visible:${user.testName}`);
  };
  runner.waitForHumanNavigation = async () => { throw new Error('login must not wait for a human click'); };
  runner.fillRegistrationPasswords = async () => { throw new Error('registration fields must not be used'); };
  runner.waitForManualVerificationCompletion = async () => { throw new Error('email-code wait must not run'); };

  assert.equal(await runner.authenticateAccount({
    testName: 'test_user_5',
    testPassword: 'Existing!Password'
  }), 'login');
  assert.deepEqual(events, [
    'fill-login-password',
    'submit-visible:test_user_5'
  ]);
});

test('registration clicks Create Account initially and again after captcha resolves', async () => {
  const events = [];
  let waitCall = 0;
  const captchaStateHandle = {
    jsonValue: async () => 'captcha',
    dispose: async () => { events.push('dispose-state'); }
  };
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    manualStepTimeoutMs: 12345
  });
  runner.page = {
    waitForFunction: async (_fn, options) => {
      events.push(`wait:${options.timeout}`);
      waitCall++;
      return waitCall === 1 ? captchaStateHandle : undefined;
    }
  };
  runner.handleCaptchaIntervention = async user => {
    events.push(`captcha:${user.testName}`);
  };
  runner.submitVisibleAccountAction = async () => {
    events.push('submit-visible');
    return true;
  };

  assert.equal(await runner.waitForAccountNavigationAfterCaptcha(
    'https://login.nvidia.com/v1/create-account',
    { testName: 'test_user_7' }
  ), true);
  assert.deepEqual(events, [
    'submit-visible',
    'wait:12345',
    'dispose-state',
    'captcha:test_user_7',
    'submit-visible',
    'wait:12345'
  ]);
});

test('registration submission clicks the sole visible Create Account action by text', async () => {
  let clickCount = 0;
  const visibleElement = extra => ({
    getBoundingClientRect: () => ({ width: 320, height: 40 }),
    ...extra
  });
  const createAccount = visibleElement({
    textContent: 'Create Account',
    disabled: false,
    getAttribute: () => null,
    click: () => { clickCount++; }
  });
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    evaluate: async fn => {
      global.document = {
        querySelectorAll: () => [createAccount]
      };
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
      };
      try {
        return fn();
      } finally {
        delete global.document;
        delete global.window;
      }
    }
  };

  assert.equal(await runner.submitVisibleAccountAction(), true);
  assert.equal(clickCount, 1);
});

test('existing-account submission clicks the sole visible Login action', async () => {
  let loginClicks = 0;
  const visibleElement = extra => ({
    getBoundingClientRect: () => ({ width: 320, height: 40 }),
    ...extra
  });
  const login = visibleElement({
    textContent: '登录客户端',
    disabled: false,
    getAttribute: () => null,
    click: () => { loginClicks++; }
  });
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    evaluate: async fn => {
      global.document = {
        querySelectorAll: () => [login]
      };
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
      };
      try {
        return fn();
      } finally {
        delete global.document;
        delete global.window;
      }
    }
  };

  assert.equal(await runner.submitVisibleAccountAction(), true);
  assert.equal(loginClicks, 1);
});

test('waits for the self-refresh to settle before typing into the current email input', async () => {
  const expectedEmail = 'a@b.co';
  const controlledInput = (initialValue = '') => {
    let domValue = initialValue;
    let frameworkValue = initialValue;
    return {
      type: 'email',
      get value() { return domValue; },
      set value(nextValue) { domValue = nextValue; },
      dispatchEvent: () => {},
      restoreFrameworkValue: () => { domValue = frameworkValue; },
      applyKeyboardValue: nextValue => {
        domValue = nextValue;
        frameworkValue = nextValue;
      }
    };
  };
  let currentInput = controlledInput();
  let focusCount = 0;
  let sentCharacterCount = 0;
  let controlDown = false;
  let allSelected = false;
  let pageSettled = false;
  let refreshTriggered = false;
  const delays = [];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    waitForSelector: async () => currentInput,
    evaluate: async (fn, ...args) => {
      global.document = { querySelector: () => currentInput };
      global.Event = class Event {
        constructor(type, options) {
          this.type = type;
          this.bubbles = options?.bubbles;
        }
      };
      try {
        return fn(...args);
      } finally {
        delete global.document;
        delete global.Event;
      }
    },
    focus: async () => {
      focusCount++;
      currentInput.restoreFrameworkValue();
    },
    keyboard: {
      down: async key => { controlDown = key === 'Control'; },
      up: async key => {
        if (key === 'Control') controlDown = false;
      },
      press: async key => {
        if (key === 'A' && controlDown) allSelected = true;
        if (key === 'Backspace' && allSelected) {
          currentInput.applyKeyboardValue('');
          allSelected = false;
        }
      },
      sendCharacter: async character => {
        sentCharacterCount++;
        currentInput.applyKeyboardValue(currentInput.value + character);
      }
    }
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay) => {
    delays.push(delay);
    if (delay === 4000) {
      pageSettled = true;
    } else if (!pageSettled && !refreshTriggered && delay >= 60 && delay <= 180) {
      refreshTriggered = true;
      currentInput = controlledInput();
    }
    callback();
    return 0;
  };
  try {
    await runner.fillStandardInput('input[type="email"]', expectedEmail, {
      stabilityDelayMs: 4000,
      maxAttempts: 2
    });
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(currentInput.value, expectedEmail);
  assert.equal(delays.filter(delay => delay === 4000).length, 1);
  assert.equal(focusCount, 1);
  assert.equal(sentCharacterCount, expectedEmail.length);
});

test('allows only one clean retype when the exact input value never matches', async () => {
  const input = { type: 'email', value: '', dispatchEvent: () => {} };
  let focusCount = 0;
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    waitForSelector: async () => input,
    evaluate: async (fn, ...args) => {
      global.document = { querySelector: () => input };
      global.Event = class Event {};
      try {
        return fn(...args);
      } finally {
        delete global.document;
        delete global.Event;
      }
    },
    focus: async () => { focusCount++; },
    keyboard: {
      down: async () => {},
      up: async () => {},
      press: async key => {
        if (key === 'Backspace') input.value = '';
      },
      sendCharacter: async () => { input.value = 'wrong'; }
    }
  };

  await assert.rejects(
    () => runner.fillStandardInput('input[type="email"]', 'x', {
      stabilityDelayMs: 0,
      maxAttempts: 2
    }),
    /Failed to enter the exact expected value/
  );

  assert.equal(focusCount, 2);
});

test('waits after email entry, verifies the live value, and clicks the identifier Next button', async () => {
  const expectedEmail = 'leah.foster@spinshare.dev';
  const delays = [];
  let clickCount = 0;
  const emailInput = {
    value: expectedEmail,
    closest: selector => selector === 'form' ? form : null
  };
  const nextButton = {
    disabled: false,
    getAttribute: name => name === 'aria-disabled' ? 'false' : null,
    getBoundingClientRect: () => ({ width: 120, height: 40 }),
    click: () => { clickCount++; }
  };
  const form = {
    querySelectorAll: () => [nextButton]
  };
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    evaluate: async (fn, ...args) => {
      global.document = {
        querySelector: () => emailInput,
        querySelectorAll: () => []
      };
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
      };
      try {
        return fn(...args);
      } finally {
        delete global.document;
        delete global.window;
      }
    }
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay) => {
    delays.push(delay);
    callback();
    return 0;
  };
  try {
    await runner.clickEmailNextAfterVerification(expectedEmail);
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(delays, [3000]);
  assert.equal(clickCount, 1);
});

test('does not click identifier Next when the live email no longer matches', async () => {
  let clickCount = 0;
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    evaluate: async (fn, ...args) => {
      global.document = {
        querySelector: () => ({
          value: 'truncated@spinshare.dev',
          closest: () => ({
            querySelectorAll: () => [{
              disabled: false,
              getAttribute: () => null,
              getBoundingClientRect: () => ({ width: 120, height: 40 }),
              click: () => { clickCount++; }
            }]
          })
        }),
        querySelectorAll: () => []
      };
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
      };
      try {
        return fn(...args);
      } finally {
        delete global.document;
        delete global.window;
      }
    }
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = callback => {
    callback();
    return 0;
  };
  try {
    await assert.rejects(
      () => runner.clickEmailNextAfterVerification('leah.foster@spinshare.dev'),
      /email changed before Next/
    );
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(clickCount, 0);
});

test('waits for delayed cookie consent and clicks Reject Optional before fallback choices', async () => {
  let evaluateCount = 0;
  let preferredClicks = 0;
  let fallbackClicks = 0;
  const control = (textContent, onClick) => ({
    disabled: false,
    textContent,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 140, height: 40 }),
    click: onClick
  });
  const rejectAll = control('Reject All', () => { fallbackClicks++; });
  const rejectOptional = control('Reject Optional', () => { preferredClicks++; });
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    cookieConsentPollIntervalMs: 0,
    cookieConsentMaxAttempts: 3
  });
  runner.page = {
    evaluate: async fn => {
      evaluateCount++;
      global.document = {
        querySelectorAll: () => evaluateCount === 1 ? [] : [rejectAll, rejectOptional]
      };
      global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
      try {
        return fn();
      } finally {
        delete global.document;
        delete global.window;
      }
    }
  };

  assert.equal(await runner.dismissCookieBanner(), true);
  assert.equal(evaluateCount, 2);
  assert.equal(preferredClicks, 1);
  assert.equal(fallbackClicks, 0);
});

test('waits for email verification to be completed on the target page', async () => {
  const states = [];
  const visibility = [true, false, true, false, false];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    verificationPollIntervalMs: 0,
    onVerificationCodeRequired: state => states.push(state)
  });
  runner.page = {
    waitForSelector: async () => ({}),
    evaluate: async () => visibility.shift() ?? false
  };
  runner.setVerificationCodeBanner = async () => {};

  await runner.waitForManualVerificationCompletion({ testName: 'test_user_4' });

  assert.equal(visibility.length, 0);
  assert.deepEqual(states.map(state => state.status), ['waiting', 'resolved']);
  assert.equal(states[0].user, 'test_user_4');
});

test('keeps waiting while a disabled verification input is still visible', async () => {
  const pageStates = ['disabled-visible', 'disabled-visible', 'missing', 'missing'];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    verificationPollIntervalMs: 0
  });
  runner.page = {
    waitForSelector: async () => ({}),
    evaluate: async (fn, selector) => {
      const state = pageStates.shift();
      const input = state === 'missing' ? null : {
        disabled: true,
        getBoundingClientRect: () => ({ width: 180, height: 40 })
      };
      global.document = { querySelector: candidate => candidate === selector ? input : null };
      global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
      try {
        return fn(selector);
      } finally {
        delete global.document;
        delete global.window;
      }
    }
  };
  runner.setVerificationCodeBanner = async () => {};

  await runner.waitForManualVerificationCompletion({ testName: 'test_user_4' });

  assert.equal(pageStates.length, 0);
});

test('continues after target-page navigation destroys the old verification context', async () => {
  const checks = [
    new Error('Execution context was destroyed, most likely because of a navigation.'),
    false
  ];
  const states = [];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    verificationPollIntervalMs: 0,
    onVerificationCodeRequired: state => states.push(state)
  });
  runner.page = {
    waitForSelector: async () => ({}),
    evaluate: async () => {
      const check = checks.shift();
      if (check instanceof Error) throw check;
      return check;
    }
  };
  runner.setVerificationCodeBanner = async () => {};

  await runner.waitForManualVerificationCompletion({ testName: 'test_user_4' });

  assert.equal(checks.length, 0);
  assert.deepEqual(states.map(state => state.status), ['waiting', 'resolved']);
});

test('leaves developer consent controls to the human and waits for navigation', async () => {
  const consentUrl = 'https://static-login.nvidia.com/service/default/noir/consent/developer/v1-1';
  const waits = [];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = { url: () => consentUrl };
  runner.waitForHumanNavigation = async (url, step) => waits.push({ url, step });

  await runner.waitForDeveloperConsentCompletion();
  assert.equal(waits.length, 1);
  assert.equal(waits[0].url, consentUrl);
  assert.match(waits[0].step, /人工/);
});

test('fills the exact NVIDIA account-name field and leaves creation to the human', async () => {
  let waitCalls = 0;
  const cloudUrl = 'https://cloudaccounts.nvidia.com/sf/v2/select-account';
  const input = {
    getBoundingClientRect: () => ({ width: 452, height: 30 })
  };
  const withCloudAccountDom = fn => {
    global.location = {
      href: cloudUrl,
      hostname: 'cloudaccounts.nvidia.com',
      pathname: '/sf/v2/select-account'
    };
    global.document = {
      querySelector: selector => selector === 'input[name="name"]' ? input : null
    };
    global.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
    };
    try {
      return fn();
    } finally {
      delete global.location;
      delete global.document;
      delete global.window;
    }
  };
  const fills = [];
  const humanWaits = [];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.fillStandardInput = async (selector, value) => fills.push({ selector, value });
  runner.waitForHumanNavigation = async (url, step) => {
    humanWaits.push({ url, step });
    return true;
  };
  runner.page = {
    url: () => cloudUrl,
    waitForFunction: async (fn, _options, ...args) => {
      waitCalls++;
      if (waitCalls === 1) {
        assert.equal(withCloudAccountDom(fn), true);
        return;
      }
    },
    evaluate: async fn => withCloudAccountDom(fn)
  };

  assert.equal(await runner.createCloudAccount({
    testCompany: 'CloudNine-Research',
    testCloudAccount: 'obsolete-value'
  }), true);
  assert.deepEqual(fills, [{ selector: 'input[name="name"]', value: 'CloudNine-Research' }]);
  assert.equal(waitCalls, 1);
  assert.equal(humanWaits.length, 1);
  assert.match(humanWaits[0].step, /人工/);
});

test('waits for the authenticated Build API-key page before using the active session', async () => {
  let waitCalls = 0;
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    waitForFunction: async fn => {
      waitCalls++;
      global.location = {
        hostname: 'build.nvidia.com',
        pathname: '/settings/api-keys'
      };
      global.document = { readyState: 'complete' };
      try {
        assert.equal(fn(), true);
      } finally {
        delete global.location;
        delete global.document;
      }
    }
  };

  assert.equal(await runner.waitForApiKeyPage(), true);
  assert.equal(waitCalls, 1);
});

test('recognizes the exact NVIDIA post-authentication routes', async () => {
  const visibleControl = textContent => ({
    textContent,
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 160, height: 40 })
  });
  const routes = [
    {
      hostname: 'login.nvgs.nvidia.com',
      pathname: '/v1/create-passkey',
      bodyText: '创建通行密钥 使用通行密钥保护您的账户。',
      controls: [visibleControl('稍后再说')],
      expected: 'passkey'
    },
    {
      hostname: 'static-login.nvidia.com',
      pathname: '/service/default/noir/consent/developer/v1-1',
      expected: 'developer-consent'
    },
    {
      hostname: 'cloudaccounts.nvidia.com',
      pathname: '/sf/v2/select-account',
      expected: 'cloud-account'
    },
    {
      hostname: 'build.nvidia.com',
      pathname: '/settings/api-keys',
      expected: 'api-key'
    }
  ];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });

  for (const route of routes) {
    runner.page = {
      waitForFunction: async fn => {
        global.location = route;
        global.document = {
          body: { innerText: route.bodyText || '' },
          querySelectorAll: () => route.controls || []
        };
        global.window = {
          getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
        };
        try {
          const value = fn();
          return { jsonValue: async () => value };
        } finally {
          delete global.location;
          delete global.document;
          delete global.window;
        }
      }
    };
    assert.equal(await runner.waitForPostAuthenticationState(), route.expected);
  }
});

test('clicks Later on the passkey prompt and waits for that page to advance', async () => {
  let laterClicks = 0;
  let createClicks = 0;
  const visibleControl = (textContent, click) => ({
    textContent,
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 160, height: 40 }),
    click
  });
  const controls = [
    visibleControl('立即创建', () => { createClicks++; }),
    visibleControl('稍后再说', () => { laterClicks++; })
  ];
  const waits = [];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {}, manualStepTimeoutMs: 12345 });
  runner.page = {
    url: () => 'https://login.nvgs.nvidia.com/v1/create-passkey',
    evaluate: async fn => {
      global.document = { querySelectorAll: () => controls };
      global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
      try {
        return fn();
      } finally {
        delete global.document;
        delete global.window;
      }
    },
    waitForFunction: async (_fn, options, previousUrl) => {
      waits.push({ timeout: options.timeout, previousUrl });
    }
  };

  assert.equal(await runner.skipPasskeyCreation(), true);
  assert.equal(laterClicks, 1);
  assert.equal(createClicks, 0);
  assert.deepEqual(waits, [{
    timeout: 12345,
    previousUrl: 'https://login.nvgs.nvidia.com/v1/create-passkey'
  }]);
});

test('skips passkey creation before human consent and Cloud Account creation', async () => {
  const states = ['passkey', 'developer-consent', 'cloud-account', 'api-key'];
  const events = [];
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.waitForPostAuthenticationState = async () => states.shift();
  runner.skipPasskeyCreation = async () => { events.push('skip-passkey'); };
  runner.waitForDeveloperConsentCompletion = async () => { events.push('wait-human-consent'); };
  runner.createCloudAccount = async user => { events.push(`create-cloud:${user.testCompany}`); };

  assert.equal(await runner.completePostAuthentication({ testCompany: 'CloudNine-Research' }), true);
  assert.deepEqual(events, ['skip-passkey', 'wait-human-consent', 'create-cloud:CloudNine-Research']);
  assert.equal(states.length, 0);
});

function fakePage(url) {
  return {
    currentUrl: url,
    closed: false,
    navigations: [],
    url() {
      return this.currentUrl;
    },
    async close() {
      this.closed = true;
    },
    async goto(nextUrl) {
      this.navigations.push(nextUrl);
      this.currentUrl = nextUrl;
    }
  };
}

test('reuses the original target blank page and closes Tampermonkey changelog tabs', async () => {
  const changelog = fakePage('https://www.tampermonkey.net/changelog.php?version=5.5.0&updated=true');
  const targetBlank = fakePage('about:blank');
  let newPageCalled = false;
  const browser = {
    pages: async () => [changelog, targetBlank],
    newPage: async () => {
      newPageCalled = true;
      return fakePage('about:blank');
    }
  };
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });

  const selected = await runner.selectTargetPage(browser);

  assert.equal(selected, targetBlank);
  assert.equal(changelog.closed, true);
  assert.equal(targetBlank.closed, false);
  assert.equal(newPageCalled, false);
});

test('replaces a sole Tampermonkey changelog tab instead of creating a normal page', async () => {
  const changelog = fakePage('https://www.tampermonkey.net/changelog.php?version=5.5.0&old=5.5.0https://www.tampermonkey.net/changelog.php');
  const browser = {
    pages: async () => [changelog]
  };
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });

  const selected = await runner.selectTargetPage(browser);

  assert.equal(selected, changelog);
  assert.deepEqual(changelog.navigations, ['about:blank']);
  assert.equal(changelog.closed, false);
});

test('resets and seeds the disposable Chrome profile before launching a target browser', async () => {
  let resetCount = 0;
  let synced = false;
  let launchCount = 0;
  const targetBrowser = { marker: 'chrome-target' };
  const targetUserDataDir = 'D:\\automation\\.chrome_automation_profiles\\run-1\\worker-1';
  const resetTargets = [];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    browserLauncher: async options => {
      launchCount++;
      assert.equal(synced, true);
      assert.deepEqual(options, { browser: 'chrome' });
      return targetBrowser;
    },
    workspaceDir: 'D:\\automation',
    targetUserDataDir,
    targetLaunchOptionsFactory: options => {
      assert.equal(options.targetUserDataDir, targetUserDataDir);
      return { browser: 'chrome' };
    },
    chromeProfileFinder: () => ({ userDataDir: 'C:\\ChromeData', profileDirectory: 'Default' }),
    chromeExtensionProfileSync: options => {
      assert.equal(options.sourceUserDataDir, 'C:\\ChromeData');
      assert.equal(options.sourceProfileDirectory, 'Default');
      assert.equal(options.targetUserDataDir, targetUserDataDir);
      synced = true;
    },
    resetTargetProfile: options => {
      resetCount++;
      resetTargets.push(options.targetUserDataDir);
    }
  });

  const browser = await runner.launchTargetBrowser();

  assert.equal(browser, targetBrowser);
  assert.equal(resetCount, 1);
  assert.deepEqual(resetTargets, [targetUserDataDir]);
  assert.equal(launchCount, 1);
});

test('launches the target browser through the foreground-preserving boundary', async () => {
  const targetBrowser = { marker: 'background-chrome' };
  const calls = [];
  const browserLauncher = async () => {
    throw new Error('raw launcher must be wrapped');
  };
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    browserLauncher,
    backgroundBrowserLauncher: async (launcher, options) => {
      calls.push([launcher, options]);
      return targetBrowser;
    },
    targetLaunchOptionsFactory: () => ({ browser: 'chrome' }),
    chromeProfileFinder: () => ({ userDataDir: 'C:\\ChromeData', profileDirectory: 'Default' }),
    chromeExtensionProfileSync: () => {},
    resetTargetProfile: () => {}
  });

  assert.equal(await runner.launchTargetBrowser(), targetBrowser);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], browserLauncher);
  assert.deepEqual(calls[0][1], { browser: 'chrome' });
});

test('labels the initial target-page banner with the current test account', async () => {
  const body = {
    style: {},
    appendChild(element) { this.child = element; }
  };
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    evaluate: async (fn, testName) => {
      global.document = {
        getElementById: () => null,
        createElement: () => ({ style: {} }),
        body
      };
      try {
        fn(testName);
      } finally {
        delete global.document;
      }
    }
  };

  await runner.injectWarningBanner('test_user_8');

  assert.equal(body.child.textContent, '🤖 自动填充：test_user_8（按钮请人工操作）');
});

test('reports a successful child result without writing the shared report', async () => {
  const reported = [];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    persistResults: false,
    onUserSuccess: result => reported.push(result)
  });
  runner.exportResults = () => {
    throw new Error('child runner must not write shared results');
  };

  await runner.recordSuccessfulResult({ testName: 'test_user_8', apiKey: 'nvapi-eight' });

  assert.deepEqual(reported, [{ testName: 'test_user_8', apiKey: 'nvapi-eight' }]);
});

test('resets the disposable Chrome profile again when target launch fails', async () => {
  let resetCount = 0;
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    browserLauncher: async () => { throw new Error('launch failed'); },
    targetLaunchOptionsFactory: () => ({ browser: 'chrome' }),
    chromeProfileFinder: () => ({ userDataDir: 'C:\\ChromeData', profileDirectory: 'Default' }),
    chromeExtensionProfileSync: () => {},
    resetTargetProfile: () => { resetCount++; }
  });

  await assert.rejects(() => runner.launchTargetBrowser(), /launch failed/);
  assert.equal(resetCount, 2);
});

function captchaPage({ tokenPresent }) {
  return {
    $: async selector => selector === 'iframe[src*="hcaptcha"]' ? {} : null,
    evaluate: async (_fn, ...args) => args.length === 0 ? tokenPresent : true
  };
}

test('treats a populated captcha response token as resolved even when its iframe remains', async () => {
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = captchaPage({ tokenPresent: true });

  assert.equal(await runner.detectCaptcha(), null);
});

test('keeps waiting when a visible captcha iframe has no response token', async () => {
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = captchaPage({ tokenPresent: false });

  assert.equal(await runner.detectCaptcha(), 'iframe[src*="hcaptcha"]');
});

test('automatically continues after captcha disappears without a manual click', async () => {
  const states = [];
  const bannerModes = [];
  const detections = ['iframe[src*="hcaptcha"]', null];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    captchaPollIntervalMs: 0,
    onCaptchaRequired: state => states.push(state)
  });
  runner.detectCaptcha = async () => detections.shift();
  runner.setCaptchaBanner = async isIntervention => bannerModes.push(isIntervention);

  await runner.handleCaptchaIntervention({ testName: 'test_user_1' });

  assert.deepEqual(states.map(state => state.status), ['waiting', 'resolved']);
  assert.deepEqual(bannerModes, [true, false]);
});

test('keeps the browser intervention active across a transient hCaptcha disappearance', async () => {
  const states = [];
  const detections = [
    'iframe[src*="hcaptcha"]',
    null,
    'iframe[src*="hcaptcha"]',
    null,
    null
  ];
  let detectionCount = 0;
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    captchaPollIntervalMs: 0,
    onCaptchaRequired: state => states.push(state)
  });
  runner.detectCaptcha = async () => {
    detectionCount++;
    return detections.shift();
  };
  runner.setCaptchaBanner = async () => {};

  await runner.handleCaptchaIntervention({ testName: 'test_user_hcaptcha' });

  assert.equal(detectionCount, 5);
  assert.deepEqual(states.map(state => state.status), ['waiting', 'resolved']);
});

test('manual captcha check immediately rechecks and reports an unresolved challenge', async () => {
  const states = [];
  const detections = ['iframe[src*="hcaptcha"]', 'iframe[src*="hcaptcha"]'];
  const runner = new PuppeteerRunner({
    users: [],
    automationConfig: {},
    captchaPollIntervalMs: 60_000,
    onCaptchaRequired: state => states.push(state)
  });
  runner.detectCaptcha = async () => detections.shift() || 'iframe[src*="hcaptcha"]';
  runner.setCaptchaBanner = async () => {};

  const intervention = runner.handleCaptchaIntervention({ testName: 'test_user_1' });
  await new Promise(resolve => setImmediate(resolve));
  runner.resolveCaptcha();

  for (let attempt = 0; attempt < 10 && states.length < 2; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  runner.stop();
  await intervention;

  assert.equal(states[0].status, 'waiting');
  assert.equal(states[1].status, 'waiting');
  assert.match(states[1].message, /仍未检测到验证结果/);
});

test('changes the target-page banner to request human intervention', async () => {
  const banner = { textContent: '', style: {} };
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    evaluate: async (fn, isIntervention) => {
      global.document = { getElementById: () => banner };
      try {
        return fn(isIntervention);
      } finally {
        delete global.document;
      }
    }
  };

  await runner.setCaptchaBanner(true);

  assert.equal(banner.textContent, '⚠️ 请在本页面完成人机验证');
  assert.equal(banner.style.backgroundColor, '#f59e0b');
  assert.equal(banner.style.color, '#111827');
});

test('restores the account label after captcha intervention resolves', async () => {
  const banner = { textContent: '', style: {} };
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.currentTestName = 'test_user_8';
  runner.page = {
    evaluate: async (fn, isIntervention, testName) => {
      global.document = { getElementById: () => banner };
      try {
        return fn(isIntervention, testName);
      } finally {
        delete global.document;
      }
    }
  };

  await runner.setCaptchaBanner(false);

  assert.equal(banner.textContent, '🤖 自动填充：test_user_8（按钮请人工操作）');
});

test('changes the target-page banner to request a verification code in blue', async () => {
  const banner = { textContent: '', style: {} };
  const runner = new PuppeteerRunner({ users: [], automationConfig: {} });
  runner.page = {
    evaluate: async (fn, isWaiting) => {
      global.document = { getElementById: () => banner };
      try {
        return fn(isWaiting);
      } finally {
        delete global.document;
      }
    }
  };

  await runner.setVerificationCodeBanner(true);

  assert.equal(banner.textContent, '✉️ 请在本页面输入邮箱验证码');
  assert.equal(banner.style.backgroundColor, '#2563eb');
  assert.equal(banner.style.color, '#ffffff');
});
