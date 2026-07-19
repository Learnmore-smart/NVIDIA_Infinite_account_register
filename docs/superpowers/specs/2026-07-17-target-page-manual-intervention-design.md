# Target-page Manual Intervention Design

## Goal

Keep every human action in the spawned target browser. The Dashboard only reports what the target page is waiting for and never asks for input or confirmation.

## Root Cause

- The previous runner waited on a Dashboard-supplied email code, so manually completing the code on the target page could never resolve the pending promise.
- The Create Account button was clicked before captcha completion. If captcha blocked that submission, the runner never clicked it again after the challenge resolved.
- Blocking Dashboard modals made a reminder look like an action the operator had to complete in the Dashboard.

## Behavior

1. Captcha is solved directly in the target browser. The runner keeps polling automatically.
2. After captcha resolves, the runner clicks Create Account again only if the password/create-account form is still visible.
3. When the email-code input appears, the runner shows a blue target-page banner and waits while the operator enters and submits the code on that same page.
4. When the code input stays absent/hidden across two checks, the runner treats the page as advanced and continues the same user flow.
5. Dashboard shows a slim non-blocking amber or blue notice. It contains no input and no action button.

## Colors

- Normal automation: blue, text `🤖 自动化运行中`.
- Captcha intervention: amber, text `⚠️ 请在本页面完成人机验证`.
- Email code: blue, text `✉️ 请在本页面输入邮箱验证码`.

## Removed Contracts

- Dashboard verification-code modal, input, and submit handler.
- `POST /api/verification-code`.
- Dashboard captcha confirmation button and `POST /api/captcha-solved`; automatic polling remains authoritative.

## Acceptance Criteria

- Solving captcha causes a blocked Create Account form to be submitted again.
- Completing email verification in the target page resumes without a Dashboard action or outer user retry.
- Dashboard notices never cover the page or request input.
- Resolved/idle states hide the Dashboard notice.
- Existing target-browser isolation, result export, and retry ownership remain unchanged.

## Self-review

No placeholders remain. Human input has one owner (the target page), while Runner observation and Dashboard notification have separate, testable responsibilities.
