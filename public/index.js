// Global States
let usersList = [];
let automationConfig = {};
let sseSource = null;
let completedTestNames = new Set();
const interventionStates = {
  captcha: { status: 'idle' },
  'verification-code': { status: 'idle' }
};

// DOM Elements
const elStatusPill = document.getElementById('runner-status-pill');
const elBtnRun = document.getElementById('btn-run');
const elBtnStop = document.getElementById('btn-stop');
const elConfigForm = document.getElementById('config-form');
const elTargetUrl = document.getElementById('targetUrl');
const elParallelism = document.getElementById('parallelism');
const elUsersList = document.getElementById('users-list');
const elTerminalLogs = document.getElementById('terminal-logs');
const elResultsTableBody = document.getElementById('results-table-body');
const elInterventionNotice = document.getElementById('intervention-notice');
const elInterventionNoticeIcon = document.getElementById('intervention-notice-icon');
const elInterventionNoticeTitle = document.getElementById('intervention-notice-title');
const elInterventionNoticeMessage = document.getElementById('intervention-notice-message');
const elAddUserFormContainer = document.getElementById('add-user-form-container');
const elAddUserForm = document.getElementById('add-user-form');
const elGmailStatus = document.getElementById('gmail-status');
const elBtnGmailConnect = document.getElementById('btn-gmail-connect');

// Initialize On Load
window.addEventListener('DOMContentLoaded', () => {
  loadUsers();
  loadConfig();
  loadResults();
  setupSSE();
  loadGmailStatus();
  
  // Bind Forms
  elConfigForm.addEventListener('submit', handleConfigSave);
  elAddUserForm.addEventListener('submit', handleAddUser);
  elBtnRun.addEventListener('click', handleRun);
  elBtnStop.addEventListener('click', handleStop);
  if (elBtnGmailConnect) {
    elBtnGmailConnect.addEventListener('click', handleGmailConnect);
  }
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === 'gmail-oauth') {
      loadGmailStatus();
      if (event.data.ok) {
        // Soft success notice without blocking the whole dashboard.
        if (elGmailStatus) {
          elGmailStatus.textContent = '✅ Gmail 授权完成，正在刷新状态…';
        }
      }
    }
  });
});

// ==========================================
// 1. Config & User CRUD Management
// ==========================================

async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    usersList = await res.json();
    renderUsers();
  } catch (err) {
    console.error('加载用户失败', err);
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    automationConfig = await res.json();
    elTargetUrl.value = automationConfig.targetUrl || 'https://build.nvidia.com/settings/api-keys';
    elParallelism.value = automationConfig.parallelism ?? 3;
    if (automationConfig.gmail) {
      renderGmailStatus(automationConfig.gmail);
    }
  } catch (err) {
    console.error('加载配置失败', err);
  }
}

function renderGmailStatus(status) {
  if (!elGmailStatus) return;
  elGmailStatus.classList.remove('gmail-status-idle', 'gmail-status-ok', 'gmail-status-warn');
  if (!status || !status.clientConfigured) {
    elGmailStatus.classList.add('gmail-status-warn');
    elGmailStatus.textContent = '⚠️ 请先在 .env 填写 GMAIL_CLIENT_ID 与 GMAIL_CLIENT_SECRET';
    if (elBtnGmailConnect) elBtnGmailConnect.disabled = true;
    return;
  }
  if (elBtnGmailConnect) elBtnGmailConnect.disabled = false;
  if (status.connected) {
    elGmailStatus.classList.add('gmail-status-ok');
    const mailbox = status.mailbox ? `（${status.mailbox}）` : '';
    elGmailStatus.textContent = `✅ 已连接 Gmail${mailbox}，可自动读取验证码`;
  } else {
    elGmailStatus.classList.add('gmail-status-idle');
    elGmailStatus.textContent = '尚未授权。点击下方按钮使用 Google 官方登录。';
  }
}

async function loadGmailStatus() {
  try {
    const res = await fetch('/api/gmail/status');
    const status = await res.json();
    renderGmailStatus(status);
  } catch (err) {
    if (elGmailStatus) {
      elGmailStatus.classList.add('gmail-status-warn');
      elGmailStatus.textContent = '无法读取 Gmail 状态：' + err.message;
    }
  }
}

function handleGmailConnect() {
  // Open official Google OAuth in a popup (falls back to same tab if blocked).
  const authUrl = '/api/gmail/auth';
  const popup = window.open(
    authUrl,
    'novapura-gmail-oauth',
    'width=520,height=720,menubar=no,toolbar=no,status=no'
  );
  if (!popup) {
    window.location.href = authUrl;
    return;
  }
  // When popup closes, refresh status (postMessage also handles success).
  const timer = setInterval(() => {
    if (popup.closed) {
      clearInterval(timer);
      loadGmailStatus();
    }
  }, 800);
}

async function handleConfigSave(e) {
  e.preventDefault();
  const config = {
    targetUrl: elTargetUrl.value.trim(),
    parallelism: Math.min(5, Math.max(1, Number.parseInt(elParallelism.value, 10) || 3))
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const data = await res.json();
    if (data.success) {
      alert('✅ 配置保存成功！');
      automationConfig = config;
    } else {
      alert('❌ 配置保存失败：' + data.error);
    }
  } catch (err) {
    alert('❌ 发送配置请求失败：' + err.message);
  }
}

function renderUsers() {
  elUsersList.innerHTML = '';
  if (usersList.length === 0) {
    elUsersList.innerHTML = `<div class="card" style="grid-column: 1/-1; text-align: center; color: var(--text-secondary);">尚未添加测试用户，请点击上方“添加测试用户”。</div>`;
    return;
  }

  usersList.forEach((user, index) => {
    const isComplete = completedTestNames.has(user.testName);
    const card = document.createElement('div');
    card.className = `card user-card${isComplete ? ' user-card-complete' : ''}`;
    card.innerHTML = `
      <div class="user-card-header">
        <h4>👤 ${user.testName}</h4>
        <div class="user-card-actions">
          ${isComplete ? '<span class="user-completion-badge">✓ Done</span>' : ''}
          <button class="btn-delete-user" onclick="deleteUser(${index})" title="删除用户">🗑️</button>
        </div>
      </div>
      <div class="user-details">
        <p><strong>公司：</strong> ${user.testCompany}</p>
        <p><strong>邮箱：</strong> ${user.testEmail}</p>
        <p><strong>用户名：</strong> ${user.testUsername}</p>
        <p><strong>出生日期：</strong> ${user.testDOB}</p>
        <p><strong>密码：</strong> ${user.testPassword}</p>
      </div>
    `;
    elUsersList.appendChild(card);
  });
}

async function handleAddUser(e) {
  e.preventDefault();
  
  const newUser = {
    testName: document.getElementById('user-testName').value.trim(),
    testCompany: document.getElementById('user-testCompany').value.trim(),
    testEmail: document.getElementById('user-testEmail').value.trim(),
    testUsername: document.getElementById('user-testUsername').value.trim(),
    testDOB: document.getElementById('user-testDOB').value,
    testPassword: document.getElementById('user-testPassword').value.trim()
  };

  usersList.push(newUser);

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(usersList)
    });
    const data = await res.json();
    if (data.success) {
      renderUsers();
      elAddUserForm.reset();
      toggleAddUserForm();
    } else {
      usersList.pop();
      alert('❌ 保存用户失败：' + data.error);
    }
  } catch (err) {
    usersList.pop();
    alert('❌ 保存用户时发生错误：' + err.message);
  }
}

async function deleteUser(index) {
  if (!confirm('确定要删除这个测试用户吗？')) return;

  try {
    const res = await fetch(`/api/users/${index}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      usersList.splice(index, 1);
      renderUsers();
    } else {
      alert('❌ 删除用户失败：' + data.error);
    }
  } catch (err) {
    alert('❌ 删除用户时发生错误：' + err.message);
  }
}

function toggleAddUserForm() {
  elAddUserFormContainer.classList.toggle('hidden');
}

// ==========================================
// 2. Tab Navigation
// ==========================================
function switchTab(tabId) {
  const sections = document.querySelectorAll('.tab-section');
  sections.forEach(sec => sec.classList.add('hidden'));
  document.getElementById(tabId).classList.remove('hidden');

  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => btn.classList.remove('active'));
  
  // Find matching tab button to add active class
  event.target.classList.add('active');

  // Load results if result tab is active
  if (tabId === 'tab-results') {
    loadResults();
  }
}

// ==========================================
// 3. Execution Logs & SSE Communication
// ==========================================

function setupSSE() {
  if (sseSource) {
    sseSource.close();
  }

  sseSource = new EventSource('/api/logs');

  sseSource.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    updateStatusUI(data.status);
  });

  sseSource.addEventListener('captcha', (e) => {
    const data = JSON.parse(e.data);
    updateInterventionNotice({ kind: 'captcha', state: data });
  });

  sseSource.addEventListener('verification-code', (e) => {
    const data = JSON.parse(e.data);
    updateInterventionNotice({ kind: 'verification-code', state: data });
  });

  sseSource.addEventListener('log', (e) => {
    const logObj = JSON.parse(e.data);
    appendLogLine(logObj);
  });

  sseSource.onerror = (err) => {
    console.error('SSE 连接异常，正在重连…', err);
  };
}

function updateStatusUI(status) {
  // Update Pill class
  elStatusPill.className = `status-pill status-${status}`;
  
  const statusText = {
    idle: '空闲',
    running: '运行中',
    'waiting-captcha': '⚠️ 请人工干预',
    'waiting-code': '✉️ 请输入验证码',
    completed: '已完成',
    stopped: '已停止'
  };
  elStatusPill.textContent = statusText[status] || status;

  // Enable/Disable Controls
  const isActive = status === 'running' || status === 'waiting-captcha' || status === 'waiting-code';
  if (isActive) {
    elBtnRun.disabled = true;
    elBtnStop.disabled = false;
  } else {
    elBtnRun.disabled = false;
    elBtnStop.disabled = true;
  }
  // Refresh results when execution completes/stops
  if (status === 'completed' || status === 'stopped') {
    loadResults();
  }
}

function updateInterventionNotice({ kind, state }) {
  interventionStates[kind] = state;
  const codeState = interventionStates['verification-code'];
  const captchaState = interventionStates.captcha;
  const codeActive = codeState.status === 'waiting';
  const captchaActive = captchaState.status === 'waiting' || captchaState.status === 'checking';
  const active = codeActive
    ? { kind: 'verification-code', state: codeState }
    : captchaActive
      ? { kind: 'captcha', state: captchaState }
      : null;

  if (!active) {
    elInterventionNotice.classList.add('hidden');
    return;
  }

  const isCaptcha = active.kind === 'captcha';
  elInterventionNotice.className = `intervention-notice ${isCaptcha ? 'notice-captcha' : 'notice-code'}`;
  elInterventionNoticeIcon.textContent = isCaptcha ? '⚠️' : '✉️';
  elInterventionNoticeTitle.textContent = isCaptcha
    ? '请在目标网页完成人机验证'
    : '请在目标网页输入邮箱验证码';
  const userPrefix = active.state.user ? `用户 ${active.state.user}：` : '';
  elInterventionNoticeMessage.textContent = userPrefix + (active.state.message || '完成后系统会自动继续。');
}

function appendLogLine(logObj) {
  const line = document.createElement('div');
  line.className = `log-line log-${logObj.type}`;
  
  // Format: [HH:MM:SS] Message
  const time = new Date(logObj.timestamp).toLocaleTimeString();
  line.textContent = `[${time}] ${logObj.message}`;
  
  elTerminalLogs.appendChild(line);
  elTerminalLogs.scrollTop = elTerminalLogs.scrollHeight;
}

function clearLocalLogs() {
  elTerminalLogs.innerHTML = `<div class="log-line log-info">日志已清空。</div>`;
}

// ==========================================
// 4. Execution Actions
// ==========================================

async function handleRun() {
  if (usersList.length === 0) {
    alert('⚠️ 请至少添加一个测试用户后再开始！');
    return;
  }
  clearLocalLogs();
  appendLogLine({ message: '正在启动 Puppeteer Runner…', type: 'info', timestamp: new Date() });
  
  try {
    const res = await fetch('/api/run', { method: 'POST' });
    const data = await res.json();
    if (!data.success) {
      alert('❌ 启动自动化失败：' + data.error);
    }
  } catch (err) {
    alert('❌ 启动自动化时发生网络错误：' + err.message);
  }
}

async function handleStop() {
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    const data = await res.json();
    if (!data.success) {
      alert('❌ 停止自动化失败：' + data.error);
    }
  } catch (err) {
    alert('❌ 停止自动化时发生网络错误：' + err.message);
  }
}

async function loadResults() {
  try {
    const res = await fetch('/api/results');
    const results = await res.json();
    completedTestNames = new Set(results
      .filter(result => typeof result.apiKey === 'string' && result.apiKey.startsWith('nvapi-'))
      .map(result => result.testName));
    renderUsers();
    renderResults(results);
  } catch (err) {
    console.error('加载结果失败', err);
  }
}

function renderResults(results) {
  elResultsTableBody.innerHTML = '';
  if (results.length === 0) {
    elResultsTableBody.innerHTML = `<tr><td colspan="2" class="text-center">尚无结果，请先运行自动化。</td></tr>`;
    return;
  }

  results.forEach(res => {
    const row = document.createElement('tr');
    
    // Style failed keys
    const isFailed = res.apiKey.startsWith('处理失败');
    const keyStyle = isFailed ? 'color: var(--rose); font-weight: 500;' : 'font-family: monospace; color: var(--emerald); font-weight: 600;';
    
    row.innerHTML = `
      <td><strong>${res.testName}</strong></td>
      <td style="${keyStyle}">${res.apiKey}</td>
    `;
    elResultsTableBody.appendChild(row);
  });
}
