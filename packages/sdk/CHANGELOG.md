# Changelog

## Unreleased

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
