# Manual Verification Code Design

## Goal

Remove all Gmail browser automation and let the operator enter each six-digit email verification code in the Dashboard without restarting the current user flow.

## Architecture

- `runner.js` owns a single pending verification-code promise. When NVIDIA requests an email code, the runner emits a waiting event and pauses at that exact step.
- `server.js` publishes the waiting state over SSE and accepts a validated six-digit code through `POST /api/verification-code`.
- `public/index.html` and `public/index.js` show a dedicated blue modal, submit the code, and wait for authoritative SSE resolution.
- Captcha remains separate. Captcha uses amber; email-code entry and normal automation banners use blue.

## Removed Scope

- No Gmail email configuration or login button.
- No `/api/gmail-login`, Gmail Edge launch options, or Gmail Puppeteer browser/page.
- Existing profile data on disk is not deleted automatically.

## State and Error Handling

- Server states add `waiting-code` alongside `waiting-captcha`.
- Only `/^\d{6}$/` is accepted. Invalid or stale submissions return a clear Chinese error.
- Stop releases any pending code wait so shutdown cannot hang.
- Waiting stays inside the current step and must not trigger the per-user outer retry.

## Acceptance Criteria

1. No runtime/UI path launches Gmail or Edge for email retrieval.
2. The Dashboard shows the current user and a focused six-digit input.
3. A valid submission resumes the same user and fills the code into NVIDIA.
4. Captcha is amber; code entry and ordinary automation are blue; intervention banners are not red.
5. Target Chrome isolation, captcha continuation, results, and retry behavior remain unchanged.

## Self-review

No placeholders remain. State names match across runner, server, SSE, and Dashboard.
