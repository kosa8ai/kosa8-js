# Changelog

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
