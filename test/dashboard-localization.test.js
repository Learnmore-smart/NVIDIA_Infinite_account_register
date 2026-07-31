const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(root, 'public', 'index.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'index.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('dashboard uses Chinese copy and a passive intervention notice', () => {
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /id="intervention-notice"/);
  assert.match(html, /请在自动打开的网页中完成操作/);
  assert.doesNotMatch(html, /modal-overlay|verification-code-input|我已完成，立即检查|提交并继续/);
  assert.doesNotMatch(html, /HUMAN CAPTCHA REQUIRED|I've Solved It|Runner Status|Start Automation/);
  assert.match(html, /Gmail/);
  assert.match(html, /API Key/);
  assert.match(html, /NVIDIA/);
});

test('dashboard renders captcha and email-code states as passive notices', () => {
  assert.match(client, /updateInterventionNotice/);
  assert.match(client, /kind: 'captcha'/);
  assert.match(client, /kind: 'verification-code'/);
  assert.match(client, /classList\.add\('hidden'\)/);
  assert.doesNotMatch(client, /handleCaptchaResolved|handleVerificationCodeSubmit|fetch\('\/api\/(?:captcha-solved|verification-code)'/);
  assert.match(css, /\.intervention-notice\.notice-captcha/);
  assert.match(css, /\.intervention-notice\.notice-code/);
});

test('server only broadcasts intervention state and exposes no intervention POST endpoints', () => {
  assert.match(server, /broadcast\('captcha', captchaState\)/);
  assert.match(server, /broadcast\('verification-code'/);
  assert.doesNotMatch(server, /app\.post\('\/api\/(?:captcha-solved|verification-code)'/);
  assert.doesNotMatch(server, /resolveVerificationCode/);
});

test('dashboard exposes Google OAuth Gmail connect button', () => {
  assert.match(html, /id="btn-gmail-connect"/);
  assert.match(html, /用 Google 登录并连接 Gmail/);
  assert.match(html, /id="gmail-status"/);
  assert.match(client, /handleGmailConnect|\/api\/gmail\/auth/);
  assert.match(client, /loadGmailStatus|\/api\/gmail\/status/);
  assert.match(server, /\/api\/gmail\/auth/);
  assert.match(server, /\/api\/gmail\/callback/);
  assert.match(server, /buildGoogleAuthUrl|completeGmailOAuth/);
  // Legacy Edge-profile Gmail bootstrap stays removed.
  assert.doesNotMatch(server, /launchGmailLoginBrowser|\/api\/gmail-login/);
});

test('dashboard uses company as the only NVIDIA account-name field', () => {
  assert.match(html, /<label>公司<\/label>[\s\S]*id="user-testCompany"/);
  assert.doesNotMatch(html, /Cloud Account|testCloudAccount/);
  assert.doesNotMatch(client, /Cloud Account|testCloudAccount/);
});

test('dashboard marks users Done only from persisted successful API keys', () => {
  assert.match(client, /completedTestNames = new Set/);
  assert.match(client, /apiKey\.startsWith\('nvapi-'\)/);
  assert.match(client, /user-completion-badge/);
  assert.match(css, /\.user-card\.user-card-complete/);
  assert.match(css, /\.user-completion-badge/);
});

test('dashboard saves an isolated-window concurrency setting from one through five', () => {
  assert.match(html, /<label for="parallelism">[^<]*1[^<]*5[^<]*<\/label>/);
  assert.match(html, /id="parallelism"[^>]*type="number"[^>]*min="1"[^>]*max="5"[^>]*value="3"/);
  assert.match(client, /const elParallelism = document\.getElementById\('parallelism'\)/);
  assert.match(client, /elParallelism\.value = automationConfig\.parallelism \?\? 3/);
  assert.match(client, /parallelism:\s*Math\.min\(5, Math\.max\(1, Number\.parseInt\(elParallelism\.value, 10\) \|\| 3\)\)/);
});

test('server uses the parallel orchestrator and normalizes concurrency authoritatively', () => {
  assert.match(server, /const ParallelPuppeteerRunner = require\('\.\/parallel-runner'\)/);
  assert.match(server, /new ParallelPuppeteerRunner\(/);
  assert.doesNotMatch(server, /new PuppeteerRunner\(/);
  assert.match(server, /ParallelPuppeteerRunner\.clampParallelism/);
  assert.match(server, /parallelism:/);
});
