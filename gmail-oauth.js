/**
 * Gmail OAuth 2.0 helpers: Google official consent screen → refresh token → .env
 */

const crypto = require('crypto');
const path = require('path');
const { upsertEnvKey } = require('./load-env');

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const OPENID_EMAIL_SCOPE = 'openid email';
const DEFAULT_SCOPES = `${GMAIL_READONLY_SCOPE} ${OPENID_EMAIL_SCOPE}`;

// In-memory OAuth state (single-operator local console).
const pendingStates = new Map();

function getGmailOAuthConfig(env = process.env, options = {}) {
  const clientId = String(env.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = String(env.GMAIL_CLIENT_SECRET || '').trim();
  const port = Number(options.port || env.PORT || 8080);
  const redirectUri = String(
    options.redirectUri
    || env.GMAIL_REDIRECT_URI
    || `http://localhost:${port}/api/gmail/callback`
  ).trim();
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes: String(options.scopes || DEFAULT_SCOPES).trim(),
    ready: Boolean(clientId && clientSecret)
  };
}

function getGmailConnectionStatus(env = process.env) {
  const config = getGmailOAuthConfig(env);
  const refreshToken = String(env.GMAIL_REFRESH_TOKEN || '').trim();
  const mailbox = String(env.GMAIL_MAILBOX || env.TEST_GMAIL_EMAIL || '').trim();
  return {
    clientConfigured: config.ready,
    connected: Boolean(config.ready && refreshToken),
    mailbox: mailbox || null,
    redirectUri: config.redirectUri,
    hasRefreshToken: Boolean(refreshToken)
  };
}

function createOAuthState() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { createdAt: Date.now() });
  // Drop stale states (>15 min)
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, value] of pendingStates.entries()) {
    if (value.createdAt < cutoff) pendingStates.delete(key);
  }
  return state;
}

function consumeOAuthState(state) {
  if (!state || !pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}

function buildGoogleAuthUrl(env = process.env, options = {}) {
  const config = getGmailOAuthConfig(env, options);
  if (!config.ready) {
    throw new Error('请先在 .env 中配置 GMAIL_CLIENT_ID 与 GMAIL_CLIENT_SECRET（Google Cloud OAuth 客户端）。');
  }
  const state = createOAuthState();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes,
    access_type: 'offline',
    // Force consent so Google returns a refresh_token even on re-login.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state,
    redirectUri: config.redirectUri
  };
}

async function exchangeCodeForTokens(code, env = process.env, options = {}) {
  const config = getGmailOAuthConfig(env, options);
  if (!config.ready) {
    throw new Error('Gmail OAuth 客户端未配置');
  }
  const fetchImpl = options.fetchImpl || fetch;
  const body = new URLSearchParams({
    code: String(code || ''),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code'
  });
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `Token exchange failed HTTP ${res.status}`);
  }
  return json;
}

async function fetchGoogleEmail(accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const res = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || `userinfo failed HTTP ${res.status}`);
  }
  return String(json.email || '').trim() || null;
}

async function completeGmailOAuth({
  code,
  state,
  workspaceDir = process.cwd(),
  env = process.env,
  envFileName = '.env',
  fetchImpl
} = {}) {
  if (!consumeOAuthState(state)) {
    throw new Error('OAuth state 无效或已过期，请从控制台重新点击“连接 Gmail”。');
  }
  if (!code) {
    throw new Error('Google 未返回授权 code');
  }
  const tokens = await exchangeCodeForTokens(code, env, { fetchImpl });
  const refreshToken = String(tokens.refresh_token || '').trim();
  if (!refreshToken) {
    // Google may omit refresh_token if user already consented before without prompt=consent.
    throw new Error('未拿到 refresh_token。请撤销应用访问权限后重试，或确认 OAuth 客户端类型正确。');
  }
  const envPath = path.join(workspaceDir, envFileName);
  upsertEnvKey(envPath, 'GMAIL_REFRESH_TOKEN', refreshToken, { env });

  let mailbox = null;
  try {
    mailbox = await fetchGoogleEmail(tokens.access_token, { fetchImpl });
    if (mailbox) {
      upsertEnvKey(envPath, 'GMAIL_MAILBOX', mailbox, { env });
    }
  } catch (error) {
    // Mailbox is optional; refresh token is enough to read mail.
  }

  return {
    success: true,
    mailbox,
    connected: true
  };
}

function renderOAuthResultPage({ ok, title, message }) {
  const color = ok ? '#16a34a' : '#dc2626';
  const safeTitle = String(title || '').replace(/</g, '&lt;');
  const safeMessage = String(message || '').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 28px 32px; max-width: 440px; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 12px; color: ${color}; }
    p { margin: 0 0 20px; line-height: 1.5; color: #cbd5e1; }
    a { color: #38bdf8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <p><a href="/">返回控制台</a></p>
  </div>
  <script>
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'gmail-oauth', ok: ${ok ? 'true' : 'false'} }, window.location.origin);
      }
    } catch (e) {}
    setTimeout(function () {
      try { window.close(); } catch (e) {}
    }, 1500);
  </script>
</body>
</html>`;
}

module.exports = {
  GMAIL_READONLY_SCOPE,
  getGmailOAuthConfig,
  getGmailConnectionStatus,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleEmail,
  completeGmailOAuth,
  renderOAuthResultPage,
  createOAuthState,
  consumeOAuthState,
  // test helper
  _pendingStates: pendingStates
};
