# Captcha Human Intervention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make captcha handling auto-continue after a human solves the challenge, provide a reliable manual check fallback, and localize the dashboard and target-page intervention UI to Chinese.

**Architecture:** `PuppeteerRunner` remains the authority for whether a challenge is active. It will recognize standard response tokens, race a one-second polling timer against the existing manual wake signal, and emit `waiting`/`resolved` events. The dashboard will keep a manual button pending until the next authoritative SSE event instead of resetting it when the POST finishes.

**Tech Stack:** Node.js, Puppeteer, Express, browser JavaScript, Node built-in test runner.

---

## File Map

- Modify `runner.js`: token-aware captcha detection, auto polling, manual wake source, and browser banner state.
- Modify `public/index.html`: `zh-CN` markup and Chinese static copy.
- Modify `public/index.js`: Chinese dynamic copy and SSE-driven manual-button feedback.
- Modify `public/index.css`: auto-check status styling.
- Modify `server.js`: Chinese API messages while preserving routes and SSE structure.
- Modify `test/runner-browser-lifecycle.test.js`: runner captcha regressions.
- Create `test/dashboard-localization.test.js`: dashboard copy and pending-button contract.
- Update `.ai` mirrors after verification.

### Task 1: Captcha Completion Authority

**Files:**
- Modify: `test/runner-browser-lifecycle.test.js`
- Modify: `runner.js`

- [ ] **Step 1: Write failing token and iframe regressions**

Add a fake page whose `evaluate()` returns a non-empty `h-captcha-response` while `$()` still finds the hCaptcha iframe, then assert `detectCaptcha()` returns `null`. Add the inverse case with an empty token and visible iframe, expecting the iframe selector.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/runner-browser-lifecycle.test.js`

Expected: the response-token case fails because current detection returns `iframe[src*="hcaptcha"]`.

- [ ] **Step 3: Implement token-aware detection**

At the start of `detectCaptcha()`, evaluate these fields and return `null` when any has a trimmed value:

```js
[
  'textarea[name="h-captcha-response"]',
  'textarea[name="g-recaptcha-response"]',
  'input[name="cf-turnstile-response"]',
  'textarea[name="cf-turnstile-response"]'
]
```

Keep the existing visible-selector fallback for challenges without standard tokens.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/runner-browser-lifecycle.test.js`

Expected: both completion and still-active cases pass.

### Task 2: Automatic Polling, Manual Fallback, and Banner

**Files:**
- Modify: `test/runner-browser-lifecycle.test.js`
- Modify: `runner.js`

- [ ] **Step 1: Write failing lifecycle regressions**

Add tests that inject `captchaPollIntervalMs: 0` and stub `detectCaptcha()` to return `iframe`, then `null`. Assert `handleCaptchaIntervention()` completes without calling `resolveCaptcha()`, emits `waiting` then `resolved`, and changes the banner to intervention then running. Add a manual test where a long poll is awakened by `resolveCaptcha()` and a still-active result emits a new `waiting` state.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/runner-browser-lifecycle.test.js`

Expected: the auto-continue test hangs or times out because the current runner waits only for a button click.

- [ ] **Step 3: Implement condition-based waiting**

Add `captchaPollIntervalMs` constructor injection and a `waitForCaptchaCheck()` helper that resolves with `auto`, `manual`, or `stopped`. Use one timer and clear it on every resolution. Make `resolveCaptcha()` wake the current wait as `manual`; make `stop()` wake it as `stopped`.

Update `handleCaptchaIntervention()` to:

```js
set banner to intervention
emit waiting once
while active and not stopped:
  source = await waitForCaptchaCheck()
  active = await detectCaptcha()
  if manual and active: emit waiting with a Chinese retry message
emit resolved and restore running banner when inactive
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/runner-browser-lifecycle.test.js`

Expected: automatic, manual, stopped, and legacy browser lifecycle tests pass.

### Task 3: Chinese Dashboard and Reliable Button Feedback

**Files:**
- Create: `test/dashboard-localization.test.js`
- Modify: `public/index.html`
- Modify: `public/index.js`
- Modify: `public/index.css`
- Modify: `server.js`

- [ ] **Step 1: Write failing dashboard contract tests**

Read `public/index.html` and `public/index.js` as UTF-8. Assert the document uses `lang="zh-CN"`, contains `请人工干预`, `正在自动检测验证结果`, and `我已完成，立即检查`, and no longer contains `HUMAN CAPTCHA REQUIRED` or `I've Solved It`. Assert `handleCaptchaResolved()` does not restore the button inside a `finally` block and `updateCaptchaModal()` handles authoritative `waiting` and `resolved` events.

- [ ] **Step 2: Run dashboard tests and verify RED**

Run: `node --test test/dashboard-localization.test.js`

Expected: assertions fail on English copy and immediate `finally` reset.

- [ ] **Step 3: Localize and fix feedback**

Translate all visible static/dynamic dashboard strings while retaining `Gmail`, `API Key`, and `NVIDIA`. Change manual click behavior to disable the button and show `正在检查…` after a successful POST; only `updateCaptchaModal(waiting)` re-enables it with retry copy, and `resolved` hides/reset the modal. Add a small `.captcha-auto-status` style. Translate server response messages without changing route names or state values.

- [ ] **Step 4: Run dashboard tests and verify GREEN**

Run: `node --test test/dashboard-localization.test.js`

Expected: all localization and feedback assertions pass.

### Task 4: Full Verification and Handoff

**Files:**
- Modify: `.ai/PROJECT_CONTEXT.md`
- Modify: `.ai/runner.md`
- Modify: `.ai/server.md`
- Modify: `.ai/public/index.html.md`
- Modify: `.ai/public/index.js.md`
- Modify: `.ai/public/index.css.md`

- [ ] **Step 1: Run full automated verification**

Run: `npm.cmd test`, `node --check runner.js`, `node --check server.js`, and `node --check public/index.js`.

Expected: zero test failures and zero syntax errors.

- [ ] **Step 2: Verify source contracts**

Search source files for legacy English intervention strings and confirm `.chrome_automation_user_data` is not deleted or touched by test commands.

- [ ] **Step 3: Sync `.ai` mirrors**

Record the iframe/token root cause, auto/manual state contract, Chinese localization decision, test evidence, and clear all open threads.

- [ ] **Step 4: Commit if repository support exists**

This workspace is not a Git repository, so no commit command is available. Preserve the focused filesystem changes for user review.
