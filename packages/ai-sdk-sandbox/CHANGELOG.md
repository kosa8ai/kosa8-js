# Changelog

## 0.2.3 - 2026-11-24

- Accepts @kosa8/sdk 0.9 (`^0.4.1 || ^0.5.0 || ^0.6.0 || ^0.7.0 || ^0.8.0 || ^0.9.0`); @kosa8/sdk 0.9.0 is the first release that sends `repo`.
- `repo` on `createKosa8CloudSandboxSession` / `createKosa8CloudSandbox`: start in a checkout of a repo from the org's connected GitHub (`"owner/name[@ref]"` or `{ name, ref, path, depth }`); the checkout is the default working directory. `session.sandbox.pullRequest()` sends changes back. Cloning needs @kosa8/sdk 0.9.0 or later. `repoWorkingDirectory(spec)` and the `Kosa8CloudRepo` type are exported.

## 0.2.2 - 2026-11-23

- Accepts @kosa8/sdk 0.6, 0.7 and 0.8 (`^0.4.1 || ^0.5.0 || ^0.6.0 || ^0.7.0 || ^0.8.0`), so a project on @kosa8/sdk 0.8 shares one copy; the published 0.2.1 takes only `^0.4.1 || ^0.5.0`, so it paired a newer @kosa8/sdk with a second 0.5 copy.

## 0.2.1

- Accepts @kosa8/sdk 0.5.0 (`^0.4.1 || ^0.5.0`).

## 0.2.0 — 2026-11-17

kosa8 Cloud.

- `createKosa8CloudSandboxSession(options)`: an AI SDK 7 `HarnessV1NetworkSandboxSession` (and `Experimental_SandboxSession` through `restricted()`) on a kosa8 Cloud sandbox, with an API key (`KOSA8_API_KEY` or `apiKey`). Takes a kosa8 Cloud `template` key or an AI SDK `{ identity, prepare }` template (kept as a kosa8 Cloud snapshot), `image`, `size`, `cpus`/`memMb`, `diskGb`, `region`, `ttlS`, `sleepAfterS`, `persistent`, `cpu`, `secrets`, `labels`, `networkPolicy` or `egress`, `workingDirectory`, `env`, `setupCommands`, `commandTimeoutS` and `pollIntervalMs`.
- `resumeKosa8CloudSandboxSession({ sandboxId })` (an `sbx_…` id or a name) wakes a sleeping sandbox; `createKosa8CloudSandboxSessionFromSandbox({ sandbox })` wraps one you own (`stop()`/`destroy()` leave it alone); `createKosa8CloudSandbox()` / `Kosa8CloudSandboxProvider` is the provider shape.
- Commands run as background execs, so they are not held to the 90 s limit of a buffered exec; output streams by polling, stderr stays apart from stdout, and `kill()`/`abortSignal` stop the command through the API.
- Files go through the files API in 8 MiB parts, staged in `/workspace/.kosa8-run`, and reach any path (parent folders made); a host without the files API gets them through exec.
- `stop()` sleeps the sandbox, `destroy()` deletes it, `setNetworkPolicy()` changes egress while it runs (including `deniedCIDRs`), `getPortEndpoint()`/`setPorts()` open private previews.
- Needs `@kosa8/sdk` 0.4.1 (background-exec `stop()`, `timeoutS`).
- The local daemon session is unchanged.

## 0.1.2

- Released with `@kosa8/sdk` 0.4.0; accepts `@kosa8/sdk` 0.1 to 0.4.

## 0.1.1

- Close the exec stream at the done frame, so the process exits after a command.

## 0.1.0

- First release: AI SDK 7 sandbox sessions on the local kosa8 daemon.
