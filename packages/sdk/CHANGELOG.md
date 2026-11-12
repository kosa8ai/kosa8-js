# Changelog

## 0.4.0 — 2026-11-12

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
