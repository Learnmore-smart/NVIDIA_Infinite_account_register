const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { bootstrapProjectEnv } = require('./load-env');
const {
  getGmailConnectionStatus,
  buildGoogleAuthUrl,
  completeGmailOAuth,
  renderOAuthResultPage
} = require('./gmail-oauth');
const ParallelPuppeteerRunner = require('./parallel-runner');

// Load CAPSOLVER_* / GMAIL_* (and friends) from project .env before any automation runs.
const envBootstrap = bootstrapProjectEnv({ workspaceDir: __dirname });
if (envBootstrap.loaded) {
  const secretHints = [
    envBootstrap.keys.includes('CAPSOLVER_API_KEY') || process.env.CAPSOLVER_API_KEY ? 'captcha' : null,
    (process.env.GMAIL_REFRESH_TOKEN || process.env.TEST_GMAIL_APP_PASSWORD) ? 'gmail' : null
  ].filter(Boolean);
  console.log(`[env] loaded ${path.basename(envBootstrap.path)}${secretHints.length ? ` (${secretHints.join(', ')} ready if keys set)` : ''}`);
}

const app = express();
const PORT = 8080;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration File Paths
const USERS_FILE = path.join(__dirname, 'users_config.json');
// Keep the legacy filename so existing target URL configuration is preserved.
const CONFIG_FILE = path.join(__dirname, 'gmail_config.json');
const RESULTS_FILE = path.join(__dirname, 'api_keys_test.md');

// State Tracking
let currentRunner = null;
let runStatus = 'idle'; // 'idle', 'running', 'waiting-captcha', 'waiting-code', 'completed', 'stopped'
let captchaState = { status: 'idle', selector: null, user: null };
let verificationCodeState = { status: 'idle', user: null };
let logHistory = [];
let sseClients = [];

// Helper: Broadcast to SSE clients
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(payload));
}

// Helper: Log message and broadcast
function appendLog(logObj) {
  logHistory.push(logObj);
  broadcast('log', logObj);
}

// 1. Manage Test Users API
app.get('/api/users', (req, res) => {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, '[]', 'utf8');
    }
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '读取用户配置失败：' + err.message });
  }
});

app.post('/api/users', (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: '用户数据必须是数组。' });
    }
    const users = req.body.map(user => {
      if (!user || typeof user !== 'object' || Array.isArray(user)) return user;
      const normalizedUser = { ...user };
      delete normalizedUser.testCloudAccount;
      return normalizedUser;
    });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '写入用户配置失败：' + err.message });
  }
});

app.delete('/api/users/:index', (req, res) => {
  try {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: '用户索引无效。' });
    }

    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!Array.isArray(users)) {
      return res.status(500).json({ error: '用户配置格式无效。' });
    }
    if (index >= users.length) {
      return res.status(404).json({ error: '要删除的用户不存在。' });
    }

    const [deletedUser] = users.splice(index, 1);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    res.json({ success: true, deletedUser });
  } catch (err) {
    res.status(500).json({ error: '删除用户配置失败：' + err.message });
  }
});

// 2. Manage Automation Config API
function readAutomationConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      targetUrl: 'https://build.nvidia.com/settings/api-keys',
      parallelism: 3,
      proxy: { enabled: false, provider: 'yiyuan', mode: 'gateway' },
      captcha: { provider: 'capsolver', apiKey: '', fallbackToHuman: true },
      email: { provider: 'manual' }
    }, null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function publicConfigView(data) {
  const captchaConfigured = Boolean(String(process.env.CAPSOLVER_API_KEY || '').trim());
  const gmailApiConfigured = Boolean(
    String(process.env.GMAIL_CLIENT_ID || '').trim()
    && String(process.env.GMAIL_CLIENT_SECRET || '').trim()
    && String(process.env.GMAIL_REFRESH_TOKEN || '').trim()
  );
  const imapConfigured = Boolean(
    String(process.env.TEST_GMAIL_EMAIL || process.env.GMAIL_MAILBOX || '').trim()
    && String(process.env.TEST_GMAIL_APP_PASSWORD || '').trim()
  );
  const gmailStatus = getGmailConnectionStatus(process.env);
  return {
    targetUrl: data.targetUrl || 'https://build.nvidia.com/settings/api-keys',
    parallelism: ParallelPuppeteerRunner.clampParallelism(data.parallelism),
    proxyEnabled: Boolean(data.proxy?.enabled),
    captchaConfigured,
    emailConfigured: gmailApiConfigured || imapConfigured,
    emailMode: gmailApiConfigured ? 'gmail_api' : (imapConfigured ? 'imap' : 'manual'),
    gmail: gmailStatus,
    secretsFrom: '.env'
  };
}

app.get('/api/config', (req, res) => {
  try {
    const data = readAutomationConfigFile();
    res.json(publicConfigView(data));
  } catch (err) {
    res.status(500).json({ error: '读取运行配置失败：' + err.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const existing = readAutomationConfigFile();
    const config = {
      ...existing,
      targetUrl: req.body.targetUrl ?? existing.targetUrl,
      parallelism: ParallelPuppeteerRunner.clampParallelism(
        req.body.parallelism ?? existing.parallelism
      )
    };
    // Only overwrite nested automation blocks when the client sends them.
    if (req.body.proxy && typeof req.body.proxy === 'object') {
      config.proxy = { ...(existing.proxy || {}), ...req.body.proxy };
    }
    if (req.body.captcha && typeof req.body.captcha === 'object') {
      config.captcha = { ...(existing.captcha || {}), ...req.body.captcha };
    }
    if (req.body.email && typeof req.body.email === 'object') {
      config.email = { ...(existing.email || {}), ...req.body.email };
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    res.json({ success: true, config: publicConfigView(config) });
  } catch (err) {
    res.status(500).json({ error: '写入运行配置失败：' + err.message });
  }
});

// 3. Execution Control APIs
app.post('/api/run', (req, res) => {
  if (runStatus === 'running' || runStatus === 'waiting-captcha' || runStatus === 'waiting-code') {
    return res.status(400).json({ error: '自动化任务正在运行。' });
  }

  // Load latest configs from file (includes proxy / captcha / email automation blocks).
  let users = [];
  let automationConfig = {};
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    automationConfig = readAutomationConfigFile();
    automationConfig.parallelism = ParallelPuppeteerRunner.clampParallelism(automationConfig.parallelism);
  } catch (err) {
    return res.status(500).json({ error: '加载配置失败：' + err.message });
  }

  if (users.length === 0) {
    return res.status(400).json({ error: '测试用户列表为空，请先添加用户。' });
  }

  // Reset states
  logHistory = [];
  runStatus = 'running';
  captchaState = { status: 'idle', selector: null, user: null };
  verificationCodeState = { status: 'idle', user: null };
  broadcast('status', { status: runStatus });

  currentRunner = new ParallelPuppeteerRunner({
    users,
    automationConfig,
    onLog: (logObj) => {
      appendLog(logObj);
    },
    onCaptchaRequired: (state) => {
      captchaState = state;
      if (state.status === 'waiting') {
        runStatus = 'waiting-captcha';
      } else if (state.status === 'resolved') {
        runStatus = 'running';
      }
      broadcast('status', { status: runStatus });
      broadcast('captcha', captchaState);
    },
    onVerificationCodeRequired: (state) => {
      verificationCodeState = state;
      if (state.status === 'waiting') {
        runStatus = 'waiting-code';
      } else if (state.status === 'resolved') {
        runStatus = 'running';
      }
      broadcast('status', { status: runStatus });
      broadcast('verification-code', verificationCodeState);
    },
    onFinished: () => {
      runStatus = currentRunner.isStopped ? 'stopped' : 'completed';
      captchaState = { status: 'idle', selector: null, user: null };
      verificationCodeState = { status: 'idle', user: null };
      currentRunner = null;
      broadcast('status', { status: runStatus });
      broadcast('captcha', captchaState);
      broadcast('verification-code', verificationCodeState);
    }
  });

  // Run in background asynchronously
  currentRunner.run().catch(err => {
    appendLog({ message: `🚨 后台自动化异常：${err.message}`, type: 'error', timestamp: new Date().toISOString() });
  });

  res.json({ success: true, message: '自动化已启动。' });
});

app.post('/api/stop', (req, res) => {
  if (currentRunner) {
    currentRunner.stop();
    res.json({ success: true, message: '正在停止自动化…' });
  } else {
    res.status(400).json({ error: '当前没有运行中的自动化任务。' });
  }
});

// 3b. Gmail OAuth (official Google consent screen)
app.get('/api/gmail/status', (req, res) => {
  try {
    res.json(getGmailConnectionStatus(process.env));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gmail/auth', (req, res) => {
  try {
    if (runStatus === 'running' || runStatus === 'waiting-captcha' || runStatus === 'waiting-code') {
      return res.status(400).send(renderOAuthResultPage({
        ok: false,
        title: '无法连接 Gmail',
        message: '自动化正在运行。请先停止任务，再连接 Gmail。'
      }));
    }
    const { url } = buildGoogleAuthUrl(process.env, { port: PORT });
    res.redirect(url);
  } catch (err) {
    res.status(400).send(renderOAuthResultPage({
      ok: false,
      title: '无法启动 Gmail 登录',
      message: err.message
    }));
  }
});

app.get('/api/gmail/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).send(renderOAuthResultPage({
        ok: false,
        title: 'Gmail 授权已取消',
        message: String(req.query.error_description || req.query.error)
      }));
    }
    const result = await completeGmailOAuth({
      code: req.query.code,
      state: req.query.state,
      workspaceDir: __dirname
    });
    const mailboxText = result.mailbox ? `已绑定邮箱：${result.mailbox}` : '已保存 refresh token。';
    res.send(renderOAuthResultPage({
      ok: true,
      title: 'Gmail 连接成功',
      message: `${mailboxText} 可关闭此窗口并返回控制台。`
    }));
  } catch (err) {
    res.status(400).send(renderOAuthResultPage({
      ok: false,
      title: 'Gmail 连接失败',
      message: err.message
    }));
  }
});

// 4. SSE Log Stream Endpoint
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  res.write('\n');
  sseClients.push(res);

  // Send current states and logs instantly
  res.write(`event: status\ndata: ${JSON.stringify({ status: runStatus })}\n\n`);
  res.write(`event: captcha\ndata: ${JSON.stringify(captchaState)}\n\n`);
  res.write(`event: verification-code\ndata: ${JSON.stringify(verificationCodeState)}\n\n`);
  logHistory.forEach(logObj => {
    res.write(`event: log\ndata: ${JSON.stringify(logObj)}\n\n`);
  });

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// 5. Read Results API
app.get('/api/results', (req, res) => {
  if (!fs.existsSync(RESULTS_FILE)) {
    return res.json([]);
  }
  try {
    const content = fs.readFileSync(RESULTS_FILE, 'utf8');
    const lines = content.split('\n');
    const results = [];
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
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: '读取结果失败：' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[成功] Web 控制台运行于 http://localhost:${PORT}`);
});
