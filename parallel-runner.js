const path = require('path');
const PuppeteerRunner = require('./runner');
const ResultStore = require('./result-store');

function clampParallelism(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(5, Math.max(1, parsed));
}

function safePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'run';
}

class ParallelPuppeteerRunner {
  constructor({
    users,
    automationConfig = {},
    onLog,
    onCaptchaRequired,
    onVerificationCodeRequired,
    onFinished,
    childRunnerFactory,
    resultStore,
    workspaceDir = __dirname,
    runIdFactory
  }) {
    this.users = users || [];
    this.automationConfig = automationConfig;
    this.parallelism = clampParallelism(automationConfig.parallelism);
    this.onLog = onLog || (() => {});
    this.onCaptchaRequired = onCaptchaRequired || (() => {});
    this.onVerificationCodeRequired = onVerificationCodeRequired || (() => {});
    this.onFinished = onFinished || (() => {});
    this.childRunnerFactory = childRunnerFactory || (options => new PuppeteerRunner(options));
    this.resultStore = resultStore || new ResultStore({
      resultsFile: path.join(__dirname, 'api_keys_test.md')
    });
    this.workspaceDir = workspaceDir;
    this.runIdFactory = runIdFactory || (() => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.activeRunners = new Set();
    this.pendingUsers = [];
    this.nextUserIndex = 0;
    this.claimCount = 0;
    this.isStopped = false;
    this.finished = false;
  }

  log(message, type = 'info') {
    this.onLog({ message, type, timestamp: new Date().toISOString() });
  }

  claimNextUser() {
    if (this.isStopped || this.nextUserIndex >= this.pendingUsers.length) return null;
    const user = this.pendingUsers[this.nextUserIndex];
    this.nextUserIndex++;
    this.claimCount++;
    return { user, claimIndex: this.claimCount };
  }

  createChildRunner(user, workerIndex, claimIndex, runId, onSuccess) {
    const targetUserDataDir = path.win32.join(
      this.workspaceDir,
      '.chrome_automation_profiles',
      safePathPart(runId),
      `worker-${workerIndex}-claim-${claimIndex}`
    );
    return this.childRunnerFactory({
      users: [user],
      automationConfig: this.automationConfig,
      workspaceDir: this.workspaceDir,
      targetUserDataDir,
      persistResults: false,
      onUserSuccess: onSuccess,
      onLog: logObj => this.onLog({
        ...logObj,
        message: `[${user.testName}] ${logObj.message}`
      }),
      onCaptchaRequired: state => this.onCaptchaRequired({ ...state, user: state.user || user.testName }),
      onVerificationCodeRequired: state => this.onVerificationCodeRequired({ ...state, user: state.user || user.testName }),
      onFinished: () => {}
    });
  }

  async runWorker(workerIndex, runId) {
    while (!this.isStopped) {
      const claim = this.claimNextUser();
      if (!claim) return;
      const { user, claimIndex } = claim;
      let completed = false;
      const child = this.createChildRunner(user, workerIndex, claimIndex, runId, async result => {
        if (this.isStopped) return;
        this.resultStore.upsert(result);
        completed = true;
      });
      this.activeRunners.add(child);
      try {
        await child.run();
      } catch (error) {
        this.log(`[${user.testName}] Worker failed: ${error.message}`, 'error');
      } finally {
        this.activeRunners.delete(child);
      }
      if (!completed && !this.isStopped) {
        this.log(`[${user.testName}] Session ended without a successful API key; the account was not released.`, 'error');
        return;
      }
    }
  }

  stop() {
    if (this.isStopped) return;
    this.isStopped = true;
    for (const child of this.activeRunners) child.stop();
  }

  async run() {
    const runId = this.runIdFactory();
    this.pendingUsers = this.users.filter(user => !this.resultStore.has(user.testName));
    this.nextUserIndex = 0;
    this.claimCount = 0;
    const workerCount = Math.min(this.parallelism, this.pendingUsers.length);
    this.log(`启动 ${workerCount} 个隔离窗口处理 ${this.pendingUsers.length} 个待完成账号。`, 'info');
    try {
      await Promise.all(Array.from(
        { length: workerCount },
        (_, index) => this.runWorker(index + 1, runId)
      ));
    } finally {
      if (!this.finished) {
        this.finished = true;
        this.onFinished();
      }
    }
  }
}

ParallelPuppeteerRunner.clampParallelism = clampParallelism;

module.exports = ParallelPuppeteerRunner;
