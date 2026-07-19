const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const ParallelPuppeteerRunner = require('./parallel-runner');

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
app.get('/api/config', (req, res) => {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        targetUrl: 'http://127.0.0.1:3000/register',
        parallelism: 3
      }, null, 2), 'utf8');
    }
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    res.json({
      targetUrl: data.targetUrl || 'http://127.0.0.1:3000/register',
      parallelism: ParallelPuppeteerRunner.clampParallelism(data.parallelism)
    });
  } catch (err) {
    res.status(500).json({ error: '读取运行配置失败：' + err.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const config = {
      targetUrl: req.body.targetUrl,
      parallelism: ParallelPuppeteerRunner.clampParallelism(req.body.parallelism)
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '写入运行配置失败：' + err.message });
  }
});

// 3. Execution Control APIs
app.post('/api/run', (req, res) => {
  if (runStatus === 'running' || runStatus === 'waiting-captcha' || runStatus === 'waiting-code') {
    return res.status(400).json({ error: '自动化任务正在运行。' });
  }

  // Load latest configs from file
  let users = [];
  let automationConfig = {};
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    automationConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
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
