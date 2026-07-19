# Gmail Login Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Launch a normal Edge window for first-time Gmail authentication from the Dashboard.

**Architecture:** Add a dependency-injected interactive Edge launcher to `edge-launch.js`, expose it through a guarded Express route, and connect a Chinese Dashboard button. The launcher reuses `.gmail_edge_user_data` but does not use Puppeteer.

**Tech Stack:** Node.js, child_process, Express, browser JavaScript, Node test runner.

### Task 1: Interactive Edge Launcher

- [ ] Add failing tests for executable discovery, fixed Gmail Profile args, detached visible spawn, and absence of automation/private flags.
- [ ] Verify RED with `node --test test/edge-launch.test.js`.
- [ ] Implement `launchGmailLoginBrowser()` in `edge-launch.js`.
- [ ] Verify GREEN.

### Task 2: Dashboard Integration

- [ ] Add failing source-contract tests for the button, handler, route, and active-run guard.
- [ ] Verify RED with `node --test test/dashboard-localization.test.js`.
- [ ] Add `/api/gmail-login`, Dashboard markup, Chinese feedback, and running-state disablement.
- [ ] Verify GREEN.

### Task 3: Verification and Docs

- [ ] Run `npm.cmd test` and syntax checks for modified JavaScript files.
- [ ] Sync `.ai` mirrors and report that one Node restart is required to load the new endpoint.
