# Target-page Manual Intervention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make captcha and email verification complete entirely in the target browser while the Dashboard only displays non-blocking status.

**Architecture:** `runner.js` polls target-page state and optionally re-submits Create Account after captcha. `server.js` broadcasts state only. Dashboard JavaScript renders one passive notice and exposes no intervention POST endpoints.

**Tech Stack:** Node.js, Puppeteer, Express, SSE, browser JavaScript, Node test runner.

---

### Task 1: Write failing lifecycle tests

**Files:** `test/runner-browser-lifecycle.test.js`, `test/dashboard-localization.test.js`

- [ ] Replace Dashboard-code resolver tests with a fake target-page visibility sequence that remains pending while the code input is visible and resolves after two absent checks.
- [ ] Add a fake-page test proving Create Account is clicked again only while the password form remains visible.
- [ ] Assert the Dashboard contains a passive notice and no intervention modal, inputs, confirmation buttons, or POST endpoints.
- [ ] Run both test files and confirm failures identify the old Dashboard-owned workflow.

### Task 2: Implement target-page observation

**Files:** `runner.js`

- [ ] Remove the pending code resolver.
- [ ] Add `resubmitCreateAccountAfterCaptcha()` with visible/enabled form checks.
- [ ] Add `waitForManualVerificationCompletion()` using two consecutive hidden/absent checks.
- [ ] Replace code filling/submission with target-page observation and preserve current user/page ownership.

### Task 3: Make Dashboard passive

**Files:** `server.js`, `public/index.html`, `public/index.js`, `public/index.css`

- [ ] Remove captcha/code POST endpoints and all modal/input/button markup and handlers.
- [ ] Keep SSE waiting/resolved states and render one amber/blue non-blocking notice.
- [ ] Hide the notice on resolved, idle, completed, and stopped states.

### Task 4: Verify and document

**Files:** Relevant `.ai/*.md` mirrors

- [ ] Run focused tests, full `npm.cmd test`, and syntax checks for all changed JavaScript.
- [ ] Confirm active Dashboard/server sources contain no intervention POST or code-input symbols.
- [ ] Synchronize `.ai` decisions, fixes, and current work.

## Self-review

All acceptance criteria map to an explicit task. State names and ownership are consistent, and the plan contains no placeholders.
