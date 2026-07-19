# Manual Assist Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain only required cookie-consent activation while keeping every workflow control human-owned, with page recognition, verified field filling, and strict per-user session isolation.

**Architecture:** Replace submit/click helpers with navigation observers and manual-action log prompts. Centralize CDP cleanup in a testable `prepareCleanUserSession()` method called for every attempt.

**Tech Stack:** Node.js, Puppeteer, Chrome DevTools Protocol, `node:test`.

---

### Task 1: Define manual-assist regressions

**Files:**
- Create: `test/manual-assist-mode.test.js`
- Create: `.ai/test/manual-assist-mode.test.md`

- [x] Assert `runner.js` contains exactly one DOM click path for cookie consent and no Puppeteer/browser-switch click invocation.
- [x] Assert per-attempt cleanup clears cookies, cache, NVIDIA origin storage, and disables cache.
- [x] Assert the navigation observer waits without evaluating or clicking controls.
- [x] Run the focused test and confirm the ownership regression before implementation.

### Task 2: Implement manual navigation ownership

**Files:**
- Modify: `runner.js`
- Modify: `test/runner-browser-lifecycle.test.js`

- [x] Delete automatic identifier, login, create-account, consent, Cloud Account, checkbox, captcha-resubmit, and browser-switch activation paths.
- [x] Restore strict cookie dismissal before every other target-page action.
- [x] Add manual navigation observers and use them after each autofill stage.
- [x] Keep Cloud Account name autofill, but wait for human submission.
- [x] Update lifecycle tests from workflow-click ownership to fill-and-wait ownership.

### Task 3: Enforce clean per-user state

**Files:**
- Modify: `runner.js`
- Modify: `test/manual-assist-mode.test.js`

- [x] Add `prepareCleanUserSession()` using CDP cleanup commands.
- [x] Call it immediately after selecting the new disposable-profile page and before navigation.
- [x] Retain profile reset before launch and after browser close.

### Task 4: Verify and document

**Files:**
- Modify: `.ai/runner.md`
- Modify: `.ai/test/runner-browser-lifecycle.test.md`
- Modify: `.ai/PROJECT_CONTEXT.md`

- [x] Run focused tests, full `npm.cmd test`, syntax checks, and a source scan for click invocations.
- [x] Record the final cookie-only ownership and cache-isolation contracts in `.ai`.

The workspace has an empty `.git` directory, so no commit step is available.
