# Manual Verification Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gmail browser retrieval with a Dashboard-controlled six-digit verification-code pause and resume.

**Architecture:** `PuppeteerRunner` exposes a pending-code resolver; Express maps it to SSE and a POST endpoint; the Dashboard owns the input modal. Gmail-specific launch code and UI are removed.

**Tech Stack:** Node.js, Express, Puppeteer, browser JavaScript, Node test runner.

---

### Task 1: Lock the behavior with failing tests

**Files:** `test/runner-browser-lifecycle.test.js`, `test/dashboard-localization.test.js`, `test/edge-launch.test.js`

- [ ] Add a runner test asserting `waitForVerificationCode()` stays pending until `resolveVerificationCode('123456')` and resolves with that value.
- [ ] Add contracts for `waiting-code`, `/api/verification-code`, blue code UI, and removal of Gmail login symbols.
- [ ] Run the three focused test files and confirm failure for missing behavior.

### Task 2: Implement runner and server continuation

**Files:** `runner.js`, `server.js`

- [ ] Replace Gmail browser members with one pending verification-code resolver.
- [ ] Emit waiting/resolved state around the existing code-fill step.
- [ ] Add the validated POST endpoint and SSE event.
- [ ] Make stop release both captcha and code waits.

### Task 3: Replace Gmail UI and colors

**Files:** `public/index.html`, `public/index.js`, `public/index.css`

- [ ] Remove Gmail configuration, login controls, and browser wording.
- [ ] Add the six-digit modal and SSE submission state.
- [ ] Use amber for captcha and blue for code/normal banners.

### Task 4: Remove launch helpers and verify

**Files:** `edge-launch.js`, relevant `.ai/*.md` mirrors

- [ ] Remove Gmail helpers/exports without deleting on-disk profiles.
- [ ] Run focused tests, `npm.cmd test`, and `node --check` on changed JavaScript.
- [ ] Synchronize `.ai` handoff documents.

## Self-review

Every acceptance criterion maps to a task. Endpoint and state names are consistent and there are no placeholders.
