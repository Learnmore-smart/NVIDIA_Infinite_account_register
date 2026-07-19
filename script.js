/**
 * ====================================================================================
 * ⚠️  合规与安全警示声明 (Compliance & Safety Warning)
 * ====================================================================================
 * 本脚本为浏览器自动化竞赛（如 NVIDIA 开发者平台模拟挑战）的教学教练模板。
 * 
 * 【严禁用途】
 * 此脚本仅允许在授权的本地测试环境（localhost）、沙箱测试域名（如 *.example.com、sandbox.mysite.test）上运行。
 * 严禁将本脚本用于任何未经授权的真实生产环境网站。擅自运行可能违反服务条款，甚至触犯网络安全相关法律。
 * 
 * 【设计原则】
 * 1. 显式告知：页面顶部注入红色醒目标幅，声明自动化测试中，不进行任何指纹伪装。
 * 2. 正常输入：使用 Puppeteer 标准 type 方法，配合固定延迟，不模拟人类无规则滑动或随机键入。
 * 3. 强制人机协同：检测到验证码（包括 NVIDIA Arkose 挑战）时脚本主动挂起，由人工在浏览器窗口中完成验证，严禁自动破解。
 * ====================================================================================
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ==========================================
// 1. 脚本全局配置区
// ==========================================
const CONFIG = {
  // 目标页面URL及选择器配置
  targetUrl: 'http://127.0.0.1:3000/register', // 参赛者应根据实际测试环境修改此 URL
  selectors: {
    companyInput: '#company',
    emailInput: '#email',
    usernameInput: '#username',
    dobInput: '#dob',
    passwordInput: '#password',
    cloudAccountInput: '#cloud-account',
    emailVerificationInput: '#verification-code',
    apiKeyDisplay: '#api-key-display'
  },

  // 允许运行的域名白名单（沙箱/测试域名）
  allowedDomains: [
    'localhost',
    '127.0.0.1',
    'example.com',
    'sandbox.mysite.test'
  ],

  // Gmail 凭据配置区 (用于自动提取验证码)
  // 获取 Gmail 应用专用密码步骤：
  // 1. 登录 Google 账号 -> 安全 (Security)
  // 2. 启用 “两步验证” (2-Step Verification)
  // 3. 搜索并进入 “应用专用密码” (App Passwords)
  // 4. 创建一个新应用密码（例如命名为 "Puppeteer IMAP"），系统会生成 16 位字符密码。
  gmail: {
    email: process.env.TEST_GMAIL_EMAIL || '', // 也可以在此处硬编码 demo 邮箱，但不推荐提交到公有库
    appPassword: process.env.TEST_GMAIL_APP_PASSWORD || '' // 16位应用专用密码
  },

  // 进度保存与结果导出路径
  progressFile: path.join(__dirname, 'progress_test.json'),
  resultsFile: path.join(__dirname, 'api_keys_test.md'),

  // 自动化运行参数
  actionDelayMs: 1000,   // 每个交互步骤之间的固定等待时间（毫秒）
  pageTimeoutMs: 30000,  // 页面加载和选择器等待超时时间
  maxRetries: 2          // 网络或步骤失败时的最大重试次数
};

// ==========================================
// 2. 虚构测试用户列表驱动
// ==========================================
const TEST_USERS = [
  {
    testName: "test_user_1",
    testCompany: "TestCorp A",
    testEmail: "test_user_1@example.com",
    testUsername: "tester_one",
    testDOB: "1990-01-01",
    testPassword: "SecurePassword123!",
    testCloudAccount: "cloud_acc_1"
  },
  {
    testName: "test_user_2",
    testCompany: "TestCorp B",
    testEmail: "test_user_2@example.com",
    testUsername: "tester_two",
    testDOB: "1995-05-15",
    testPassword: "SecurePassword456!",
    testCloudAccount: "cloud_acc_2"
  },
  {
    testName: "test_user_3",
    testCompany: "TestCorp C",
    testEmail: "test_user_3@example.com",
    testUsername: "tester_three",
    testDOB: "1988-12-12",
    testPassword: "SecurePassword789!",
    testCloudAccount: "cloud_acc_3"
  }
];

// ==========================================
// 3. 人机验证检测选择器列表（支持常见验证码及 NVIDIA Arkose 挑战）
// ==========================================
const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.g-recaptcha',
  '.h-captcha',
  'iframe[src*="arkose"]',          // Arkose Labs (NVIDIA 常用)
  '.arkose',
  '#challenge-container',           // Cloudflare Turnstile
  'iframe[src*="turnstile"]',
  '#challenge-form',
  '#captcha',
  '.captcha',
  '[name*="captcha"]',
  '#nvidia-captcha-container'       // 假设的 NVIDIA 验证容器
];

// ==========================================
// 4. 辅助函数实现
// ==========================================

/**
 * 验证目标 URL 是否在沙箱域名白名单内
 * @param {string} urlString 
 * @returns {boolean}
 */
function validateUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname;
    return CONFIG.allowedDomains.some(domain => {
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

/**
 * 固定时间的延迟等待，拒绝随机化伪装
 * @param {number} ms 
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function prepareCleanUserSession(page) {
  const client = await page.target().createCDPSession();
  await client.send('Network.clearBrowserCookies');
  await client.send('Network.clearBrowserCache');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Storage.clearDataForOrigin', {
    origin: new URL(CONFIG.targetUrl).origin,
    storageTypes: 'all'
  });
}

async function dismissCookieBanner(page) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const clicked = await page.evaluate(() => {
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
      if (clicked) return true;
    } catch (error) {
      // The modal can replace its own frame/context while rendering.
    }
    if (attempt < 39) await sleep(250);
  }
  throw new Error('Cookie consent modal was not available before page automation');
}

async function waitForHumanProgress(page, previousUrl, readySelector, message) {
  console.log(`[MANUAL] ${message}`);
  await page.waitForFunction((url, selector) => {
    if (location.href !== url) return true;
    const element = document.querySelector(selector);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden';
  }, { timeout: 600000 }, previousUrl, readySelector);
}

/**
 * 终端人机交互挂起，等待用户按 Enter 键继续
 * @param {string} promptMessage 
 * @returns {Promise<string>}
 */
function askEnterKey(promptMessage) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(promptMessage, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * 注入网页顶部的自动化提示 Banner
 * @param {puppeteer.Page} page 
 */
async function injectWarningBanner(page) {
  try {
    await page.evaluate(() => {
      if (document.getElementById('automation-warning-banner')) return;
      const banner = document.createElement('div');
      banner.id = 'automation-warning-banner';
      banner.textContent = '⚠️ 测试自动化运行中';
      banner.style.position = 'fixed';
      banner.style.top = '0';
      banner.style.left = '0';
      banner.style.width = '100%';
      banner.style.backgroundColor = '#ef4444';
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
    });
  } catch (e) {
    // 忽略页面跳转中导致的注入错误
  }
}

/**
 * 检测当前页面上是否存在可见的人机验证组件
 * @param {puppeteer.Page} page 
 * @returns {Promise<string|null>} 返回匹配到的验证码选择器，若无则返回 null
 */
async function detectCaptcha(page) {
  for (const selector of CAPTCHA_SELECTORS) {
    try {
      const element = await page.$(selector);
      if (element) {
        // 判断元素在当前页面上是否可见（高宽大于0且 display 不是 none）
        const isVisible = await page.evaluate((sel) => {
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
      // 容错处理，防止选择器语法或页面卸载导致的中断
    }
  }
  return null;
}

/**
 * 人机协同挂起与检查主逻辑
 * @param {puppeteer.Page} page 
 * @param {string} testName 
 */
async function handleCaptchaIntervention(page, testName) {
  let activeCaptchaSelector = await detectCaptcha(page);
  
  while (activeCaptchaSelector) {
    console.log(`\n========================================================`);
    console.log(`⚠️  [${testName}] 检测到页面包含人机验证挑战!`);
    console.log(`   触发选择器: "${activeCaptchaSelector}"`);
    console.log(`   👉 请切换到浏览器窗口，手动完成人机验证。`);
    console.log(`========================================================`);
    
    // 强制暂停并等待用户按下 Enter 键
    await askEnterKey('   完成验证后，在当前终端按下 [Enter] 键继续自动化执行...');
    
    // 给页面 2 秒反应时间让验证标记生效或 DOM 刷新
    console.log(`[INFO] [${testName}] 正在重新检测人机验证状态...`);
    await sleep(2000);
    
    activeCaptchaSelector = await detectCaptcha(page);
    if (activeCaptchaSelector) {
      console.log(`❌ 检测失败：验证码元素依然存在，请确认是否已成功通过验证并重试。`);
    } else {
      console.log(`✅ [${testName}] 验证已通过，继续自动化流程。\n`);
    }
  }
}

/**
 * 封装标准表单元素填充，包含输入触发和固定延迟
 * @param {puppeteer.Page} page 
 * @param {string} selector 
 * @param {string} text 
 */
async function fillStandardInput(page, selector, text) {
  await page.waitForSelector(selector, { visible: true, timeout: CONFIG.pageTimeoutMs });
  
  // 清空已有值
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.value = '';
  }, selector);

  // 逐字符模拟输入
  await page.type(selector, text, { delay: 50 });
  
  // 显式派发 input 和 change 事件以保证 SPA 框架获取到最新值
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, selector);
  
  await sleep(CONFIG.actionDelayMs);
}

/**
 * 从 Gmail 自动拉取未读邮件并提取 6 位验证码
 * @param {string} email 
 * @param {string} appPassword 
 * @param {string} testName 
 * @returns {Promise<string>}
 */
async function extractVerificationCodeFromEmail(email, appPassword, testName) {
  if (!email || !appPassword) {
    console.log(`[INFO] [${testName}] 未配置 Gmail IMAP 凭据，启用本地 mock 验证模式 (使用 123456)。`);
    return '123456';
  }

  console.log(`[INFO] [${testName}] 正在通过 IMAP 连接 Gmail 收件箱获取验证码...`);
  
  // 使用 imap-simple 获取邮件
  const imaps = require('imap-simple');
  const imapConfig = {
    imap: {
      user: email,
      password: appPassword,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 5000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  let connection;
  try {
    connection = await imaps.connect(imapConfig);
    await connection.openBox('INBOX');

    // 检索最近 10 分钟内的未读邮件
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const searchCriteria = [
      'UNSEEN',
      ['SINCE', tenMinutesAgo.toISOString()]
    ];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      markSeen: true // 读取后自动标记为已读
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    if (messages.length === 0) {
      throw new Error('未能在 Gmail 中找到最近未读的验证码邮件');
    }

    // 按邮件时间降序排序，取最新的一封
    messages.sort((a, b) => {
      const dateA = new Date(a.parts.find(p => p.which === 'HEADER').body.date[0]);
      const dateB = new Date(b.parts.find(p => p.which === 'HEADER').body.date[0]);
      return dateB - dateA;
    });

    const latestMsg = messages[0];
    const textPart = latestMsg.parts.find(part => part.which === 'TEXT');
    const body = textPart ? textPart.body : '';

    // 正则提取 6 位连续数字
    const codeMatch = body.match(/\b\d{6}\b/);
    if (!codeMatch) {
      throw new Error('成功读取最新邮件，但未在正文中解析到符合规则的 6 位数字验证码');
    }

    console.log(`[SUCCESS] [${testName}] 成功拉取并解析验证码: ${codeMatch[0]}`);
    return codeMatch[0];
  } catch (error) {
    console.error(`[ERROR] [${testName}] IMAP 获取验证码失败: ${error.message}`);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

/**
 * 进度管理：读取上次已成功处理的用户索引
 * @returns {number}
 */
function readProgress() {
  if (fs.existsSync(CONFIG.progressFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG.progressFile, 'utf8'));
      return data.lastCompletedIndex ?? -1;
    } catch (e) {
      console.warn(`[WARNING] 读取进度文件 ${CONFIG.progressFile} 失败，将从头开始运行。`);
    }
  }
  return -1;
}

/**
 * 进度管理：保存当前已成功处理的用户索引
 * @param {number} index 
 */
function saveProgress(index) {
  try {
    fs.writeFileSync(CONFIG.progressFile, JSON.stringify({ lastCompletedIndex: index }, null, 2), 'utf8');
  } catch (e) {
    console.error(`[ERROR] 保存运行进度失败: ${e.message}`);
  }
}

/**
 * 结果导出：读取现有报告并解析为数组以支持断点续写
 * @returns {Array<{testName: string, apiKey: string}>}
 */
function readExistingResults() {
  const results = [];
  if (fs.existsSync(CONFIG.resultsFile)) {
    try {
      const content = fs.readFileSync(CONFIG.resultsFile, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('|') && !trimmed.includes('Test Profile Name') && !trimmed.includes('---')) {
          const parts = trimmed.split('|').map(p => p.trim());
          if (parts.length >= 3) {
            results.push({
              testName: parts[1],
              apiKey: parts[2]
            });
          }
        }
      }
    } catch (e) {
      console.warn(`[WARNING] 读取现有报告 ${CONFIG.resultsFile} 失败，将生成新文件。`);
    }
  }
  return results;
}

/**
 * 结果导出：将所有结果以 Markdown 表格格式输出到文件
 * @param {Array<{testName: string, apiKey: string}>} results 
 */
function exportResults(results) {
  let markdown = `# Test Automation Results\n\n`;
  markdown += `*Generated at: ${new Date().toLocaleString()}*\n\n`;
  markdown += `| Test Profile Name | API Key (Test) |\n`;
  markdown += `|-------------------|----------------|\n`;
  
  for (const res of results) {
    markdown += `| ${res.testName} | ${res.apiKey} |\n`;
  }

  try {
    fs.writeFileSync(CONFIG.resultsFile, markdown, 'utf8');
    console.log(`[INFO] 测试报告已成功更新并输出至: ${CONFIG.resultsFile}`);
  } catch (e) {
    console.error(`[ERROR] 写入结果 Markdown 文件失败: ${e.message}`);
  }
}

// ==========================================
// 5. 核心运行主流程
// ==========================================
async function main() {
  console.log(`========================================================`);
  console.log(`🤖 启动测试自动化脚本 (Node.js + Puppeteer)`);
  console.log(`========================================================\n`);

  // A. 白名单域名安全检测
  if (!validateUrl(CONFIG.targetUrl)) {
    console.error(`❌ [安全终止] 目标 URL "${CONFIG.targetUrl}" 不符合沙箱/测试域名白名单!`);
    console.error(`   只允许在以下域名或其子域名下运行: ${JSON.stringify(CONFIG.allowedDomains)}`);
    process.exit(1);
  }

  // B. 读取历史进度与已有结果
  const lastCompletedIndex = readProgress();
  const accumulatedResults = readExistingResults();

  // C. 启动 Puppeteer 浏览器 (显示界面)
  const browser = await puppeteer.launch({
    headless: false, // 必须为 false 才能让人工看到浏览器并手动解决验证码
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--start-maximized'
    ]
  });

  const page = await browser.newPage();

  // D. 遍历测试用户队列
  for (let i = 0; i < TEST_USERS.length; i++) {
    const user = TEST_USERS[i];

    // 如果该用户在上次运行中已经完成，直接跳过
    if (i <= lastCompletedIndex) {
      console.log(`[SKIP] 用户 "${user.testName}" (索引: ${i}) 已于上次运行中成功处理，跳过。`);
      continue;
    }

    console.log(`\n--------------------------------------------------------`);
    console.log(`🚀 开始处理测试用户: ${user.testName} (进度: ${i + 1}/${TEST_USERS.length})`);
    console.log(`--------------------------------------------------------`);

    let userSuccess = false;
    let userApiKey = '';
    let attempt = 0;

    while (attempt <= CONFIG.maxRetries && !userSuccess) {
      attempt++;
      try {
        if (attempt > 1) {
          console.log(`[RETRY] 用户 "${user.testName}" 正在进行第 ${attempt - 1} 次重试...`);
        }

        // 1. 为当前测试用户清空浏览器状态，然后导航到注册页面
        await prepareCleanUserSession(page);
        page.removeAllListeners('domcontentloaded');
        await page.goto(CONFIG.targetUrl, {
          waitUntil: 'networkidle2',
          timeout: CONFIG.pageTimeoutMs
        });
        await dismissCookieBanner(page);
        await injectWarningBanner(page);
        page.on('domcontentloaded', async () => {
          await injectWarningBanner(page);
        });

        // 2. 检测是否存在初始验证码挑战
        await handleCaptchaIntervention(page, user.testName);

        // 3. 逐项填充标准注册表单
        console.log(`[INFO] 正在填充用户表单信息...`);
        await fillStandardInput(page, CONFIG.selectors.companyInput, user.testCompany);
        await fillStandardInput(page, CONFIG.selectors.emailInput, user.testEmail);
        await fillStandardInput(page, CONFIG.selectors.usernameInput, user.testUsername);
        await fillStandardInput(page, CONFIG.selectors.dobInput, user.testDOB);
        await fillStandardInput(page, CONFIG.selectors.passwordInput, user.testPassword);
        await fillStandardInput(page, CONFIG.selectors.cloudAccountInput, user.testCloudAccount);

        // 4. 仅等待人工提交；脚本绝不激活页面控件
        const registrationUrl = page.url();
        await waitForHumanProgress(
          page,
          registrationUrl,
          CONFIG.selectors.emailVerificationInput,
          '注册字段已填写，请在目标网页中人工检查并提交表单。'
        );

        // 5. 提交后检测验证码 (有些网站在提交表单后弹出人机挑战)
        await handleCaptchaIntervention(page, user.testName);

        // 6. 获取邮箱验证码并输入
        // 注：若未配置 Gmail 凭证，本步会自动返回 mock 验证码 "123456"
        const verificationCode = await extractVerificationCodeFromEmail(
          CONFIG.gmail.email,
          CONFIG.gmail.appPassword,
          user.testName
        );

        console.log(`[INFO] 正在输入邮箱验证码...`);
        await fillStandardInput(page, CONFIG.selectors.emailVerificationInput, verificationCode);
        const verificationUrl = page.url();
        await waitForHumanProgress(
          page,
          verificationUrl,
          CONFIG.selectors.apiKeyDisplay,
          '验证码已填写，请在目标网页中人工提交验证。'
        );

        // 7. 再次检测可能出现的验证码挑战
        await handleCaptchaIntervention(page, user.testName);

        // 8. 提取模拟生成的 API Key
        console.log(`[INFO] 正在等待提取模拟 API Key...`);
        await page.waitForSelector(CONFIG.selectors.apiKeyDisplay, { visible: true, timeout: CONFIG.pageTimeoutMs });
        userApiKey = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.textContent.trim() : '';
        }, CONFIG.selectors.apiKeyDisplay);

        if (!userApiKey) {
          throw new Error('未能在页面上找到有效的 API Key 内容');
        }

        console.log(`[SUCCESS] 成功提取到 API Key: "${userApiKey}"`);
        userSuccess = true;

      } catch (err) {
        console.error(`❌ [ERROR] 处理用户 "${user.testName}" 时发生异常: ${err.message}`);
        
        if (attempt > CONFIG.maxRetries) {
          console.error(`❌ 用户 "${user.testName}" 重试次数达到上限，标记为失败。`);
          userApiKey = `处理失败: ${err.message}`;
        } else {
          // 在下一次重试前等待 3 秒
          await sleep(3000);
        }
      }
    }

    // 记录本项用户结果（更新或新增）
    const existingIndex = accumulatedResults.findIndex(r => r.testName === user.testName);
    const resultObj = { testName: user.testName, apiKey: userApiKey };
    if (existingIndex !== -1) {
      accumulatedResults[existingIndex] = resultObj;
    } else {
      accumulatedResults.push(resultObj);
    }

    // 保存当前处理进度，并将已积累的结果导出
    saveProgress(i);
    exportResults(accumulatedResults);
  }

  // E. 流程收尾
  console.log(`\n========================================================`);
  console.log(`✅ 所有测试用户处理完毕！`);
  console.log(`   正在关闭浏览器窗口...`);
  console.log(`========================================================`);
  
  await browser.close();
  
  // 清理进度文件以便下次可以完整重新执行
  try {
    if (fs.existsSync(CONFIG.progressFile)) {
      fs.unlinkSync(CONFIG.progressFile);
    }
  } catch (e) {
    // 忽略删除进度文件时的异常
  }
}

// 启动执行
main().catch(err => {
  console.error(`🚨 脚本未捕获的致命错误:`, err);
  process.exit(1);
});
