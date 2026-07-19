# Isolated Parallel User Sessions Design

## Goal

Allow a human operator to work on several test accounts at once, using separate visible Chrome windows so one account can wait for captcha, email verification, or manual navigation while the operator advances another account.

The default concurrency is three active accounts. The Dashboard exposes a bounded setting from one through five.

## Decisions and Alternatives

### Selected: independent Chrome process and profile per active account

Each active account owns a separate Chrome process, page, disposable profile directory, retry loop, and lifecycle state. This gives the strongest practical separation for cookies, HTTP cache, origin storage, service workers, extension runtime state, and browser singleton locks.

### Rejected: ordinary tabs in one Chrome profile

Ordinary tabs share cookies, cache, storage, service workers, and extension state. They cannot satisfy the requested isolation contract.

### Rejected: incognito browser contexts in one Chrome process

Incognito contexts separate most site state but still share one process and complicate the installed-extension requirement. A process failure would also interrupt every active account. Separate processes make ownership and cleanup explicit.

## Architecture

`PuppeteerRunner` becomes the batch orchestrator. It owns the pending-user queue, the bounded worker pool, stop coordination, accumulated successful results, and the final completion callback.

Each worker runs exactly one account attempt at a time through an isolated session object. The session owns its browser, page, captcha and verification observation state, and a unique disposable profile path. If the account attempt fails, that worker retries the same account until success or an explicit stop; it does not release the account back to the queue.

At most `parallelism` sessions are active. Completed users are filtered before the queue starts, so persisted successful API keys remain the only resume cursor.

## Profile and Cache Isolation

Every attempt receives a unique directory beneath a project-owned root such as:

```text
.chrome_automation_profiles/<run-id>/<worker-id>-<attempt-id>/
```

Before launch, only extension-related state is copied read-only from the user's last-used Chrome profile into that attempt directory. Daily Chrome and Edge profiles are never modified or deleted.

After the page is selected and before navigation, the session clears browser cookies, HTTP cache, and all configured NVIDIA-origin storage through CDP and disables the network cache. On success, failure, launch error, or stop, only that attempt's validated directory is recursively removed. Cleanup must reject paths outside `.chrome_automation_profiles`.

No active worker may delete the shared profiles root or another worker's directory.

## Interaction Contract

Each window follows the existing manual-assist contract:

- Immediately after initial navigation, automatically dismiss cookie consent, preferring exact `Reject Optional` and falling back to exact `Reject All`.
- Do not inject, inspect the workflow, or type until cookie dismissal succeeds.
- Recognize routes and fill fields automatically.
- Leave Continue, Next, Submit, captcha, email-code, checkboxes, and onboarding controls to the human operator.
- Show the account name in the injected target-page banner and prefix all logs with the account name so the operator can match work to windows.
- Keep Dashboard intervention state passive; it may summarize which accounts are waiting but cannot own verification inputs or continuation buttons.

## Scheduling and Retry Flow

1. Load and normalize successful persisted results.
2. Remove already-completed users from the pending queue.
3. Start `min(parallelism, pending users)` asynchronous workers.
4. Each worker claims one user and retains it across retries.
5. After success, the worker reports the API key to the orchestrator, which persists it and then gives that worker the next pending user.
6. When the queue and all workers are empty, emit one final completion event.

A slow manual account blocks only its own worker slot. Other workers continue independently.

## Result Persistence

Workers never write `api_keys_test.md` directly. They return successful results to the orchestrator. The orchestrator updates one in-memory accumulator and serializes each complete snapshot through the existing export format. Error strings are never persisted as API keys.

This single-writer rule prevents concurrent completions from overwriting one another.

## Stop and Error Handling

`stop()` marks the orchestrator stopped, releases all manual waiters, closes every active browser, and cleans each owned attempt profile. A stopped worker must not claim another user or persist a partial result.

One worker's browser, navigation, or account error does not terminate other workers. It logs the account-scoped error, cleans that attempt, waits the existing retry delay, and starts a fresh isolated attempt for the same account.

The orchestrator calls `onFinished` exactly once after all worker promises settle.

## Dashboard Contract

Add a numeric concurrency setting with minimum one, maximum five, and default three. The server validates and clamps the submitted value before constructing the runner; missing or stale clients receive the default.

The global run status stays compatible (`running`, waiting variants, `stopped`, `completed`). Per-account waiting states are aggregated for display and log context without changing ownership of manual actions.

## Testing

Automated regressions must prove:

- The worker pool never exceeds the configured concurrency.
- Three pending users can be active concurrently by default.
- Every active attempt receives a distinct profile path and launch `userDataDir`.
- One attempt's cleanup cannot delete another attempt's profile or any daily browser data.
- Each attempt performs CDP cleanup before navigation.
- A waiting or retrying user retains its worker slot while other workers advance.
- Concurrent successful completions persist every result exactly once.
- Stop closes every active browser, releases waiters, prevents new claims, and finishes once.
- Cookie dismissal remains the only automatic target-page click in each session.
- Existing single-worker behavior remains available with parallelism set to one.

## Acceptance Criteria

Starting an untouched batch with the default configuration opens up to three separately isolated Chrome windows. The operator can manually progress each account independently without cookies, cache, storage, or profile information leaking between them. Successful accounts are marked Done and persisted without loss; stopped or failed attempts leave no owned disposable profiles behind.
