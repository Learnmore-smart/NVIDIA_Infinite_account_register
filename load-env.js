/**
 * Minimal .env loader (no dependency).
 * - Loads KEY=value into process.env (does not override already-set vars by default)
 * - Ignores blank lines, # comments, and bare nvapi-* lines written by ResultStore
 */

const fs = require('fs');
const path = require('path');

function parseEnvLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  // ResultStore historically appends bare keys like "nvapi-xxx"
  if (/^nvapi-[A-Za-z0-9_-]+$/.test(trimmed)) {
    return { bareApiKey: trimmed };
  }
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  let key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (!key) return null;
  // Strip surrounding quotes
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvFile(filePath, { override = false, env = process.env } = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { loaded: false, path: resolved, keys: [], bareApiKeys: 0 };
  }
  const content = fs.readFileSync(resolved, 'utf8');
  const keys = [];
  let bareApiKeys = 0;
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (parsed.bareApiKey) {
      bareApiKeys++;
      continue;
    }
    if (!override && env[parsed.key] !== undefined && env[parsed.key] !== '') continue;
    env[parsed.key] = parsed.value;
    keys.push(parsed.key);
  }
  return { loaded: true, path: resolved, keys, bareApiKeys };
}

function ensureEnvTemplate(filePath, templateLines) {
  const resolved = path.resolve(filePath);
  const existing = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
  const presentKeys = new Set();
  for (const line of existing.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed?.key) presentKeys.add(parsed.key);
  }
  const toAppend = [];
  for (const line of templateLines) {
    const parsed = parseEnvLine(line);
    if (!parsed?.key) {
      // Keep section comments only when file is new / we're adding a section
      continue;
    }
    if (!presentKeys.has(parsed.key)) {
      toAppend.push(line);
      presentKeys.add(parsed.key);
    }
  }
  if (toAppend.length === 0) {
    return { path: resolved, appended: [] };
  }
  const header = existing.trimEnd()
    ? `${existing.replace(/(?:\r\n|\n|\r)+$/, '')}\n\n# --- automation secrets (fill these) ---\n`
    : '# NovaPura automation secrets\n';
  fs.writeFileSync(resolved, `${header}${toAppend.join('\n')}\n`, 'utf8');
  return { path: resolved, appended: toAppend.map(l => parseEnvLine(l)?.key).filter(Boolean) };
}

const DEFAULT_ENV_TEMPLATE = [
  'CAPSOLVER_API_KEY=',
  'GMAIL_CLIENT_ID=',
  'GMAIL_CLIENT_SECRET=',
  'GMAIL_REFRESH_TOKEN=',
  'GMAIL_MAILBOX=',
  '# Optional IMAP fallback instead of Gmail API:',
  '# EMAIL_CODE_PROVIDER=imap',
  '# TEST_GMAIL_EMAIL=',
  '# TEST_GMAIL_APP_PASSWORD='
];

function bootstrapProjectEnv({
  workspaceDir = process.cwd(),
  envFileName = '.env',
  override = false,
  env = process.env
} = {}) {
  const envPath = path.join(workspaceDir, envFileName);
  ensureEnvTemplate(envPath, DEFAULT_ENV_TEMPLATE);
  return loadEnvFile(envPath, { override, env });
}

/**
 * Upsert KEY=value in a .env file and optionally process.env.
 * Preserves other lines (including bare nvapi-* keys).
 */
function upsertEnvKey(filePath, key, value, { env = process.env, syncProcessEnv = true } = {}) {
  const resolved = path.resolve(filePath);
  const name = String(key || '').trim();
  if (!name) throw new Error('Env key is required');
  const nextValue = value == null ? '' : String(value);
  const existing = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  let replaced = false;
  const out = lines.map(line => {
    const parsed = parseEnvLine(line);
    if (parsed?.key === name) {
      replaced = true;
      return `${name}=${nextValue}`;
    }
    return line;
  });
  if (!replaced) {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(`${name}=${nextValue}`);
  }
  // Avoid trailing empty explosion: join then ensure single trailing newline
  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(resolved, text, 'utf8');
  if (syncProcessEnv) env[name] = nextValue;
  return { path: resolved, key: name, value: nextValue };
}

module.exports = {
  parseEnvLine,
  loadEnvFile,
  ensureEnvTemplate,
  bootstrapProjectEnv,
  upsertEnvKey,
  DEFAULT_ENV_TEMPLATE
};
