const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const ResultStore = require('./result-store');
const { launchBrowserInBackground } = require('./windows-focus');
const {
  findChromeProfile,
  syncChromeExtensionProfile,
  createChromeTargetLaunchOptions,
  resetChromeAutomationProfile,
} = require('./edge-launch');
const { createProxySession } = require('./proxy-pool');
const {
  createCaptchaSolver,
  extractCaptchaTaskFromPage,
  injectCaptchaToken
} = require('./captcha-solver');
const { createEmailCodeFetcher } = require('./email-code');

class PuppeteerRunner {
  /**
   * @param {object} params
   * @param {Array} params.users - Test users list
   * @param {object} params.automationConfig - Automation configuration
   * @param {function} params.onLog - Logging callback
   * @param {function} params.onCaptchaRequired - Captcha status callback
   * @param {function} params.onFinished - Finish callback
   */
  constructor({
    users,
    automationConfig = {},
    onLog,
    onCaptchaRequired,
    onVerificationCodeRequired,
    onFinished,
    browserLauncher = puppeteer.launch,
    backgroundBrowserLauncher = launchBrowserInBackground,
    targetLaunchOptionsFactory = createChromeTargetLaunchOptions,
    resetTargetProfile = resetChromeAutomationProfile,
    chromeProfileFinder = findChromeProfile,
    chromeExtensionProfileSync = syncChromeExtensionProfile,
    workspaceDir = __dirname,
    targetUserDataDir,
    persistResults = true,
    onUserSuccess,
    manualStepTimeoutMs = 30 * 60 * 1000,
    captchaPollIntervalMs = 1000,
    verificationPollIntervalMs = 1000,
    cookieConsentPollIntervalMs = 250,
    cookieConsentMaxAttempts = 40,
    captchaSolver,
    emailCodeFetcher,
    proxySessionFactory = createProxySession,
    postCaptchaMaxAttempts = 30,
    postCaptchaRetryMs = 1000,
    postCaptchaNavWaitMs = 2000
  }) {
    this.users = users;
    this.automationConfig = automationConfig;
    this.onLog = onLog || (() => {});
    this.onCaptchaRequired = onCaptchaRequired || (() => {});
    this.onVerificationCodeRequired = onVerificationCodeRequired || (() => {});
    this.onFinished = onFinished || (() => {});
    this.browserLauncher = browserLauncher;
    this.backgroundBrowserLauncher = backgroundBrowserLauncher;
    this.targetLaunchOptionsFactory = targetLaunchOptionsFactory;
    this.resetTargetProfile = resetTargetProfile;
    this.chromeProfileFinder = chromeProfileFinder;
    this.chromeExtensionProfileSync = chromeExtensionProfileSync;
    this.workspaceDir = workspaceDir;
    this.targetUserDataDir = targetUserDataDir || path.join(workspaceDir, '.chrome_automation_user_data');
    this.persistResults = persistResults;
    this.onUserSuccess = onUserSuccess || (() => {});
    this.manualStepTimeoutMs = manualStepTimeoutMs;
    this.captchaPollIntervalMs = captchaPollIntervalMs;
    this.verificationPollIntervalMs = verificationPollIntervalMs;
    this.cookieConsentPollIntervalMs = cookieConsentPollIntervalMs;
    this.cookieConsentMaxAttempts = cookieConsentMaxAttempts;
    // Secrets come from process.env (.env). gmail_config.json only holds non-secret run settings.
    this.captchaSolver = captchaSolver || createCaptchaSolver(automationConfig.captcha || {});
    this.emailCodeFetcher = emailCodeFetcher || createEmailCodeFetcher({
      provider: 'auto',
      ...(automationConfig.email || {})
    });
    this.proxySessionFactory = proxySessionFactory;
    this.postCaptchaMaxAttempts = postCaptchaMaxAttempts;
    this.postCaptchaRetryMs = postCaptchaRetryMs;
    this.postCaptchaNavWaitMs = postCaptchaNavWaitMs;

    this.browser = null;
    this.page = null;
    this.isStopped = false;
    this.captchaResolve = null;
    this.captchaTimer = null;
    this.captchaCheckRequested = false;
    this.currentTestName = '';
    this.currentProxySession = null;
    this.resultsFile = path.join(__dirname, 'api_keys_test.md');
  }

  log(message, type = 'info') {
    this.onLog({
      message,
      type,
      timestamp: new Date().toISOString()
    });
  }

  stop() {
    this.isStopped = true;
    this.log('🛑 收到停止命令，正在中断执行并关闭浏览器...', 'warning');
    this.resolveCaptcha('stopped');
    if (this.browser) {
      try {
        this.browser.close();
      } catch (e) {}
    }
  }

  async prepareCleanUserSession() {
    const client = await this.page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });

    const origins = [
      'https://nvidia.com',
      'https://login.nvidia.com',
      'https://login.nvgs.nvidia.com',
      'https://static-login.nvidia.com',
      'https://cloudaccounts.nvidia.com',
      'https://build.nvidia.com',
      'https://api.ngc.nvidia.com'
    ];
    for (const origin of origins) {
      await client.send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'all'
      });
    }
  }

  async waitForHumanNavigation(previousUrl, step, timeout = this.manualStepTimeoutMs) {
    if (this.isStopped) return false;
    this.log(`🖱️ ${step}；请在目标网页中手动操作。`, 'warning');
    await this.page.waitForFunction(url => location.href !== url, { timeout }, previousUrl);
    if (!this.isStopped) {
      this.log(`✅ 已检测到页面前进：${step}`, 'success');
    }
    return !this.isStopped;
  }

  async submitEmailVerificationCode(code, codeSelector) {
    const typed = await this.page.evaluate((selector, value) => {
      const input = document.querySelector(selector);
      if (!input) return { ok: false, reason: 'input missing' };
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const isVisibleAndEnabled = control => {
        if (!control || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return false;
        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const form = input.closest('form');
      const controls = Array.from((form || document).querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      )).filter(isVisibleAndEnabled);
      const submit = controls.find(control => {
        const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '').trim();
        return /^(继续|下一步|提交|验证|确认|Continue|Next|Submit|Verify|Confirm)$/i.test(label);
      }) || controls.find(control => {
        const type = (control.getAttribute?.('type') || control.type || '').toLowerCase();
        return type === 'submit';
      });
      if (submit) submit.click();
      return { ok: true, submitted: Boolean(submit) };
    }, codeSelector, String(code));

    if (!typed.ok) return false;
    if (!typed.submitted) {
      // Fallback: type via keyboard then Enter
      await this.fillStandardInput(codeSelector, String(code), { maxAttempts: 2 });
      await this.page.keyboard.press('Enter');
    }
    return true;
  }

  async waitForManualVerificationCompletion(user) {
    if (this.isStopped) return;
    const codeSelector = 'input[type="text"][maxlength="6"], input[placeholder*="code"], input[placeholder*="Code"], input[placeholder*="验证码"], #verification-code, #code';

    try {
      await this.page.waitForSelector(codeSelector, { visible: true, timeout: 30000 });
    } catch (error) {
      if (!this.isStopped) {
        this.log(`[INFO] [${user.testName}] 未检测到邮箱验证码输入框，页面可能已自动前进。`, 'info');
      }
      return;
    }

    await this.setVerificationCodeBanner(true);
    const sinceMs = Date.now() - 2 * 60 * 1000;
    let autoFilled = false;

    if (this.emailCodeFetcher?.isEnabled?.()) {
      this.log(`✉️ [${user.testName}] 正在从邮箱自动拉取验证码（plus-addressing：${user.testEmail}）...`, 'info');
      this.onVerificationCodeRequired({
        status: 'waiting',
        user: user.testName,
        message: '正在自动读取邮箱验证码…'
      });
      try {
        const code = await this.emailCodeFetcher.waitForCode({
          toEmail: user.testEmail,
          sinceMs
        });
        if (code && !this.isStopped) {
          this.log(`[INFO] [${user.testName}] 已获取邮箱验证码，正在填入并提交。`, 'info');
          autoFilled = await this.submitEmailVerificationCode(code, codeSelector);
        }
      } catch (error) {
        this.log(`[WARN] [${user.testName}] 自动读取邮箱验证码失败：${error.message}；改为人工输入。`, 'warning');
      }
    }

    if (!autoFilled && !this.isStopped) {
      this.log(`✉️ [${user.testName}] 请直接在当前网页输入并提交邮箱验证码。`, 'warning');
      this.onVerificationCodeRequired({
        status: 'waiting',
        user: user.testName,
        message: '请在自动打开的网页中输入并提交邮箱验证码。'
      });
    }

    let consecutiveHiddenChecks = 0;
    while (!this.isStopped && consecutiveHiddenChecks < 2) {
      let isVisible = false;
      try {
        isVisible = await this.page.evaluate(selector => {
          const input = document.querySelector(selector);
          if (!input) return false;
          const rect = input.getBoundingClientRect();
          const style = window.getComputedStyle(input);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        }, codeSelector);
      } catch (error) {
        const navigationChangedContext = /execution context was destroyed|cannot find context with specified id/i.test(error.message);
        if (!navigationChangedContext) throw error;
        // Navigation away from the code page is success.
        isVisible = false;
      }

      consecutiveHiddenChecks = isVisible ? 0 : consecutiveHiddenChecks + 1;
      if (consecutiveHiddenChecks < 2) {
        await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
      }
    }

    if (!this.isStopped) {
      this.log(`✅ [${user.testName}] 检测到邮箱验证页面已完成，继续执行。`, 'success');
      this.onVerificationCodeRequired({ status: 'resolved' });
      await this.setVerificationCodeBanner(false);
    }
  }

  async clickConsentSubmitInAnyFrame() {
    const frames = typeof this.page.frames === 'function' ? this.page.frames() : [this.page];
    for (const frame of frames) {
      let result;
      try {
        result = await frame.evaluate(() => {
          const isVisibleAndEnabled = control => {
            if (!control || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return false;
            const rect = control.getBoundingClientRect();
            const style = window.getComputedStyle(control);
            return rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden';
          };
          // Whitespace-insensitive so incidental spacing/newlines never break the match.
          const normalize = value => (value || '').replace(/\s+/g, '');
          const controls = Array.from(document.querySelectorAll(
            'button, input[type="submit"], input[type="button"], [role="button"]'
          )).filter(isVisibleAndEnabled);
          // Only the submit action is activated; the two recommendation checkboxes
          // are optional promotions and must remain untouched.
          const submitControl = controls.find(control => {
            const label = normalize(control.textContent || control.value || control.getAttribute?.('aria-label'));
            return label === '提交' || label.toLowerCase() === 'submit';
          })
            || controls.find(control => {
              const type = (control.getAttribute?.('type') || control.type || '').toLowerCase();
              return type === 'submit';
            })
            || controls.find(control => {
              const label = normalize(control.textContent || control.value || control.getAttribute?.('aria-label'));
              return label.includes('提交') || /submit/i.test(label);
            });
          if (!submitControl) return { clicked: false };
          const label = (submitControl.textContent || submitControl.value || submitControl.getAttribute?.('aria-label') || '').trim();
          submitControl.click();
          return { clicked: true, label };
        });
      } catch (error) {
        result = { clicked: false };
      }
      if (result && result.clicked) return result;
    }
    return { clicked: false };
  }

  async waitForDeveloperConsentCompletion() {
    if (this.isStopped || !this.page) return false;
    const consentUrl = this.page.url();

    // NVIDIA renders this consent page asynchronously (and may host it in a
    // sub-frame), so poll briefly instead of relying on a single lookup.
    let clicked = false;
    for (let attempt = 0; attempt < 20 && !clicked && !this.isStopped; attempt++) {
      const result = await this.clickConsentSubmitInAnyFrame();
      clicked = result.clicked;
      if (clicked) {
        this.log(`[INFO] 已自动点击 NVIDIA 开发者设置页的“${result.label || '提交'}”（推荐设置复选框保持不变）。`, 'info');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!clicked && !this.isStopped) {
      this.log('[WARN] 未找到可点击的“提交”按钮；保持窗口打开并等待页面前进。', 'warning');
    }

    await this.page.waitForFunction(
      url => location.href !== url,
      { timeout: this.manualStepTimeoutMs },
      consentUrl
    );
    if (!this.isStopped) {
      this.log('✅ 已检测到页面前进：NVIDIA 开发者设置页已提交。', 'success');
    }
    return !this.isStopped;
  }


  async createCloudAccount(user) {
    if (this.isStopped || !this.page) return false;

    const accountName = user.testCompany;
    if (!accountName) {
      throw new Error('Company name is missing from the user configuration');
    }

    this.log('[INFO] 等待 NVIDIA Cloud Account 命名页面...', 'info');
    await this.page.waitForFunction(() => {
      if (location.hostname !== 'cloudaccounts.nvidia.com'
        || location.pathname !== '/sf/v2/select-account') {
        return false;
      }
      const input = document.querySelector('input[name="name"]');
      if (!input) return false;
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    }, { timeout: this.manualStepTimeoutMs });

    await this.fillStandardInput('input[name="name"]', accountName, { maxAttempts: 2 });
    const cloudAccountUrl = this.page.url();

    const clicked = await this.page.evaluate(() => {
      const isVisibleAndEnabled = control => {
        if (!control || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return false;
        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const submitControl = Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      )).find(control => {
        const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '').trim();
        return /^(创建\s*NVIDIA\s*Cloud\s*Account|Create\s*NVIDIA\s*Cloud\s*Account|创建\s*Cloud\s*Account)$/i.test(label)
          && isVisibleAndEnabled(control);
      });
      if (!submitControl) return false;
      submitControl.click();
      return true;
    });

    if (clicked) {
      this.log('[INFO] Cloud Account 名称已填写，已自动点击“Create NVIDIA Cloud Account”。', 'info');
    } else {
      this.log('[INFO] 未找到可点击的“Create NVIDIA Cloud Account”按钮；保持窗口打开并等待页面前进。', 'info');
    }

    await this.page.waitForFunction(
      url => location.href !== url,
      { timeout: this.manualStepTimeoutMs },
      cloudAccountUrl
    );
    if (!this.isStopped) {
      this.log('✅ 已检测到页面前进：NVIDIA Cloud Account 已创建。', 'success');
    }
    return !this.isStopped;
  }

  async waitForApiKeyPage() {
    if (this.isStopped || !this.page) return false;

    this.log('[INFO] 等待已登录的 NVIDIA Build API Key 页面...', 'info');
    await this.page.waitForFunction(() => (
      location.hostname === 'build.nvidia.com'
      && location.pathname === '/settings/api-keys'
      && (document.readyState === 'interactive' || document.readyState === 'complete')
    ), { timeout: this.manualStepTimeoutMs });
    return true;
  }

  async waitForPostAuthenticationState() {
    if (this.isStopped || !this.page) return null;

    const stateHandle = await this.page.waitForFunction(() => {
      const isVisibleAndEnabled = control => {
        if (!control || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return false;
        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const pageText = document.body?.innerText || '';
      const passkeyLater = Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      )).find(control => {
        const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '').trim();
        return /^(稍后再说|Not Now|Maybe Later|Skip for now)$/i.test(label)
          && isVisibleAndEnabled(control);
      });
      if (/(创建通行密钥|Create (?:a )?passkey)/i.test(pageText) && passkeyLater) {
        return 'passkey';
      }
      const consentSubmit = Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      )).find(control => {
        const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '').trim();
        return /^(提交|Submit)$/i.test(label) && isVisibleAndEnabled(control);
      });
      if ((location.hostname === 'static-login.nvidia.com'
        && location.pathname.includes('/consent/developer/'))
        || (/(快完成了|请确认以下信息以完成注册|推荐设置)/.test(pageText) && consentSubmit)) {
        return 'developer-consent';
      }
      if (location.hostname === 'cloudaccounts.nvidia.com'
        && location.pathname === '/sf/v2/select-account') {
        return 'cloud-account';
      }
      if (location.hostname === 'build.nvidia.com'
        && location.pathname === '/settings/api-keys') {
        return 'api-key';
      }
      return false;
    }, { timeout: this.manualStepTimeoutMs });

    try {
      return await stateHandle.jsonValue();
    } finally {
      if (typeof stateHandle.dispose === 'function') {
        await stateHandle.dispose();
      }
    }
  }

  async skipPasskeyCreation() {
    if (this.isStopped || !this.page) return false;
    const passkeyUrl = this.page.url();
    const clicked = await this.page.evaluate(() => {
      const isVisibleAndEnabled = control => {
        if (!control || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return false;
        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const laterControl = Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      )).find(control => {
        const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '').trim();
        return /^(稍后再说|Not Now|Maybe Later|Skip for now)$/i.test(label)
          && isVisibleAndEnabled(control);
      });
      if (!laterControl) return false;
      laterControl.click();
      return true;
    });
    if (!clicked) {
      throw new Error('Unable to find the visible enabled Later action on the passkey page');
    }

    this.log('[INFO] 已自动点击通行密钥页面的“稍后再说”。', 'info');

    // NVIDIA shows a confirmation modal ("您确定要跳过设置通行密钥吗？"). Click only
    // its exact 确定/Confirm action; 取消/Cancel must never be clicked. The modal is
    // optional, so a short bounded wait that times out simply continues the flow.
    try {
      await this.page.waitForFunction(() => {
        const isVisibleAndEnabled = control => {
          if (!control || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return false;
          const rect = control.getBoundingClientRect();
          const style = window.getComputedStyle(control);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const text = document.body?.innerText || '';
        if (!/(确定要跳过设置通行密钥|sure you want to skip)/i.test(text)) return false;
        return Array.from(document.querySelectorAll(
          'button, input[type="submit"], input[type="button"], [role="button"]'
        )).some(control => {
          const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '').trim();
          return /^(确定|确认|Confirm|OK|Yes)$/i.test(label) && isVisibleAndEnabled(control);
        });
      }, { timeout: 10000 });

      const confirmed = await this.page.evaluate(() => {
        const isVisibleAndEnabled = control => {
          if (!control || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return false;
          const rect = control.getBoundingClientRect();
          const style = window.getComputedStyle(control);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const confirmControl = Array.from(document.querySelectorAll(
          'button, input[type="submit"], input[type="button"], [role="button"]'
        )).find(control => {
          const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '').trim();
          return /^(确定|确认|Confirm|OK|Yes)$/i.test(label) && isVisibleAndEnabled(control);
        });
        if (!confirmControl) return false;
        confirmControl.click();
        return true;
      });
      if (confirmed) {
        this.log('[INFO] 已自动点击跳过通行密钥确认弹窗的“确定”。', 'info');
      }
    } catch (error) {
      // No confirmation modal appeared within the short window; continue the flow.
    }

    await this.page.waitForFunction(previousUrl => {
      if (location.href !== previousUrl) return true;
      const controls = Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      ));
      return !controls.some(control => {
        const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '').trim();
        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return /^(稍后再说|Not Now|Maybe Later|Skip for now)$/i.test(label)
          && rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      });
    }, { timeout: this.manualStepTimeoutMs }, passkeyUrl);
    return true;
  }

  async completePostAuthentication(user) {
    for (let transition = 0; transition < 5; transition++) {
      if (this.isStopped) return false;
      const state = await this.waitForPostAuthenticationState();
      if (state === 'api-key') return true;
      if (state === 'passkey') {
        await this.skipPasskeyCreation();
        continue;
      }
      if (state === 'developer-consent') {
        await this.waitForDeveloperConsentCompletion();
        continue;
      }
      if (state === 'cloud-account') {
        await this.createCloudAccount(user);
        continue;
      }
      throw new Error(`Unexpected NVIDIA post-authentication state: ${state}`);
    }
    throw new Error('NVIDIA onboarding did not reach the API-key page after the expected transitions');
  }

  async prepareProxySession(user) {
    this.currentProxySession = null;
    const proxyConfig = this.automationConfig.proxy || {};
    if (!proxyConfig.enabled) return null;
    const sessionId = `${String(user?.testName || 'user').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      const session = await this.proxySessionFactory(proxyConfig, {
        sessionId,
        testName: user?.testName || ''
      });
      if (session?.enabled) {
        this.currentProxySession = session;
        this.log(`[INFO] 已为 ${user?.testName || 'session'} 分配住宅代理会话 ${session.sessionId} → ${session.puppeteerProxy}`, 'info');
      } else {
        this.log('[WARN] 代理已启用但未能创建有效会话，将直连继续。', 'warning');
      }
      return this.currentProxySession;
    } catch (error) {
      this.log(`[WARN] 代理会话创建失败：${error.message}；将直连继续。`, 'warning');
      return null;
    }
  }

  async applyProxyAuthentication() {
    if (!this.page || !this.currentProxySession?.authenticate) return;
    try {
      await this.page.authenticate(this.currentProxySession.authenticate);
    } catch (error) {
      this.log(`[WARN] 代理认证设置失败：${error.message}`, 'warning');
    }
  }

  async launchTargetBrowser(user) {
    await this.prepareProxySession(user);
    const profileOptions = {
      workspaceDir: this.workspaceDir,
      targetUserDataDir: this.targetUserDataDir
    };
    if (this.currentProxySession?.puppeteerProxy) {
      profileOptions.proxyServer = this.currentProxySession.puppeteerProxy;
    }
    this.resetTargetProfile(profileOptions);
    try {
      const sourceProfile = this.chromeProfileFinder();
      this.chromeExtensionProfileSync({
        sourceUserDataDir: sourceProfile.userDataDir,
        sourceProfileDirectory: sourceProfile.profileDirectory,
        targetUserDataDir: this.targetUserDataDir
      });
      return await this.backgroundBrowserLauncher(
        this.browserLauncher,
        this.targetLaunchOptionsFactory(profileOptions)
      );
    } catch (error) {
      this.resetTargetProfile(profileOptions);
      throw error;
    }
  }

  isTampermonkeyChangelog(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'www.tampermonkey.net'
        && parsed.pathname === '/changelog.php';
    } catch (error) {
      return false;
    }
  }

  async selectTargetPage(browser) {
    const pages = await browser.pages();
    if (pages.length === 0) {
      throw new Error('Chrome did not create an initial target page.');
    }

    let selectedPage = pages.find(page => page.url() === 'about:blank')
      || pages.find(page => !this.isTampermonkeyChangelog(page.url()))
      || pages[0];

    if (this.isTampermonkeyChangelog(selectedPage.url())) {
      await selectedPage.goto('about:blank');
    }

    await Promise.all(pages
      .filter(page => page !== selectedPage)
      .map(page => page.close().catch(() => {})));

    return selectedPage;
  }

  resolveCaptcha(source = 'manual') {
    if (this.captchaResolve) {
      this.captchaResolve(source);
      return true;
    }
    if (source === 'manual' && !this.isStopped) {
      this.captchaCheckRequested = true;
      return true;
    }
    return false;
  }

  waitForCaptchaCheck() {
    if (this.isStopped) return Promise.resolve('stopped');
    if (this.captchaCheckRequested) {
      this.captchaCheckRequested = false;
      return Promise.resolve('manual');
    }

    return new Promise(resolve => {
      let settled = false;
      const finish = source => {
        if (settled) return;
        settled = true;
        if (this.captchaTimer) clearTimeout(this.captchaTimer);
        this.captchaTimer = null;
        this.captchaResolve = null;
        resolve(source);
      };
      this.captchaResolve = source => finish(source || 'manual');
      this.captchaTimer = setTimeout(() => finish('auto'), this.captchaPollIntervalMs);
    });
  }

  async isCaptchaSolved() {
    // The human can pass the challenge without the widget's iframe ever
    // disappearing (hCaptcha's checkbox keeps its iframe on-screen), so rely on
    // definitive "passed" signals and search every frame, not just the main one.
    const frames = typeof this.page.frames === 'function' ? this.page.frames() : [this.page];
    for (const frame of frames) {
      try {
        const solved = await frame.evaluate(() => {
          const tokenNames = ['h-captcha-response', 'g-recaptcha-response', 'cf-turnstile-response'];
          const hasToken = tokenNames.some(name => {
            const field = document.querySelector(`textarea[name="${name}"], input[name="${name}"]`);
            return typeof field?.value === 'string' && field.value.trim().length > 0;
          });
          if (hasToken) return true;
          // hCaptcha's checkbox widget flips its checkbox to aria-checked="true"
          // once the human passes it, even though the iframe stays visible.
          return Boolean(document.querySelector(
            '#checkbox[aria-checked="true"], [role="checkbox"][aria-checked="true"]'
          ));
        });
        if (solved) return true;
      } catch (error) {
        // A frame can navigate/detach mid-check; ignore it and try the others.
      }
    }
    return false;
  }

  async detectCaptcha() {
    if (await this.isCaptchaSolved()) return null;

    const selectors = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      '.g-recaptcha',
      '.h-captcha',
      'iframe[src*="arkose"]',
      '.arkose',
      '#challenge-container',
      'iframe[src*="turnstile"]',
      '#challenge-form',
      '#captcha',
      '.captcha',
      '[name*="captcha"]',
      '#nvidia-captcha-container'
    ];
    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element) {
          const isVisible = await this.page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          }, selector);
          if (isVisible) {
            return selector;
          }
        }
      } catch (e) {
        // ignore selector errors
      }
    }
    return null;
  }

  async dismissCookieBanner() {
    for (let attempt = 0; attempt < this.cookieConsentMaxAttempts; attempt++) {
      try {
        const clicked = await this.page.evaluate(() => {
          const controls = Array.from(document.querySelectorAll(
            'button, a, input[type="button"], input[type="submit"], div[role="button"]'
          ));
          const eligibleControl = (control, expectedLabel) => {
            const rect = control.getBoundingClientRect();
            const style = window.getComputedStyle(control);
            const label = (control.textContent || control.value || '').replace(/\s+/g, ' ').trim();
            return label === expectedLabel
              && rect.width > 0
              && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden'
              && !control.disabled
              && control.getAttribute?.('aria-disabled') !== 'true';
          };
          const control = controls.find(candidate => eligibleControl(candidate, 'Reject Optional'))
            || controls.find(candidate => eligibleControl(candidate, 'Reject All'));
          if (!control) return false;
          control.click();
          return true;
        });
        if (clicked) {
          this.log('🍪 Cookie consent dismissed before page automation.', 'info');
          return true;
        }
      } catch (error) {
        // The CMP may replace its frame/context while rendering; keep polling.
      }

      if (attempt + 1 < this.cookieConsentMaxAttempts) {
        await new Promise(resolve => setTimeout(resolve, this.cookieConsentPollIntervalMs));
      }
    }

    throw new Error('NVIDIA cookie consent modal was not available before page automation');
  }

  async setCaptchaBanner(isIntervention) {
    try {
      await this.page.evaluate((intervention, activeTestName) => {
        const banner = document.getElementById('automation-warning-banner');
        if (!banner) return;
        banner.textContent = intervention
          ? '⚠️ 请在本页面完成人机验证'
          : activeTestName
            ? `🤖 自动填充：${activeTestName}（按钮请人工操作）`
            : '🤖 自动化运行中';
        banner.style.backgroundColor = intervention ? '#f59e0b' : '#2563eb';
        banner.style.color = intervention ? '#111827' : '#ffffff';
      }, isIntervention, this.currentTestName);
    } catch (error) {
      this.log(`[WARN] 无法更新人工干预横幅：${error.message}`, 'warning');
    }
  }

  async setVerificationCodeBanner(isWaiting) {
    try {
      await this.page.evaluate((waiting, activeTestName) => {
        const banner = document.getElementById('automation-warning-banner');
        if (!banner) return;
        banner.textContent = waiting
          ? '✉️ 请在本页面输入邮箱验证码'
          : activeTestName
            ? `🤖 自动填充：${activeTestName}（按钮请人工操作）`
            : '🤖 自动化运行中';
        banner.style.backgroundColor = '#2563eb';
        banner.style.color = '#ffffff';
      }, isWaiting, this.currentTestName);
    } catch (error) {
      this.log(`[WARN] 无法更新邮箱验证码横幅：${error.message}`, 'warning');
    }
  }

  buildSolverProxyString() {
    const session = this.currentProxySession;
    if (!session?.enabled || !session.server) return '';
    const hostPort = String(session.server).replace(/^(https?|socks5):\/\//i, '');
    if (session.username || session.password) {
      return `${hostPort}:${session.username || ''}:${session.password || ''}`;
    }
    return hostPort;
  }

  async tryAutoSolveCaptcha(user, activeCaptcha) {
    if (!this.captchaSolver?.isEnabled?.()) return false;
    try {
      const task = await extractCaptchaTaskFromPage(this.page);
      if (!task?.websiteKey) {
        this.log(`[WARN] [${user.testName}] 未能提取 captcha sitekey，跳过自动打码。`, 'warning');
        return false;
      }
      this.log(`[INFO] [${user.testName}] 正在调用 CapSolver 自动解决 ${task.type}…`, 'info');
      const proxy = this.buildSolverProxyString();
      const token = await this.captchaSolver.solve({
        type: task.type,
        websiteURL: task.websiteURL || (typeof this.page.url === 'function' ? this.page.url() : ''),
        websiteKey: task.websiteKey,
        proxy: proxy || undefined
      });
      if (!token) return false;
      const injected = await injectCaptchaToken(this.page, token);
      this.log(
        injected
          ? `[INFO] [${user.testName}] 已注入 captcha token。`
          : `[WARN] [${user.testName}] captcha token 已获取但页面注入未确认，继续检测。`,
        injected ? 'info' : 'warning'
      );
      // Give the page a moment to accept the token / enable Create Account.
      await new Promise(resolve => setTimeout(resolve, 1500));
      return true;
    } catch (error) {
      this.log(`[WARN] [${user.testName}] 自动打码失败：${error.message}`, 'warning');
      return false;
    }
  }

  async handleCaptchaIntervention(user) {
    let activeCaptcha = await this.detectCaptcha();
    if (!activeCaptcha) return;
    let consecutiveResolvedChecks = 0;
    let accountReady = false;

    await this.setCaptchaBanner(true);
    this.onCaptchaRequired({
      status: 'waiting',
      selector: activeCaptcha,
      user: user.testName,
      message: '正在尝试自动完成验证，失败时请人工处理。'
    });

    const markReadyIfAccountEnabled = async () => {
      const label = await this.findEnabledAccountActionLabel();
      if (label) {
        accountReady = true;
        consecutiveResolvedChecks = 2;
        this.log(`[INFO] [${user.testName}] 检测到可点击的“${label}”（验证码已解锁表单），准备自动提交。`, 'info');
        return true;
      }
      return false;
    };

    const autoTried = await this.tryAutoSolveCaptcha(user, activeCaptcha);
    if (autoTried && !this.isStopped) {
      // Confirm solved with the same two-poll rule used for human solves.
      for (let i = 0; i < 6 && consecutiveResolvedChecks < 2 && !this.isStopped; i++) {
        if (await markReadyIfAccountEnabled()) break;
        const stillThere = await this.detectCaptcha();
        if (stillThere) {
          activeCaptcha = stillThere;
          consecutiveResolvedChecks = 0;
        } else {
          consecutiveResolvedChecks++;
        }
        if (consecutiveResolvedChecks < 2) {
          await new Promise(resolve => setTimeout(resolve, this.captchaPollIntervalMs));
        }
      }
    }

    if (consecutiveResolvedChecks < 2 && !this.isStopped) {
      this.log(`⚠️ [${user.testName}] 检测到人机验证挑战 (${activeCaptcha})，请人工完成验证。`, 'warning');
      this.onCaptchaRequired({
        status: 'waiting',
        selector: activeCaptcha,
        user: user.testName,
        message: '完成验证后系统会自动点击“创建账户/登录”。'
      });
    }

    while (consecutiveResolvedChecks < 2 && !this.isStopped) {
      // NVIDIA often enables 创建账户 while the hCaptcha iframe stays mounted.
      // Do not wait only on iframe disappearance — that blocks the auto-click forever.
      if (await markReadyIfAccountEnabled()) break;

      const checkSource = await this.waitForCaptchaCheck();
      if (checkSource === 'stopped' || this.isStopped) break;

      if (await markReadyIfAccountEnabled()) break;

      const detectedCaptcha = await this.detectCaptcha();
      if (detectedCaptcha) {
        activeCaptcha = detectedCaptcha;
        consecutiveResolvedChecks = 0;
      } else {
        consecutiveResolvedChecks++;
      }
      if (detectedCaptcha && checkSource === 'manual') {
        const message = '仍未检测到验证结果，请完成验证后重试；系统会继续自动检测并尝试点击创建账户。';
        this.log(`⚠️ [${user.testName}] ${message}`, 'warning');
        this.onCaptchaRequired({
          status: 'waiting',
          selector: activeCaptcha,
          user: user.testName,
          message
        });
      }
    }

    if ((consecutiveResolvedChecks >= 2 || accountReady) && !this.isStopped) {
      this.log(
        accountReady
          ? `✅ [${user.testName}] 验证码已解锁账户按钮，继续自动点击。`
          : `✅ [${user.testName}] 验证通过，继续执行。`,
        'success'
      );
      this.onCaptchaRequired({ status: 'resolved' });
      await this.setCaptchaBanner(false);
    }
  }

  /**
   * Label match for NVIDIA account primary action.
   * Accepts 账户/帐户 variants, nested whitespace, and common EN/CN login labels.
   */
  static accountActionLabelPattern() {
    return /^(创建[账帐]户|创建\s*账户|创建\s*帐户|Create\s*Account|登录|登录客户端|Log\s*In|Sign\s*In)$/i;
  }

  static isAccountActionLabel(raw) {
    const label = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!label) return false;
    if (PuppeteerRunner.accountActionLabelPattern().test(label)) return true;
    // Nested Material buttons sometimes append icon text; allow contains for create-account only.
    if (/创建[账帐]户/.test(label) && label.length <= 20) return true;
    if (/^create\s*account$/i.test(label)) return true;
    return false;
  }

  async collectVisibleAccountActionCandidates() {
    if (!this.page) return [];
    const targets = typeof this.page.frames === 'function' ? this.page.frames() : [this.page];
    const all = [];
    for (const frame of targets) {
      try {
        const found = await frame.evaluate(() => {
          const isVisible = element => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden';
          };
          return Array.from(document.querySelectorAll(
            'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]'
          )).filter(isVisible).map(control => {
            const label = (control.textContent || control.value || control.getAttribute?.('aria-label') || '')
              .replace(/\s+/g, ' ')
              .trim();
            return {
              label,
              disabled: Boolean(control.disabled || control.getAttribute?.('aria-disabled') === 'true')
            };
          }).filter(item => item.label);
        });
        all.push(...(found || []));
      } catch (error) {
        // Frame may detach.
      }
    }
    return all;
  }

  async findEnabledAccountActionLabel() {
    const candidates = await this.collectVisibleAccountActionCandidates();
    const match = candidates.find(item => !item.disabled && PuppeteerRunner.isAccountActionLabel(item.label));
    return match ? match.label : null;
  }

  async submitVisibleAccountAction() {
    if (this.isStopped || !this.page) return false;

    // Only click when the control is truly enabled — never force-enable a disabled 创建账户.
    const clickScript = () => {
      const isVisible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const isEnabled = control => {
        if (!control || control.disabled) return false;
        if (control.getAttribute?.('aria-disabled') === 'true') return false;
        if (control.classList?.contains?.('disabled')) return false;
        const style = window.getComputedStyle(control);
        if (style.pointerEvents === 'none') return false;
        return true;
      };
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const isAccountLabel = raw => {
        const label = normalize(raw);
        if (!label) return false;
        if (/^(创建[账帐]户|Create\s*Account|登录|登录客户端|Log\s*In|Sign\s*In)$/i.test(label)) return true;
        if (/创建[账帐]户/.test(label) && label.length <= 20) return true;
        return false;
      };
      const controls = Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]'
      ));
      const actionControl = controls.find(control => {
        return isAccountLabel(control.textContent || control.value || control.getAttribute?.('aria-label'))
          && isVisible(control)
          && isEnabled(control);
      });
      if (!actionControl) return null;

      const label = normalize(
        actionControl.textContent || actionControl.value || actionControl.getAttribute?.('aria-label') || ''
      );
      // Mark only for a follow-up real pointer click; do not mutate disabled state.
      actionControl.setAttribute?.('data-auto-account-action', '1');
      actionControl.focus?.();
      actionControl.click();
      try {
        actionControl.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      } catch (_) {}
      return label;
    };

    const targets = typeof this.page.frames === 'function' ? this.page.frames() : [this.page];
    for (const frame of targets) {
      let clickedLabel = null;
      try {
        clickedLabel = await frame.evaluate(clickScript);
      } catch (error) {
        continue;
      }
      if (!clickedLabel) continue;

      // Second path: real CDP/element click (Angular often ignores bare DOM click).
      try {
        const handle = await frame.$('[data-auto-account-action="1"]');
        if (handle) {
          try {
            await handle.click({ delay: 40 });
          } catch (error) {
            const box = await handle.boundingBox();
            if (box && this.page.mouse) {
              await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 40 });
            }
          }
          try { await handle.dispose(); } catch (_) {}
        }
      } catch (error) {
        // DOM click already fired; continue.
      }

      this.log(`[INFO] 已自动点击当前可见的“${clickedLabel}”。`, 'info');
      return true;
    }

    // Diagnostics so operators can see why the click did not fire.
    try {
      const candidates = await this.collectVisibleAccountActionCandidates();
      if (candidates.length > 0) {
        const summary = candidates
          .slice(0, 8)
          .map(item => `"${item.label}"${item.disabled ? '(disabled)' : ''}`)
          .join(', ');
        this.log(`[WARN] 未点到创建账户/登录。当前可见按钮：${summary}`, 'warning');
      } else {
        this.log('[WARN] 未点到创建账户/登录：页面上没有可见的 button/submit 控件。', 'warning');
      }
    } catch (error) {
      // ignore
    }
    return false;
  }

  async urlChangedFrom(previousUrl) {
    if (!this.page || typeof this.page.url !== 'function') return false;
    try {
      return this.page.url() !== previousUrl;
    } catch (error) {
      // A destroyed frame usually means navigation started.
      return /execution context was destroyed|cannot find context|Target closed|Session closed/i.test(error.message);
    }
  }

  async waitForUrlChangeOrTimeout(previousUrl, timeout) {
    if (await this.urlChangedFrom(previousUrl)) return true;
    try {
      await this.page.waitForFunction(url => location.href !== url, { timeout }, previousUrl);
      return true;
    } catch (error) {
      if (this.isStopped) return false;
      if (await this.urlChangedFrom(previousUrl)) return true;
      const navigatedAway = /execution context was destroyed|cannot find context|Target closed|Session closed|frame was detached/i.test(error.message || '');
      if (navigatedAway) return true;
      // Do not rethrow: callers treat false as soft failure and keep retrying the user
      // without tearing down mid-captcha for transient wait errors.
      this.log(`[WARN] 等待页面前进超时或失败：${error.message}`, 'warning');
      return false;
    }
  }

  /**
   * After captcha, repeatedly try 创建账户 / Create Account / Login until the page advances.
   * Never throw for a missing button — that used to close Chrome mid-verification.
   */
  async resubmitAccountActionAfterCaptcha(previousUrl, user, timeout = this.manualStepTimeoutMs) {
    this.log(`[INFO] [${user.testName}] 验证码阶段结束，开始自动点击“创建账户/登录”…`, 'info');
    for (let attempts = 1; attempts <= this.postCaptchaMaxAttempts && !this.isStopped; attempts++) {
      if (await this.urlChangedFrom(previousUrl)) {
        this.log('✅ 验证完成后页面已自动前进。', 'success');
        return true;
      }
      let clicked = false;
      try {
        clicked = await this.submitVisibleAccountAction();
      } catch (error) {
        if (/execution context was destroyed|cannot find context|Target closed|frame was detached/i.test(error.message || '')) {
          if (await this.urlChangedFrom(previousUrl)) return true;
        } else {
          this.log(`[WARN] 点击创建账户/登录时出错：${error.message}`, 'warning');
        }
      }
      if (clicked) {
        this.log(`[INFO] 验证通过后已点击账户操作（第 ${attempts} 次尝试：创建账户/登录）。`, 'info');
        // After a successful click, wait up to the full human-paced timeout for navigation.
        const advanced = await this.waitForUrlChangeOrTimeout(previousUrl, timeout);
        if (advanced) {
          this.log('✅ 验证完成后已再次提交当前可见的账户操作，页面已继续。', 'success');
          return true;
        }
        // Click registered but page stayed — try again (Angular may ignore first synthetic click).
      } else {
        if (attempts === 1 || attempts % 5 === 0) {
          this.log(`[INFO] 验证完成后暂未点到“创建账户/登录”（第 ${attempts}/${this.postCaptchaMaxAttempts} 次）；保持窗口并重试。`, 'info');
        }
        // Button may still be disabled; also wait briefly for auto-navigation.
        const advanced = await this.waitForUrlChangeOrTimeout(
          previousUrl,
          Math.min(this.postCaptchaNavWaitMs, timeout)
        );
        if (advanced) {
          this.log('✅ 验证完成后页面已自动前进。', 'success');
          return true;
        }
        if (this.postCaptchaRetryMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.postCaptchaRetryMs));
        }
      }
    }
    if (await this.urlChangedFrom(previousUrl)) return true;
    // Soft failure: do not throw — throwing previously closed Chrome mid-verification.
    this.log(`[WARN] [${user.testName}] 验证后未能在时限内完成账户提交跳转（本轮不抛错，避免窗口被异常关闭）。`, 'warning');
    return false;
  }

  async waitForAccountNavigationAfterCaptcha(
    previousUrl,
    user,
    timeout = this.manualStepTimeoutMs
  ) {
    if (this.isStopped) return false;
    const submitted = await this.submitVisibleAccountAction();
    if (submitted) {
      this.log('[INFO] 已提交当前账户操作；如出现人机验证，请在当前页面完成，之后将自动再次点击“创建账户/登录”。', 'info');
    } else {
      // The Create Account / Log In control is frequently disabled until captcha clears.
      // Keep the browser open and wait for captcha or navigation — never throw here.
      this.log('[INFO] 暂无可点击的账户操作按钮（通常需先完成人机验证）；保持窗口打开并等待验证或页面变化。', 'info');
    }

    let state = null;
    try {
      const stateHandle = await this.page.waitForFunction(url => {
        if (location.href !== url) return 'navigated';
        const selectors = [
          'iframe[src*="recaptcha"]',
          'iframe[src*="hcaptcha"]',
          '.g-recaptcha',
          '.h-captcha',
          'iframe[src*="arkose"]',
          '.arkose',
          '#challenge-container',
          'iframe[src*="turnstile"]',
          '#challenge-form',
          '#captcha',
          '.captcha',
          '[name*="captcha"]',
          '#nvidia-captcha-container'
        ];
        const captchaVisible = selectors.some(selector => {
          const element = document.querySelector(selector);
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        });
        return captchaVisible ? 'captcha' : false;
      }, { timeout }, previousUrl);
      state = await stateHandle.jsonValue();
      await stateHandle.dispose();
    } catch (error) {
      if (this.isStopped) return false;
      if (await this.urlChangedFrom(previousUrl)) return true;
      // If wait failed but captcha is present, continue into intervention.
      const captchaNow = await this.detectCaptcha().catch(() => null);
      if (captchaNow) {
        state = 'captcha';
      } else {
        this.log(`[WARN] 等待账户页导航/验证码时出错：${error.message}`, 'warning');
        return await this.urlChangedFrom(previousUrl);
      }
    }

    if (state === 'navigated' || this.isStopped) return !this.isStopped;

    await this.handleCaptchaIntervention(user);
    if (this.isStopped) return false;

    if (await this.urlChangedFrom(previousUrl)) {
      this.log('✅ 验证完成后页面已前进。', 'success');
      return true;
    }

    // Critical path: always re-click 创建账户 / Create Account / Login after captcha.
    return this.resubmitAccountActionAfterCaptcha(previousUrl, user, timeout);
  }

  async fillStandardInput(selector, text, { stabilityDelayMs = 0, maxAttempts = 3 } = {}) {
    const expectedValue = String(text);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.isStopped) return;
      await this.page.waitForSelector(selector, { visible: true, timeout: 30000 });
      if (stabilityDelayMs > 0) {
        this.log(`[INFO] Waiting ${stabilityDelayMs / 1000} seconds for the input page to finish refreshing...`, 'info');
        await new Promise(r => setTimeout(r, stabilityDelayMs));
        if (this.isStopped) return;
        await this.page.waitForSelector(selector, { visible: true, timeout: 30000 });
      }

      // Check if it's a date input
      const isDateInput = await this.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.type === 'date' : false;
      }, selector);

      if (isDateInput) {
        await this.page.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, selector, expectedValue);
      } else {
        await this.page.focus(selector);
        await this.page.keyboard.down('Control');
        try {
          await this.page.keyboard.press('A');
        } finally {
          await this.page.keyboard.up('Control');
        }
        await this.page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 100));

        const clearedValue = await this.page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el && typeof el.value === 'string' ? el.value : null;
        }, selector);
        if (clearedValue !== '') {
          if (attempt < maxAttempts) {
            this.log(`[WARN] Input could not be cleared on attempt ${attempt}; reacquiring the field before retrying...`, 'warning');
          }
          continue;
        }

        for (const char of expectedValue) {
          await this.page.keyboard.sendCharacter(char);
          const delay = Math.floor(Math.random() * (180 - 60 + 1)) + 60;
          await new Promise(r => setTimeout(r, delay));
        }

        await this.page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, selector);
      }

      await new Promise(r => setTimeout(r, 1000));
      const actualValue = await this.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el && typeof el.value === 'string' ? el.value : null;
      }, selector);

      if (actualValue === expectedValue) return;
      if (attempt < maxAttempts) {
        this.log(`[WARN] Input value did not match after attempt ${attempt}; replacing the full value and retrying...`, 'warning');
      }
    }

    throw new Error(`Failed to enter the exact expected value into ${selector} after ${maxAttempts} attempts`);
  }

  async fillEmailInput(email) {
    const emailInputSelector = 'input[type="email"], input[name="email"], input#email, #email input';
    return this.fillStandardInput(emailInputSelector, email, {
      stabilityDelayMs: 4000,
      maxAttempts: 2
    });
  }

  async clickEmailNextAfterVerification(expectedEmail) {
    const emailInputSelector = 'input[type="email"], input[name="email"], input#email, #email input';
    await new Promise(resolve => setTimeout(resolve, 3000));

    const result = await this.page.evaluate((selector, expectedValue) => {
      const emailInput = document.querySelector(selector);
      if (!emailInput || typeof emailInput.value !== 'string') {
        return { ok: false, reason: 'email input is no longer available' };
      }
      if (emailInput.value !== expectedValue) {
        return { ok: false, reason: 'email changed before Next' };
      }

      const isEnabledAndVisible = control => {
        if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return false;
        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const form = emailInput.closest('form');
      const controls = Array.from((form || document).querySelectorAll('button, input[type="submit"]'))
        .filter(isEnabledAndVisible);
      const exactNext = controls.find(control => {
        const label = control.textContent || control.value || control.getAttribute('aria-label') || '';
        return /^(next|continue)$/i.test(label.trim());
      });
      const nextControl = exactNext || (controls.length === 1 ? controls[0] : null);
      if (!nextControl) {
        return { ok: false, reason: 'enabled Next control was not found' };
      }

      nextControl.click();
      return { ok: true };
    }, emailInputSelector, expectedEmail);

    if (!result.ok) {
      throw new Error(`Unable to continue from NVIDIA email entry: ${result.reason}`);
    }
  }

  async waitForEmailNavigation(previousUrl, timeout = this.manualStepTimeoutMs) {
    if (this.isStopped) return false;
    this.log('[INFO] Email verified and Next clicked automatically; waiting for NVIDIA to advance...', 'info');
    await this.page.waitForFunction(url => location.href !== url, { timeout }, previousUrl);
    return !this.isStopped;
  }

  async fillRegistrationPasswords(password) {
    const passwordSelector = 'input#registration_password, input[formcontrolname="password"][autocomplete="new-password"]';
    const confirmationSelector = 'input#registration_passwordConfirm, input[formcontrolname="confirmPassword"][autocomplete="new-password"]';

    await this.page.waitForSelector(passwordSelector, { visible: true, timeout: 30000 });
    await this.page.waitForSelector(confirmationSelector, { visible: true, timeout: 30000 });
    await this.fillStandardInput(passwordSelector, password, { maxAttempts: 2 });
    await this.fillStandardInput(confirmationSelector, password, { maxAttempts: 2 });
  }

  async fillAccountPassword(password) {
    await this.page.waitForFunction(() => {
      const isVisible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };

      if (location.pathname === '/v1/create-account') {
        const registrationPassword = document.querySelector(
          'input#registration_password, input[formcontrolname="password"][autocomplete="new-password"]'
        );
        const registrationConfirmation = document.querySelector(
          'input#registration_passwordConfirm, input[formcontrolname="confirmPassword"][autocomplete="new-password"]'
        );
        return isVisible(registrationPassword) && isVisible(registrationConfirmation);
      }

      return location.pathname === '/v1/login/password'
        && isVisible(document.querySelector('input[type="password"]'));
    }, { timeout: 30000 });

    const mode = await this.page.evaluate(() => (
      location.pathname === '/v1/create-account' ? 'registration' : 'login'
    ));
    if (mode === 'registration') {
      await this.fillRegistrationPasswords(password);
    } else {
      await this.fillStandardInput('input[type="password"]', password, { maxAttempts: 2 });
    }
    return mode;
  }

  async authenticateAccount(user) {
    this.log('[INFO] 正在等待稳定的账户密码页面并输入密码...', 'info');
    const accountUrl = this.page.url();
    const mode = await this.fillAccountPassword(user.testPassword);

    if (mode === 'login') {
      await this.waitForAccountNavigationAfterCaptcha(accountUrl, user);
      return mode;
    }

    const dobSelector = 'input[type="date"], input[placeholder*="dob"], input[placeholder*="Date"], input[placeholder*="出生日期"]';
    const dobEl = await this.page.$(dobSelector);
    if (dobEl) {
      await this.fillStandardInput(dobSelector, user.testDOB);
    }

    await this.waitForAccountNavigationAfterCaptcha(accountUrl, user);

    if (!this.isStopped) {
      await this.waitForManualVerificationCompletion(user);
    }
    return mode;
  }

  validateUrl(targetUrl) {
    try {
      const parsed = new URL(targetUrl);
      const hostname = parsed.hostname;
      const allowedDomains = [
        'localhost',
        '127.0.0.1',
        'example.com',
        'sandbox.mysite.test',
        'nvidia.com',
        'build.nvidia.com'
      ];
      return allowedDomains.some(domain => {
        if (domain === 'localhost') {
          return hostname === 'localhost' || hostname === '127.0.0.1';
        }
        if (domain.startsWith('*.')) {
          const suffix = domain.slice(2);
          return hostname === suffix || hostname.endsWith('.' + suffix);
        }
        return hostname === domain;
      });
    } catch (e) {
      return false;
    }
  }

  async injectWarningBanner(testName = '') {
    try {
      await this.page.evaluate((activeTestName) => {
        if (document.getElementById('automation-warning-banner')) return;
        const banner = document.createElement('div');
        banner.id = 'automation-warning-banner';
        banner.textContent = activeTestName
          ? `🤖 自动填充：${activeTestName}（按钮请人工操作）`
          : '🤖 自动化运行中';
        banner.style.position = 'fixed';
        banner.style.top = '0';
        banner.style.left = '0';
        banner.style.width = '100%';
        banner.style.backgroundColor = '#2563eb';
        banner.style.color = '#ffffff';
        banner.style.textAlign = 'center';
        banner.style.padding = '8px 0';
        banner.style.fontSize = '14px';
        banner.style.fontWeight = 'bold';
        banner.style.zIndex = '2147483647';
        banner.style.pointerEvents = 'none';
        banner.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
        document.body.appendChild(banner);
        document.body.style.marginTop = '36px';
      }, testName);
    } catch (e) {
      // ignore
    }
  }

  isSuccessfulResult(result) {
    return ResultStore.isSuccessfulResult(result);
  }

  hasValidKey(testName, results) {
    const found = results.find(r => r.testName === testName);
    return this.isSuccessfulResult(found);
  }

  readExistingResults() {
    return new ResultStore({ resultsFile: this.resultsFile }).read();
  }

  exportResults(results) {
    try {
      new ResultStore({ resultsFile: this.resultsFile }).replaceAll(results);
    } catch (e) {
      this.log(`❌ 写入结果 Markdown 文件失败: ${e.message}`, 'error');
    }
  }

  async recordSuccessfulResult(resultObj, accumulatedResults = null) {
    const results = accumulatedResults || this.readExistingResults();
    const existingIndex = results.findIndex(result => result.testName === resultObj.testName);
    if (existingIndex === -1) results.push({ ...resultObj });
    else results[existingIndex] = { ...resultObj };
    if (this.persistResults) this.exportResults(results);
    await this.onUserSuccess({ ...resultObj });
    return results;
  }

  async run() {
    this.log('🤖 启动测试自动化流程...', 'info');

    const targetUrl = this.automationConfig.targetUrl || 'https://build.nvidia.com/settings/api-keys';
    if (!this.validateUrl(targetUrl)) {
      this.log(`❌ [安全终止] 目标 URL "${targetUrl}" 不符合沙箱/测试域名白名单!`, 'error');
      this.onFinished();
      return;
    }

    const accumulatedResults = this.readExistingResults();
    if (this.persistResults) this.exportResults(accumulatedResults);
    const completedCount = this.users.filter(u => this.hasValidKey(u.testName, accumulatedResults)).length;
    this.log(`📊 当前进度: 已成功生成 ${completedCount} 个 API Key / 共 ${this.users.length} 个用户`, 'info');

    try {
      for (let i = 0; i < this.users.length; i++) {
        if (this.isStopped) break;

        const user = this.users[i];
        if (this.hasValidKey(user.testName, accumulatedResults)) {
          this.log(`[SKIP] 用户 "${user.testName}" 已存在有效 API Key，跳过。`, 'info');
          continue;
        }

        this.currentTestName = user.testName;

        this.log(`🚀 开始处理测试用户: ${user.testName} (${i + 1}/${this.users.length})`, 'info');

        let userSuccess = false;
        let userApiKey = '';
        let attempt = 0;

        while (!userSuccess && !this.isStopped) {
          attempt++;
          try {
            if (attempt > 1) {
              this.log(`[RETRY] 用户 "${user.testName}" 正在进行第 ${attempt - 1} 次重试...`, 'info');
            }

            // Launch local Chrome with a disposable project-only profile (+ optional residential proxy).
            this.browser = await this.launchTargetBrowser(user);

                this.page = await this.selectTargetPage(this.browser);
                await this.applyProxyAuthentication();

                // Reassert a clean browser boundary for every user attempt before navigation.
                await this.prepareCleanUserSession();

            // Anti-bot detection: Hide webdriver property
            await this.page.evaluateOnNewDocument(() => {
              Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
              });
            });

            // Dynamically load and inject the local bypass userscript
            const userScriptPath = path.join(__dirname, 'Nvidia-bypass-phone.user.js');
            if (fs.existsSync(userScriptPath)) {
              const userScriptContent = fs.readFileSync(userScriptPath, 'utf8');
              // Automatically evaluate/load the userscript before other scripts run, scoped to nvidia.com
              await this.page.evaluateOnNewDocument((code) => {
                if (window.location.href.includes('nvidia.com')) {
                  const script = document.createElement('script');
                  script.textContent = code;
                  (document.head || document.documentElement).appendChild(script);
                }
              }, userScriptContent);
            }

            await this.page.goto(targetUrl, {
              waitUntil: 'networkidle2',
              timeout: 30000
            });

            await this.dismissCookieBanner();
            await this.injectWarningBanner(user.testName);
            this.page.on('domcontentloaded', async () => {
              await this.injectWarningBanner(user.testName);
            });

                // 1. 输入邮箱
                const identifierUrl = this.page.url();
                this.log('[INFO] 正在寻找并填充邮箱输入框...', 'info');
                await this.fillEmailInput(user.testEmail);
                await this.clickEmailNextAfterVerification(user.testEmail);
                await this.waitForEmailNavigation(identifierUrl);

            if (this.isStopped) break;

            // 2. 处理新账户注册或已存在账户登录；人工邮箱码仅在注册路径等待。
            await this.authenticateAccount(user);

            if (this.isStopped) break;

            // 3. 按实际页面依次处理开发者推荐设置、Cloud Account，直到 API Key 页面。
            await this.completePostAuthentication(user);
            if (this.isStopped) break;

            // 4. 使用 active session 发送 fetch 请求生成并获取 API Key。
            await this.waitForApiKeyPage();
            this.log('[INFO] 正在使用 active session 凭证发送 API 请求以提取 API Key...', 'info');
            userApiKey = await this.page.evaluate(async () => {
              try {
                const step1Res = await fetch('https://api.ngc.nvidia.com/user-context', {
                  method: 'GET',
                  credentials: 'include',
                  headers: {
                    accept: 'application/json, text/plain, */*',
                  },
                });
                if (!step1Res.ok) {
                  throw new Error(`获取 user-context 失败: ${step1Res.status} ${step1Res.statusText}`);
                }
                const step1Data = await step1Res.json();
                const orgName = step1Data?.orgName;
                if (!orgName) {
                  throw new Error(`在 user-context 返回中未找到 orgName: ${JSON.stringify(step1Data)}`);
                }

                const step2Url = `https://api.ngc.nvidia.com/v3/orgs/${orgName}/keys/type/AI_PLAYGROUNDS_KEY`;
                const payload = {
                  expiryDate: '2126-04-08T07:00:00Z',
                  name: 'dev',
                  type: 'AI_PLAYGROUNDS_KEY',
                  policies: [
                    {
                      product: 'nv-cloud-functions',
                      scopes: ['invoke_function'],
                      resources: [{ id: '*', type: 'account-functions' }],
                    },
                  ],
                };

                const step2Res = await fetch(step2Url, {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    accept: '*/*',
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify(payload),
                });

                if (!step2Res.ok) {
                  const errorText = await step2Res.text();
                  throw new Error(`创建 API Key 失败: ${step2Res.status} ${step2Res.statusText} - ${errorText}`);
                }

                const step2Data = await step2Res.json();
                return step2Data?.apiKey?.value || '';
              } catch (e) {
                return 'Error: ' + e.message;
              }
            });

            if (!userApiKey || userApiKey.startsWith('Error:')) {
              throw new Error(userApiKey || 'API Key 生成结果为空');
            }

            this.log(`✅ [${user.testName}] 成功生成并提取到 API Key!`, 'success');
            userSuccess = true;

          } catch (err) {
            this.log(`❌ [ERROR] 处理用户 "${user.testName}" 时发生异常: ${err.message}`, 'error');
            userApiKey = '';
            if (!this.isStopped) {
              this.log(`[RETRY] 用户 "${user.testName}" 未完成，将继续停留在当前用户。`, 'warning');
              await new Promise(r => setTimeout(r, 3000));
            }
          } finally {
            if (this.browser) {
              try {
                await this.browser.close();
              } catch (e) {}
              this.browser = null;
              this.page = null;
            }
            this.resetTargetProfile({
              workspaceDir: this.workspaceDir,
              targetUserDataDir: this.targetUserDataDir
            });
          }
        }

        if (this.isStopped) break;

        const resultObj = { testName: user.testName, apiKey: userApiKey };
        await this.recordSuccessfulResult(resultObj, accumulatedResults);
      }

      if (this.browser) {
        await this.browser.close();
      }

      if (!this.isStopped) {
        this.log('🎉 所有测试用户处理完毕！', 'success');
      }
    } catch (e) {
      this.log(`🚨 致命错误: ${e.message}`, 'error');
      if (this.browser) {
        await this.browser.close();
      }
    } finally {
      this.onFinished();
    }
  }
}

module.exports = PuppeteerRunner;
