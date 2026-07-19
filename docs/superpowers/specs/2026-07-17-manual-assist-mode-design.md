# Manual Assist Mode Design

## Goal

Turn the NVIDIA runner into a human-operated assistant: it dismisses cookie consent first, then recognizes pages and fills fields while a person activates every other webpage control.

## Interaction Contract

- The runner may inspect the DOM, current URL, and verification state.
- The runner may focus, clear, and type into text, email, password, date, and account-name fields.
- Immediately after each initial navigation, the runner must wait for and dismiss cookie consent before injecting a banner, inspecting the workflow, or typing. It prefers the exact `Reject Optional` label and falls back to exact `Reject All`.
- Cookie dismissal is the sole click exception. The runner must not otherwise call DOM `click()`, Puppeteer `page.click()`, activate browser switches, submit forms, or toggle checkboxes.
- After filling a page, the runner logs a clear instruction and waits for the human to navigate or complete the page.
- Dashboard intervention UI remains passive and contains no continuation controls.

## Session Isolation

Every attempt starts from a newly rebuilt project-owned Chrome profile. Before navigation, CDP clears browser cookies, HTTP cache, and storage for all NVIDIA origins used by the flow, and disables the network cache for the page. The disposable profile is removed again when the attempt ends.

## Completion

The existing authenticated API request and successful-key persistence remain unchanged. A persisted successful key remains the only completion authority.
