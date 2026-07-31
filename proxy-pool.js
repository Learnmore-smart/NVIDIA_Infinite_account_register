/**
 * Sticky residential proxy sessions for Chrome workers.
 * Supports yiyuan.co-style gateway credentials and generic API extract endpoints.
 */

function normalizeProxyConfig(raw = {}, env = process.env) {
  const enabled = Boolean(raw.enabled);
  const mode = raw.mode === 'api_extract' ? 'api_extract' : 'gateway';
  const server = String(raw.server || env.YIYUAN_PROXY_SERVER || '').trim();
  const extractUrl = String(raw.extractUrl || env.YIYUAN_PROXY_EXTRACT_URL || '').trim();
  const usernameTemplate = String(
    raw.usernameTemplate || env.YIYUAN_PROXY_USERNAME_TEMPLATE || '{username}-session-{sessionId}'
  ).trim();
  const fallbackUsername = String(raw.username || env.YIYUAN_PROXY_USERNAME || '').trim();
  const password = String(raw.password || env.YIYUAN_PROXY_PASSWORD || '').trim();
  const protocol = String(raw.protocol || 'http').trim().toLowerCase() === 'socks5' ? 'socks5' : 'http';

  return {
    enabled,
    mode,
    server,
    extractUrl,
    usernameTemplate,
    fallbackUsername,
    password,
    protocol,
    provider: String(raw.provider || 'yiyuan')
  };
}

function parseExtractedProxyLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('#') || text.startsWith('{')) return null;
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const host = parts[0].trim();
  const port = parts[1].trim();
  if (!host || !/^\d+$/.test(port)) return null;
  if (parts.length >= 4) {
    return {
      host,
      port,
      username: parts[2],
      password: parts.slice(3).join(':')
    };
  }
  return { host, port, username: '', password: '' };
}

function applyTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (
    values[key] != null ? String(values[key]) : ''
  ));
}

function buildPuppeteerProxy(protocol, hostPort) {
  const cleaned = String(hostPort || '').replace(/^(https?|socks5):\/\//i, '');
  return `${protocol}://${cleaned}`;
}

function buildProxyLaunchArgs(session) {
  if (!session || !session.enabled || !session.puppeteerProxy) return [];
  return [`--proxy-server=${session.puppeteerProxy}`];
}

async function createProxySession(rawConfig, meta = {}) {
  const config = normalizeProxyConfig(rawConfig, meta.env || process.env);
  const sessionId = String(meta.sessionId || `s${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const fetchImpl = meta.fetchImpl || fetch;

  if (!config.enabled) {
    return { enabled: false, sessionId };
  }

  if (config.mode === 'api_extract') {
    if (!config.extractUrl) {
      return { enabled: false, sessionId, reason: 'missing extractUrl' };
    }
    const url = applyTemplate(config.extractUrl, {
      sessionId,
      testName: meta.testName || '',
      username: config.fallbackUsername,
      password: config.password
    });
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Proxy extract HTTP ${response.status}`);
    }
    const body = await response.text();
    const line = body.split(/\r?\n/).map(parseExtractedProxyLine).find(Boolean);
    if (!line) {
      throw new Error('Proxy extract returned no usable host:port lines');
    }
    const username = line.username || config.fallbackUsername;
    const password = line.password || config.password;
    const puppeteerProxy = buildPuppeteerProxy(config.protocol, `${line.host}:${line.port}`);
    return {
      enabled: true,
      sessionId,
      server: `${line.host}:${line.port}`,
      username,
      password,
      puppeteerProxy,
      authenticate: username || password ? { username, password } : null,
      provider: config.provider,
      mode: config.mode
    };
  }

  if (!config.server) {
    return { enabled: false, sessionId, reason: 'missing server' };
  }

  const username = applyTemplate(config.usernameTemplate, {
    sessionId,
    testName: meta.testName || '',
    username: config.fallbackUsername
  }) || config.fallbackUsername;

  if (!username && !config.password) {
    // Allow open proxies (rare) but still require a server.
  }

  const puppeteerProxy = buildPuppeteerProxy(config.protocol, config.server);
  return {
    enabled: true,
    sessionId,
    server: config.server,
    username,
    password: config.password,
    puppeteerProxy,
    authenticate: username || config.password
      ? { username: username || '', password: config.password || '' }
      : null,
    provider: config.provider,
    mode: 'gateway'
  };
}

module.exports = {
  normalizeProxyConfig,
  parseExtractedProxyLine,
  createProxySession,
  buildProxyLaunchArgs,
  applyTemplate
};
