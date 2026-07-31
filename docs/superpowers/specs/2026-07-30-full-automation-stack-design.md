# Full automation stack (proxy + captcha + email)

## Goal

Reduce human babysitting for NVIDIA registration by wiring optional residential proxies, CapSolver, and Gmail plus-address verification-code fetch, while fixing post-captcha `创建账户` and accidental Chrome close.

## Components

| Module | Role |
|--------|------|
| `proxy-pool.js` | Sticky residential sessions (yiyuan gateway or API extract) |
| `captcha-solver.js` | CapSolver createTask/getTaskResult + token inject |
| `email-code.js` | Gmail API / IMAP poll for 6-digit codes (plus-address match) |
| `edge-launch.js` | `--proxy-server` on Chrome launch |
| `runner.js` | Orchestrates proxy auth, auto captcha, auto email, post-captcha resubmit |
| `gmail_config.json` | Runtime config (+ secrets placeholders) |

## Post-captcha contract

1. Detect captcha → CapSolver if configured → else human.
2. On solved (token or two consecutive absent polls), **always** try `submitVisibleAccountAction` (创建账户 / Create Account / Login).
3. Retry without throwing; navigation / context-destroyed treated as success so the attempt cleanup does not look like a hard failure mid-captcha.

## Credentials (user supplies later)

- CapSolver: `captcha.apiKey` or `CAPSOLVER_API_KEY`
- Yiyuan: `proxy.enabled=true` + gateway `server`/`username`/`password` or `extractUrl`
- Gmail: `email.provider=gmail_api` + OAuth refresh, or `imap` + app password; users as `you+tag@gmail.com`

## Fallback

Any missing credential keeps the previous human-assist path.
