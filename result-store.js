const fs = require('fs');
const path = require('path');

const API_KEY_PATTERN = /nvapi-[A-Za-z0-9_-]+/;

function extractApiKeys(markdown) {
  const keys = [];
  const seen = new Set();
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = line.match(API_KEY_PATTERN);
    if (match && !seen.has(match[0])) {
      seen.add(match[0]);
      keys.push(match[0]);
    }
  }
  return keys;
}

function isSuccessfulResult(result) {
  return Boolean(
    result
    && typeof result.testName === 'string'
    && result.testName.trim()
    && typeof result.apiKey === 'string'
    && result.apiKey.startsWith('nvapi-')
  );
}

function testUserNumber(testName) {
  const match = /^test_user_(\d+)$/.exec(testName);
  return match ? Number.parseInt(match[1], 10) : null;
}

function sortResults(results) {
  return [...results].sort((left, right) => {
    const leftNumber = testUserNumber(left.testName);
    const rightNumber = testUserNumber(right.testName);
    if (leftNumber === null && rightNumber === null) return 0;
    if (leftNumber === null) return -1;
    if (rightNumber === null) return 1;
    return leftNumber - rightNumber;
  });
}

class ResultStore {
  constructor({ resultsFile, envFile, fsImpl = fs } = {}) {
    if (!resultsFile) throw new Error('ResultStore requires a resultsFile.');
    this.resultsFile = resultsFile;
    this.envFile = envFile || path.join(path.dirname(resultsFile), '.env');
    this.fs = fsImpl;
    this.shouldRewriteLoadedFile = false;
    this.results = this.readFromDisk();
    if (this.shouldRewriteLoadedFile) this.writeSnapshot();
    else this.syncEnvironmentFile();
  }

  readFromDisk() {
    if (!this.fs.existsSync(this.resultsFile)) return [];
    try {
      const rows = [];
      const content = this.fs.readFileSync(this.resultsFile, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || trimmed.includes('Test Profile Name') || trimmed.includes('---')) continue;
        const parts = trimmed.split('|').map(value => value.trim());
        const result = { testName: parts[1], apiKey: parts[2] };
        if (isSuccessfulResult(result)) rows.push(result);
      }
      const sortedRows = sortResults(rows);
      this.shouldRewriteLoadedFile = rows.some((row, index) => {
        const sortedRow = sortedRows[index];
        return !sortedRow
          || row.testName !== sortedRow.testName
          || row.apiKey !== sortedRow.apiKey;
      });
      return sortedRows;
    } catch (error) {
      return [];
    }
  }

  read() {
    return this.results.map(result => ({ ...result }));
  }

  has(testName) {
    return this.results.some(result => result.testName === testName && isSuccessfulResult(result));
  }

  replaceAll(results) {
    this.results = sortResults((results || [])
      .filter(isSuccessfulResult)
      .map(result => ({ testName: result.testName, apiKey: result.apiKey })));
    this.writeSnapshot();
  }

  upsert(result) {
    if (!isSuccessfulResult(result)) {
      throw new Error('Only successful API keys may be persisted.');
    }
    const normalized = { testName: result.testName, apiKey: result.apiKey };
    const index = this.results.findIndex(row => row.testName === normalized.testName);
    if (index === -1) this.results.push(normalized);
    else this.results[index] = normalized;
    this.results = sortResults(this.results);
    this.writeSnapshot();
  }

  writeSnapshot() {
    let markdown = '# Test Automation Results\n\n';
    markdown += `*Generated at: ${new Date().toLocaleString()}*\n\n`;
    markdown += '| Test Profile Name | API Key (Test) |\n';
    markdown += '|-------------------|----------------|\n';
    for (const result of this.results) {
      markdown += `| ${result.testName} | ${result.apiKey} |\n`;
    }
    this.fs.writeFileSync(this.resultsFile, markdown, 'utf8');
    this.syncEnvironmentFile(markdown);
  }

  syncEnvironmentFile(markdown = null) {
    if (markdown === null && !this.fs.existsSync(this.resultsFile)) return;
    const source = markdown === null
      ? this.fs.readFileSync(this.resultsFile, 'utf8')
      : markdown;
    const existing = this.fs.existsSync(this.envFile)
      ? this.fs.readFileSync(this.envFile, 'utf8')
      : '';
    const existingKeys = new Set(extractApiKeys(existing));
    const additions = extractApiKeys(source).filter(key => !existingKeys.has(key));
    if (!additions.length) return;

    const base = existing.replace(/(?:\r\n|\n|\r)+$/, '');
    const prefix = base ? `${base}\n` : '';
    this.fs.writeFileSync(
      this.envFile,
      `${prefix}${additions.join('\n')}\n`,
      'utf8'
    );
  }
}

ResultStore.isSuccessfulResult = isSuccessfulResult;

module.exports = ResultStore;
