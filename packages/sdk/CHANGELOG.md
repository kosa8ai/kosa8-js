# Changelog

## Unreleased

- `new Kosa8Cloud()` with no `apiKey` and no `KOSA8_API_KEY` uses the key `kosa8 login` keeps in `~/.kosa8/cloud.json` (and its `api_url` unless `KOSA8_CLOUD_URL` or `baseUrl` is set), on Node 20.16+/22.3+; `@kosa8/sdk/cloud` still has no static Node import. The "no API key" error names `kosa8 login`.
- A plan limit answered with HTTP 429 (Starter's running limit, `starter_limit`) throws the new `Kosa8PlanLimitError`, a `Kosa8PaymentRequiredError` like every other plan limit, which still passes `instanceof Kosa8RateLimitError`. It is not retried.

## 0.10.0 - 2026-11-25

- Autopilot bots: `cloud.bots` with `list()` (`bots`, `paused_all`, `pending_approvals`), `templates()`, `template(id)`, `plan({ template | spec, name, replay })`, `compile(text)` (at most 500 characters, checked before sending), `create({ template | spec, name, sponsor, budgetUsd, scope, notify })` (exactly one of template or spec; starts as a draft), `get`, `update`, `delete`, `enable`, `disable`, `run(id, { dryRun })` (a dry run by default), `runs(id, { limit })`, `getRun`, `cancelRun`, `undoStep(runId, key)`, `pauseAll()`, `resumeAll()`.
- `cloud.approvals`: `list({ state, limit })` (pending by default), `get`, `approve(id, { reason, editedArgs })`, `reject(id, { reason })`. Deciding, `enable` and `resumeAll` need a person's key: a 403 `human_required` is thrown as `Kosa8HumanApprovalRequiredError` (a `Kosa8PolicyError`). An agent never approves its own action.

## 0.9.0 - 2026-11-24

- GitHub repos: `repo` on `cloud.sandboxes.create` and `cloud.run` (`"owner/name"`, `"owner/name@ref"` or `{ name, ref, path, depth }`), `info.repo` / `run.repo`; `cloud.github.status()`, `repos(query)`, `reposPage({ query, page })`, `branches(repo)`; `box.repo()`, `box.push({ branch, message, path })`, `box.pullRequest({ title, body, base, branch, draft })`. The GitHub token is minted by kosa8 per operation for one repo and never enters the sandbox.
- Errors: `Kosa8GitHubNotConnectedError` (409 `github_not_connected`, `connectUrl`), `Kosa8GitHubPermissionsError` (409 `github_permissions`, `missingPermissions`, `settingsUrl`), `Kosa8NoChangesError` (409 `no_changes`), `Kosa8RepoNotFoundError` (404 `repo_not_found`) and `Kosa8GitHubUnavailableError` (502 `github_unavailable`). The 409 ones are still `Kosa8ConflictError`, the 404 one `Kosa8NotFoundError`.

## 0.8.0 - 2026-11-23

- Errors: every HTTP error (`Kosa8ApiError` and subclasses) has the cloud's contract fields as getters: `upgradeUrl`, `agentMessage` (also on a 429 `quota_exceeded`), `requestUrl`, and for a 402 `plan_limit` `limitName`, `limit`, `used`, `plan`, `nextPlan`, `feature`, `options`, `packUrl`. `spend_cap`, `starter_limit` and `new_account_limit` are quota codes.
- Files: `files.read(path, { range })` sends `Range`; `files.write(path, data, { offset, append, mode })`; both take a `signal`. An append is never re-sent after a 5xx.
- `@kosa8/sdk/cloud`: the cloud client with no Node built-ins, for browsers, Workers, Deno and Bun.
- Serverless runs: `cloud.run({ code | command, ... })` (`POST /v1/run`), `cloud.runs.list/get/share`, `runFileBytes`. `box.direct()` (`POST …/direct`).
- `CloudFileInfo.mode` is a number (permission bits), as the API sends it; the E2B, Daytona and Modal shims report mode and permissions as those SDKs do. E2B `onStdout`/`onStderr` accept callbacks returning any value.
- RL: rollout flushes carry an Idempotency-Key, reused when a failed chunk is re-sent, so rows are never stored twice.

## 0.7.0 - 2026-11-23

- Retries of creates, batches, forks, grades and job submits use a new SDK-made `Idempotency-Key` after a 5xx (502 `host_failed`, 503 `no_capacity` / `host_restarting` / `host_unavailable`, 504), so each retry of a server-side failure is a new attempt. The key is still kept after no answer (the first try may have created the sandbox), a 429 and a 409 `idempotency_in_progress` / `template_building`. A key you pass as `idempotencyKey` is never changed. Retry-After is honoured as before.
- `@kosa8/sdk/daytona`, `@kosa8/sdk/modal` and `@kosa8/sdk/vercel`: one-import shims for Daytona's `@daytonaio/sdk` (0.233), Modal's `modal` (0.11) and `@vercel/sandbox` (4.1) on kosa8 Cloud. Sandboxes are created persistent (falling back to a plain one, with a warning, when the plan or host cannot); the key comes from `KOSA8_API_KEY` or the provider's own variable when it holds a `k8c_` key; previews back Daytona preview links, Modal tunnels and Vercel `domain(port)`; network policies map to egress; Daytona sessions keep `cd` and `export` between commands. Calls kosa8 cannot do throw `Unsupported` with the kosa8 alternative.
- READMEs open with the "switching from E2B / Daytona / Modal / Vercel Sandbox? change one import" banner and the kosa8 Cloud quickstart (free Starter plan, no card).
- Fork progress: `box.fork(n, { onProgress })` streams the fork (`Accept: application/x-ndjson`) and calls `onProgress({ requested, created, failed })` when the copies start and after each host call (up to 100 copies each); the answer is the same `CloudSandboxBatch`. An API that does not stream answers as before. `CloudForkProgress` is exported.
- Streamed exec: `box.execStream(cmd, { env, image, timeoutS, signal })` returns a `CloudExecStream`, an async iterable of `{ stream, text }` pieces as the command prints (`result({ onStdout, onStderr })`, `exitCode`, `stdout`, `stderr`, `close()`). `box.exec(cmd, { onStdout, onStderr, stream })` streams when given callbacks, `stream: true` or a `timeoutS` over 90. A streamed exec is not held to the 90 s buffered limit. `EXEC_LIMIT_S` is exported.
- `@kosa8/sdk/e2b`: an E2B-compatible `Sandbox` (`create`, `connect`, `kill`, `sandboxId`, `setTimeout`, `getInfo`, `isRunning`, `pause`, `getHost`, `commands.run` with `onStdout` / `onStderr` / `timeoutMs` / `envs` / `cwd` / `background`, `commands.connect` / `kill`, `files.read` / `write` / `list` / `exists` / `remove` / `makeDir` / `rename`), with E2B's error classes and `Unsupported` for the rest. Callbacks stream; background output is polled about once a second.

## 0.6.0 - 2026-11-22

- Retries on every request path: a POST that is not idempotent is now resent on the answers that refused it before anything ran, 503 `database_busy` (kosa8 Cloud's database was overloaded), 409 `template_building` (a benchmark environment still being built) and 429, with full-jitter backoff, bounded attempts, and at least the `Retry-After` header or the body's `retry_after` (new) / `retry_after_s` seconds. `retryable: true` in an error body is honoured as before. `database_busy`, `template_building` and `idempotency_in_progress` are retryable `infra` even without a body class, and `invalid_*`/`bad_*`/`missing_*`/`unknown_*` 4xx codes are `client`, as on the server.
- `cloud.apiKeys`: `list`, `create({ name, scopes, expiresInS })`, `revoke(id)`, `rotate(id, { graceS })`.
- `cloud.webhooks`: `list`, `create(url, { events, description })`, `delete`, `deliveries(id, { limit })`, `test(id)`.
- `cloud.audit`: `list({ sandboxId, actor, action, since, until, beforeSeq, limit })`, `verify()`, `export()` (the NDJSON export, parsed).
- `cloud.benchmarks`: `list`, `get(name)`, `instances(name, { state, limit, cursor })`, `instance(name, id)`, `prepare(name, ids | 'all' | n, { seed })`.
- `cloud.rl`: `compare(ids)` (2 to 4 runs) and `alerts` (`list({ runId })`, `create({ kind, threshold, window, runId })`, `update(id, { threshold, window, enabled })`, `delete(id)`).
- `cloud.pricing()`, `cloud.limits()`, `cloud.requestLimit(maxRunning, reason)`, `cloud.usageInsights()`, `cloud.lineage()`, `cloud.checkpoints()` (every sandbox's), `cloud.images()`, `cloud.functions.invocations(name, { limit })`.
- `cloud.browsers.cdp(id)`: a fresh CDP WebSocket URL and its expiry. `cloud.ai.gatewayUrl(provider, path?)`: the AI gateway's base URL (`…/v1/ai/gw/{provider}/`) for pointing an OpenAI or Anthropic client at it.
- `SDK_VERSION` and `USER_AGENT` (`kosa8-js/0.6.0`), sent as the User-Agent outside a browser.
- Background exec status/stop, preview, schedule and code-context deletes spell out their full `/v1/sandboxes/{id}/…` paths (no behaviour change).
- README: small sizes in the quickstart, the retry rules, what persists between execs (each exec is a fresh process; `/workspace` lasts for the sandbox's life; the rest needs `persistent: true`), the AI gateway from outside a sandbox, and that overflow (Cloudflare) sandboxes have no fork, checkpoint or sleep (501 `not_available`, `Kosa8UnsupportedError`).

### Also in 0.6.0 (merged earlier)

- Cloud browsers: `cloud.browser({ ttlS, sandboxId, name })` opens headless Chromium and returns a `CloudBrowser` with `id`, `cdpUrl` (for Playwright `connectOverCDP` / Puppeteer `connect({ browserWSEndpoint })`), `refresh()`, `goto(url, { text })`, `screenshot(url, { fullPage })` (PNG bytes), `page(...)`, `close()` and `[Symbol.asyncDispose]` (`await using`). Also `cloud.browsers.create/list/get/delete/info`, `cloud.listBrowsers({ state })` and `cloud.getBrowser(id)`. $0.12 per browser-hour, billed per second.
- AI gateway: `cloud.ai` (`settings`, `updateSettings`, `setKey`, `keys`, `deleteKey`, `usage(month)`) and the shortcuts `cloud.setAiKey`, `listAiKeys`, `deleteAiKey`, `aiSettings`, `updateAiSettings`, `aiUsage`. `sandboxes.create({ aiGateway: true | false })`.

## 0.5.3 — 2026-11-22

- Actionable kosa8 Cloud errors. An API error's message is the server's sentence followed by `[HTTP <status> <code>; retry in <n> s; request <id>]` (and `; upgrade: <url>` on a 402 whose sentence lacks it); the bare sentence stays in `daemonMessage`. A 401 adds "check KOSA8_API_KEY; make a new key at https://app.kosa8.com/app#keys".
- `Kosa8Error.requestId`: the answer's `X-Request-Id`, else Cloudflare's `cf-ray`, to quote to kosa8 support.
- `retryAfter` now reads a Retry-After header on any error status (it was 429 and 503 only), falling back to the body's `retry_after_s` (409 `template_building`, 409 `idempotency_in_progress`, 503 `no_capacity`); new alias `retryAfterS`.
- Client-side errors say what to do next: a missing or malformed key points at `KOSA8_API_KEY` and https://app.kosa8.com/app#keys, a timeout says to retry or raise `timeoutMs`, a connection failure says to check the network and `KOSA8_CLOUD_URL`.
- An exec stopped by its own `timeoutS` throws `Kosa8ExecTimeoutError` without the hint about the 90 s buffered limit (it read as if the 90 s limit had stopped it), as in the Python, Go, Ruby and Java SDKs.
- README: `npm install @kosa8/sdk` (the old `@^0.4.0` kept installs on 0.4.1); what persists between commands (only `/workspace`, unless the sandbox is persistent) matches the server; `exec({ timeoutS })` is shown; a "same thing in each language" table for the five SDKs.

## 0.5.2

- `cloud.jobs`: hosted jobs on kosa8 Cloud, as in the Python SDK. `submit` (tasks as a list or JSONL text, solver and sealed grader, grader files from bytes or text; sent with an Idempotency-Key), `get`, `list({ status, project, limit, cursor })`, `cancel`, `wait({ progress, pollMs, timeoutMs })` and `estimate` (ranges of sandbox-hours and list USD; `sample: n` pilot jobs, `sampleJobId`). Also `jobBody`, `loadJobTasks`, `encodeJobFiles`, `jobDone`, `JOB_DONE_STATES`. Needs the kosa8 Cloud `/v1/jobs` routes.

## 0.5.1

- Failure class `oom`: exit 137 with the guest kernel's OOM count raised (kosa8 Cloud reports it on exec and grade; a grade killed for memory has no reward). It can be added to a rollout mask.

## 0.5.0 — 2026-11-21

The kosa8 Cloud API for RL training and fan-out, mirroring the Python SDK's `kosa8.rl` (0.5.0). Everything from 0.4.x works as before.

- `cloud.sandboxes.createMany(n, opts)` (`POST /v1/sandboxes/batch`, 1 to 1000): any create field, plus `labels`, `runId`, `leaseS`, `prefix`, `partialOk` (default true) and `wait`. Answers a `CloudSandboxBatch`: an array of `CloudSandbox` with `failed` (`index`, `code`, `message`, `failure_class`, `retryable`), `requested` and `created`. A sandbox that fails to boot is deleted and moved to `failed`.
- `box.fork(n, { labels, runId, leaseS, prefix, partialOk })` or `box.fork({ n, … })`: up to 1000 copies (was 100). A plain `fork(n)` of at most 100 still sends `{ n }` and is all or nothing; it now answers a `CloudSandboxBatch` (still an array).
- `cloud.sandboxes.heartbeat({ runId | labels | ids, extendS })`, `box.heartbeat()`, `cloud.sandboxes.drain({ runId | labels | ids })`.
- `box.grade(cmd, { files, timeoutS, env, keep, runId, rollout })` and `cloud.sandboxes.grade(id, …)`: a sealed copy with no network and hidden files; `{ reward, metrics, rewardFrom, exitCode, stdout, stderr, failureClass, retryable, ms, graderId, kept, recorded, raw }`. `reward` is `null` when the command did not finish.
- `create({ leaseS, runId, record, idempotencyKey })`: a lease (60 to 86400 s, not with `ttlS`), the `kosa8.run` label, desktop recording.
- `create({ labels })` sends the labels in the create body (stored before it answers) instead of a second `PUT …/labels` call.
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
