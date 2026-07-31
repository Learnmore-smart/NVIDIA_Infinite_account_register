/**
 * Email verification-code fetcher for Gmail plus-addressing and IMAP.
 */

function parseVerificationCode(text) {
  if (!text) return null;
  const match = String(text).match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

function gmailBaseAddress(email) {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at <= 0) return value.toLowerCase();
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const plus = local.indexOf('+');
  const baseLocal = plus >= 0 ? local.slice(0, plus) : local;
  return `${baseLocal}@${domain}`.toLowerCase();
}

function messageMatchesRecipient(headers, toEmail) {
  const target = String(toEmail || '').trim().toLowerCase();
  if (!target) return false;
  const candidates = []
    .concat(headers.to || [])
    .concat(headers.deliveredTo || [])
    .concat(headers.cc || [])
    .map(v => String(v).toLowerCase());
  return candidates.some(value => value.includes(target));
}

function normalizeEmailConfig(raw = {}, env = process.env) {
  let provider = String(raw.provider || env.EMAIL_CODE_PROVIDER || 'auto').trim().toLowerCase();
  const mailbox = String(raw.mailbox || env.GMAIL_MAILBOX || env.TEST_GMAIL_EMAIL || '').trim();
  const clientId = String(raw.clientId || env.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = String(raw.clientSecret || env.GMAIL_CLIENT_SECRET || '').trim();
  const refreshToken = String(raw.refreshToken || env.GMAIL_REFRESH_TOKEN || '').trim();
  const imapUser = String(raw.imapUser || env.TEST_GMAIL_EMAIL || mailbox || '').trim();
  const imapPassword = String(raw.imapPassword || env.TEST_GMAIL_APP_PASSWORD || '').trim();
  const imapHost = String(raw.imapHost || env.GMAIL_IMAP_HOST || 'imap.gmail.com').trim();

  // Default "auto": pick gmail_api or imap purely from .env credentials.
  if (provider === 'auto' || provider === '') {
    if (clientId && clientSecret && refreshToken) provider = 'gmail_api';
    else if (imapUser && imapPassword) provider = 'imap';
    else provider = 'manual';
  }

  const gmailApiReady = provider === 'gmail_api' && Boolean(clientId && clientSecret && refreshToken);
  const imapReady = provider === 'imap' && Boolean(imapUser && imapPassword);
  const enabled = Boolean(gmailApiReady || imapReady);

  return {
    provider: enabled ? provider : 'manual',
    enabled,
    mailbox: mailbox || imapUser,
    clientId,
    clientSecret,
    refreshToken,
    imapUser,
    imapPassword,
    imapHost,
    pollIntervalMs: Number(raw.pollIntervalMs) > 0 ? Number(raw.pollIntervalMs) : 3000,
    timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 120000,
    queryFrom: String(raw.queryFrom || 'nvidia.com').trim()
  };
}

function headerList(payloadHeaders, name) {
  const wanted = String(name).toLowerCase();
  return (payloadHeaders || [])
    .filter(h => String(h.name || '').toLowerCase() === wanted)
    .map(h => h.value || '');
}

function decodeGmailBody(payload) {
  if (!payload) return '';
  const chunks = [];
  const walk = part => {
    if (!part) return;
    if (part.body?.data) {
      chunks.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return chunks.join('\n');
}

function createEmailCodeFetcher(rawConfig = {}, env = process.env) {
  const config = normalizeEmailConfig(rawConfig, env);
  const fetchImpl = rawConfig.fetchImpl || fetch;

  function isEnabled() {
    return config.enabled && config.provider !== 'manual';
  }

  async function getGmailAccessToken() {
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token'
      }).toString()
    });
    const json = await res.json();
    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description || json.error || 'Gmail OAuth token refresh failed');
    }
    return json.access_token;
  }

  async function findCodeViaGmailApi(toEmail, sinceMs) {
    const accessToken = await getGmailAccessToken();
    const afterEpoch = Math.floor((sinceMs || (Date.now() - 15 * 60 * 1000)) / 1000);
    const queryParts = [`after:${afterEpoch}`];
    if (config.queryFrom) queryParts.push(`from:${config.queryFrom}`);
    // Plus-addressing: also search the full To address when Gmail indexes it.
    queryParts.push(`(to:${toEmail} OR deliveredto:${toEmail} OR "${toEmail}")`);
    const q = encodeURIComponent(queryParts.join(' '));
    const listRes = await fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${q}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const listJson = await listRes.json();
    if (!listRes.ok) {
      throw new Error(listJson.error?.message || `Gmail list failed HTTP ${listRes.status}`);
    }
    const messages = listJson.messages || [];
    for (const message of messages) {
      const detailRes = await fetchImpl(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const detail = await detailRes.json();
      if (!detailRes.ok) continue;
      const headers = {
        to: headerList(detail.payload?.headers, 'To'),
        deliveredTo: headerList(detail.payload?.headers, 'Delivered-To'),
        cc: headerList(detail.payload?.headers, 'Cc')
      };
      if (!messageMatchesRecipient(headers, toEmail)) {
        // Still allow snippet match when Gmail search already scoped by to:
        // but prefer strict recipient match for multi-account safety.
        // For plus-addressing tests with only one mailbox, accept if body has code and query matched.
      }
      const bodyText = `${detail.snippet || ''}\n${decodeGmailBody(detail.payload)}`;
      if (messageMatchesRecipient(headers, toEmail) || bodyText.toLowerCase().includes(String(toEmail).toLowerCase())) {
        const code = parseVerificationCode(bodyText);
        if (code) return code;
      } else {
        const code = parseVerificationCode(bodyText);
        if (code && messages.length === 1) return code;
      }
    }
    return null;
  }

  async function findCodeViaImap(toEmail, sinceMs) {
    // Lazy require so projects without imap still load the module.
    let imaps;
    try {
      imaps = require('imap-simple');
    } catch (error) {
      throw new Error('IMAP provider requires the imap-simple package. Run: npm install imap-simple');
    }
    const connection = await imaps.connect({
      imap: {
        user: config.imapUser,
        password: config.imapPassword,
        host: config.imapHost,
        port: 993,
        tls: true,
        authTimeout: 10000,
        tlsOptions: { rejectUnauthorized: false }
      }
    });
    try {
      await connection.openBox('INBOX');
      const sinceDate = new Date(sinceMs || (Date.now() - 15 * 60 * 1000));
      const messages = await connection.search(
        ['UNSEEN', ['SINCE', sinceDate.toISOString()]],
        { bodies: ['HEADER', 'TEXT'], markSeen: false }
      );
      messages.sort((a, b) => {
        const dateA = new Date(a.parts.find(p => p.which === 'HEADER')?.body?.date?.[0] || 0);
        const dateB = new Date(b.parts.find(p => p.which === 'HEADER')?.body?.date?.[0] || 0);
        return dateB - dateA;
      });
      for (const message of messages) {
        const headerPart = message.parts.find(p => p.which === 'HEADER')?.body || {};
        const headers = {
          to: headerPart.to || [],
          deliveredTo: headerPart['delivered-to'] || [],
          cc: headerPart.cc || []
        };
        const text = message.parts.find(p => p.which === 'TEXT')?.body || '';
        if (!messageMatchesRecipient(headers, toEmail) && !String(text).toLowerCase().includes(String(toEmail).toLowerCase())) {
          continue;
        }
        const code = parseVerificationCode(text);
        if (code) return code;
      }
      return null;
    } finally {
      try { connection.end(); } catch (_) {}
    }
  }

  async function waitForCode({ toEmail, sinceMs } = {}) {
    if (!isEnabled()) return null;
    const deadline = Date.now() + config.timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const code = config.provider === 'imap'
          ? await findCodeViaImap(toEmail, sinceMs)
          : await findCodeViaGmailApi(toEmail, sinceMs);
        if (code) return code;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
    }
    if (lastError) throw lastError;
    return null;
  }

  return {
    isEnabled,
    waitForCode,
    config
  };
}

module.exports = {
  parseVerificationCode,
  gmailBaseAddress,
  messageMatchesRecipient,
  normalizeEmailConfig,
  createEmailCodeFetcher
};
