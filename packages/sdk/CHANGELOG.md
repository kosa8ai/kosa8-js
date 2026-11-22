# Changelog

## 0.5.0 — 2026-11-21

The kosa8 Cloud API for RL training and fan-out, mirroring the Python SDK's `kosa8.rl` (0.5.0). Everything from 0.4.x works as before.

- `cloud.sandboxes.createMany(n, opts)` (`POST /v1/sandboxes/batch`, 1 to 1000): any create field, plus `labels`, `runId`, `leaseS`, `prefix`, `partialOk` (default true) and `wait`. Answers a `CloudSandboxBatch`: an array of `CloudSandbox` with `failed` (`index`, `code`, `message`, `failure_class`, `retryable`), `requested` and `created`. A sandbox that fails to boot is deleted and moved to `failed`.
- `box.fork(n, { labels, runId, leaseS, prefix, partialOk })` or `box.fork({ n, … })`: up to 1000 copies (was 100). A plain `fork(n)` of at most 100 still sends `{ n }` and is all or nothing; it now answers a `CloudSandboxBatch` (still an array).
- `cloud.sandboxes.heartbeat({ runId | labels | ids, extendS })`, `box.heartbeat()`, `cloud.sandboxes.drain({ runId | labels | ids })`.
- `box.grade(cmd, { files, timeoutS, env, keep, runId, rollout })` and `cloud.sandboxes.grade(id, …)`: a sealed copy with no network and hidden files; `{ reward, metrics, rewardFrom, exitCode, stdout, stderr, failureClass, retryable, ms, graderId, kept, recorded, raw }`. `reward` is `null` when the command did not finish.
- `create({ leaseS, runId, record, idempotencyKey })`: a lease (60 to 86400 s, not with `ttlS`), the `kosa8.run` label, desktop recording. A sandbox made but not handed back (a failed boot wait or labels call) is deleted.
- `Idempotency-Key` on creates, batches, forks and grades: a fresh UUID per call, reused across its retries (`newIdempotencyKey()`).
- Retries: `new Kosa8Cloud({ retry })` takes a `RetryPolicy` (default 3 tries, full-jitter exponential backoff, at least Retry-After) or `false`. Applied to reads, PUTs, deletes, heartbeats, drains and the idempotent creates on infra failures, and to any request on a 429 that may pass. This is new behaviour: a transient 5xx or network failure on those calls is now retried before it is thrown. `RetryPolicy`, `NO_RETRY`, `callWithRetry`.
- Failure classes: every `Kosa8Error` has `failureClass` and `retryable` (kosa8 Cloud's own when sent), and `retryAfter` (from Retry-After on 429 and 503, or `retry_after_s`). Exec results have `failureClass` and `retryable` (and `stdoutTruncated`/`stderrTruncated` when set). `FAILURE_CLASSES`, `failureOf`, `classifyFailure`.
- `cloud.forkMap(base, fn, items, opts)`: `fn(child, item)` in its own fork per item, retried on infra failures, `timeoutMs`, abortable; children always deleted. `ForkResult`, `Kosa8CancelledError`, `Kosa8ItemTimeoutError`.
- `await using box = await cloud.sandboxes.create()`, `box.dispose()` (a sandbox gone already is fine); `Lease` and `RlRun` are async-disposable too. `Symbol.asyncDispose` is defined on runtimes that lack it.
- `rl` (also exported by name): `RlRun` (`rl.Run`) with `start`, `attach`, `list`, `map`, `record`, `flush`, `finish`, `summary`, `update`, `rollouts`, `export`, `exportRows`, `drain`; `withRun`; `Lease`/`lease` (heartbeats on an unref'd timer, drain on close, SIGINT, SIGTERM and `beforeExit`); `mapRollouts`, `Rollouts` (`rewards`, `mask`, `meanReward`, `byClass`, `groups()`), `DEFAULT_MASK`.
- Org templates: `cloud.orgTemplates.build|import|get|list|delete|wait` (`/v1/templates`).
- Small sizes: `SMALL_CLOUD_SIZES` (`0.25x0.5`, `0.5x1`, `1x2`); `CloudSize` includes them.
- Capability tokens: `cloud.tokens.create|list|revoke` (`/v1/tokens`); a `k8c_tok_…` secret is accepted as `apiKey` (`CLOUD_TOKEN_PREFIX`).
- Embeds: `box.embeds.create|list|revoke`. Custom preview domains: `box.previews.domains(port)` and `cloud.previewDomains(previewId)` with `add|list|get|remove`. Recordings: `cloud.recordings.list|link|delete`, `box.recordings()`, `create({ record: true })`. Burst Passes: `cloud.burst.get|activate`.
- Constants: `MAX_FORK` (1000), `MAX_BATCH` (1000), `MIN_LEASE_S`, `MAX_LEASE_S`, `RUN_LABEL`. `MAX_FORK_N` (100) is now the all-or-nothing limit.

## 0.4.1 — 2026-11-17

- `CloudExecOptions` takes `timeoutS` (the API's `timeout_s`, 1 to 86400, checked before any request) and `signal` (an `AbortSignal` that ends the request) for `box.exec` and `box.execBackground`.
- `CloudBackgroundExec.stop()` (`POST …/exec/{id}/stop`): SIGTERM, then SIGKILL after 5 s. `CloudBackgroundExecInfo` has `stopped` and `timed_out`.
- `box.state`: the sandbox's state as of the last call (it was `undefined` after create, list and get).
- The exec limit is 90 s, not 30 s, in the docs, `Kosa8ExecTimeoutError` and its hint. The docs no longer say each exec runs in a fresh container: files last between execs; processes a buffered exec leaves behind may not.
- Used by `@kosa8/ai-sdk-sandbox` 0.2.0's kosa8 Cloud session.

## 0.4.0 — 2026-11-15

kosa8 Cloud parity with the Cloud API (and the Python SDK).

- Default address is `https://api.kosa8.com` (`KOSA8_CLOUD_URL` overrides it). 0.3.0 defaulted to `api.kosa8.cloud`; do not use 0.3.0.
- `cloud.sandboxes.create` takes `ttlS` (60 to 7776000 s), `deleteAfter` (Unix ms or a `Date`; not with `ttlS`) and `acceptPrice` (paid kosa8 Store items). Lifetimes and `sleepAfterS` are checked before any request; only the options you set are sent.
- `CloudSandbox.update({ ttlS?, deleteAfter?, sleepAfterS? })` (`PATCH /v1/sandboxes/{id}`); `{ ttlS: null }` clears the lifetime. Answers `{ sandbox, notes }` and refreshes `info`.
- Pagination: `list()` still answers an array and now takes `limit` and `cursor`; new `listPage()` → `{ sandboxes, nextCursor }` and `iterate()`, an async iterator over every page that stops if a cursor repeats. Servers without pagination answer everything at once with `nextCursor: null`.
- Files: `box.files.read` (a `Uint8Array`), `readText`, `write` (a string or a `Uint8Array`, sent as raw bytes), `list` (default `/workspace`), `mkdir`, `delete` (with `recursive`).
- `box.checkpoint(label?)`, `box.checkpoints()`, `box.rewind(checkpoint)`, `box.fork(n)` (1 to 100) and `box.ports()`. These and files need the host's data plane and may answer 501 (`Kosa8UnsupportedError`) on current hosts.
- `cloud.templates()`.
- `CloudSandboxInfo` follows the API's Sandbox schema: `source` can be `fork`; new `parent_id`, `delete_after`, `sleep_after_s`, `host_unreachable`, `origin_item_version`; more `state` values.
- Errors: `Kosa8PaymentRequiredError` has `upgradeUrl` and `agentMessage` (`null` when absent). New `Kosa8OrgFrozenError` (423 `org_frozen`) and `Kosa8ExecTimeoutError` (504, `exec_timeout`, or a 502 `host_failed` on exec that timed out; a buffered exec is cut off after about 30 s). `Kosa8RateLimitError` has `retryAfter` (seconds) when the answer had a Retry-After header. Every cloud error keeps the whole answer as `body`.
- New types: `CloudUpdateOptions`, `CloudListOptions`, `CloudSandboxPage`, `CloudFileInfo`, `CloudCheckpoint`, `CloudRewindResult`, `CloudPort`, `CloudTemplate`; constants `MIN_TTL_S`, `MAX_TTL_S`, `MAX_SLEEP_AFTER_S`, `MAX_FORK_N`.
- README leads with kosa8 Cloud, including what the base template can and cannot do.

The rest of the kosa8 Cloud API, also in 0.4.0:

- Sized and Docker creates: `cloud.sandboxes.create` takes `size` (`2x4`, `4x8`, `8x16`, `16x32`; `CLOUD_SIZES`), `cpus`+`memMb`, `image` (e.g. `kosa8-template/universal-24.04-20261115.2`), `diskGb`, `persistent`, `docker`, `cpu: 'dedicated'`, `name`, `env`, `egress`, `secrets`, `labels` and `snapshot`. A cold boot (202 `creating`) is waited for unless `wait: false`; `box.waitUntilRunning()`. Conflicting options are refused before any request.
- `list({ name, labels })`.
- Background commands: `box.execBackground(cmd)` → `CloudBackgroundExec` with `status()` and `wait()`; `box.getExec(id)`.
- Durable snapshots: `box.snapshot(name?)`, `cloud.snapshots.create|list|get|delete`.
- Previews (`box.previews.create|list|link|rotate|delete`), `box.terminal()`, the code interpreter (`box.runCode`, `box.codeContexts`), `box.files.readRaw|writeRaw|link`, egress (`box.egress|setEgress|resetEgress`, `cloud.egressPresets|orgEgress|setOrgEgress`), schedules (`box.schedules`), `box.setLabels|metrics|logs|secrets`, `cloud.capabilities()`.
- Secrets: `cloud.secrets.set|list|delete` (values go in a body, never come back).
- Pipelines: `cloud.pipelines.run|list|get|logs|cancel|artifacts|downloadArtifact|wait` and `cloud.pipelines.hooks.create|list|delete`.

## 0.3.1 — 2026-11-03

- The default kosa8 Cloud address is now `https://api.kosa8.com` (0.3.0 defaulted to `api.kosa8.cloud`, which kosa8 Cloud does not use). `KOSA8_CLOUD_URL` still overrides it.

## 0.3.0 — 2026-11-03

kosa8 Cloud's API (api.kosa8.cloud) is not open yet; the `Kosa8Cloud` client is ready for when it is.

Windows, and paired workers.

- With no `host`, `KOSA8_HOST` or `socketPath`, the client follows the CLI's saved worker connection (`~/.kosa8/worker.json`, written by `kosa8 wsl setup` and `kosa8 worker join`), token included, as the CLI does. On Windows that is the WSL2 engine; before, the SDK looked for a unix socket Windows never has. `workerFile: null` turns it off.
- A connection failure on Windows says to run `kosa8 wsl setup`.
- CI runs the tests on Linux, macOS and Windows.

kosa8 Cloud.

- `Kosa8Cloud`: a client for the kosa8 Cloud control plane, authenticated with a `k8c_live_` API key (`KOSA8_API_KEY`; address `KOSA8_CLOUD_URL`, default `https://api.kosa8.cloud`, https only except localhost).
- `cloud.sandboxes.create`, `list` and `get` return a `CloudSandbox` with `exec`, `sleep`, `wake`, `refresh` and `delete`.
- `cloud.functions`: `deploy`, `list`, `get`, `delete`, `invoke` and `map`.
- `cloud.me()` and `cloud.usage()`.
- Errors: every error has `code`, the cloud's stable error code. New `Kosa8PaymentRequiredError` (402) and `Kosa8RateLimitError` (429), and `Kosa8TimeoutError` (a `Kosa8ConnectionError`) for a call past its timeout.

## 0.2.0

The sandbox toolbox, matching the kosa8 v0.13.0 daemon and the Python SDK.

- `runCode`: run a Python, JavaScript or TypeScript snippet. Charts come back in `artifacts`, as bytes.
- Files: `listFiles`, `statFile`, `readFile`, `readText`, `writeFile`, `deleteFile` (with `recursive`), `makeDir`, `moveFile`.
- Git: `git(op, fields)`, plus `gitClone`, `gitStatus`, and `gitCommit`, which stages everything first.
- Shell sessions: `createSession`, `listSessions`, `sessionExec`, `deleteSession`, and `shell`, which makes its session on first use.
- Terminals: `startPty`, `resizePty`.
- Previews: `createPreview`, `revokePreviews`.
- Lifecycle: `setLifecycle`, and `createSandbox` options `autoStopMin`, `ttlMin`, `autoDeleteMin`, `ephemeral` and `template`.
- Templates: `listTemplates`, `deleteTemplate`, and `buildTemplate`, which packs a context directory (honouring `.dockerignore`) and streams the build.
- `SandboxHandle` has every per-sandbox toolbox method.
- New types: `CodeResult`, `ShellResult`, `GitResult`, `FileInfo`, `SessionInfo`, `Preview`, `Template`, `Lifecycle`. `Sandbox` gains `lifecycle` and `stopped_at`.

## 0.1.0

First release.
