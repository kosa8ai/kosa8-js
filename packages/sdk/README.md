# @kosa8/sdk

Typed TypeScript client for [kosa8](https://kosa8.com). kosa8 gives every AI agent its own sealed machine. This package talks to both places those machines run:

- **kosa8 Cloud** (`Kosa8Cloud`): sandboxes on kosa8's hosts, over HTTPS at `https://api.kosa8.com`, with an API key. Nothing to install.
- **The local daemon** (`Kosa8Client`): microVMs on your own Mac or Linux box, over the daemon's unix socket, with egress allow-lists, the sandbox toolbox, checkpoint and rewind, fork, explore and snapshots.

No runtime dependencies. ESM and CommonJS builds with `.d.ts` types. Node 18 or later. Errors are typed and keep the server's own words.

## kosa8 Cloud quickstart

```sh
npm install @kosa8/sdk@^0.4.0
export KOSA8_API_KEY=k8c_live_...   # make one at https://app.kosa8.com
```

```ts
import { Kosa8Cloud } from '@kosa8/sdk';

const cloud = new Kosa8Cloud(); // reads KOSA8_API_KEY; talks to https://api.kosa8.com

// Deleted automatically in an hour, even if this script dies.
const box = await cloud.sandboxes.create({ ttlS: 3600 });

const r = await box.exec('echo hello > /workspace/hi.txt && cat /workspace/hi.txt');
console.log(r.exitCode, r.stdout); // 0 "hello\n"

// Files (needs the host's data plane; see below).
await box.files.write('/workspace/data.json', JSON.stringify({ n: 42 }));
console.log(await box.files.readText('/workspace/data.json'));
console.log((await box.files.list()).map((f) => f.name)); // /workspace by default

await box.delete();
```

`KOSA8_CLOUD_URL` overrides the address (https only, except localhost). Pass `{ apiKey, baseUrl }` to the constructor instead of using the environment if you prefer.

### The base template

With no `template`, a sandbox starts from the org's default, `base`:

- Alpine Linux. `sh` is busybox: there is **no bash, python or git**. For Python, create with `{ template: 'python' }`, or pick another from `await cloud.templates()`.
- **Each exec runs in a fresh container; only `/workspace` persists** between calls. Install packages into `/workspace` (for example `pip install --target /workspace/lib ...` on the `python` template), not into the system.
- A buffered `exec` is cut off after about **30 s** by the Cloud API today, raised as `Kosa8ExecTimeoutError`. Start long jobs in the background and poll:

  ```ts
  await box.exec("nohup sh -c 'sleep 120; echo done' > /workspace/job.log 2>&1 &");
  // later
  console.log((await box.exec('cat /workspace/job.log')).stdout);
  ```

- A request body is at most **64 KiB** (`413 too_large`), so send big inputs as files. A file is at most **8 MiB** through the API.

### Sandboxes

| method | endpoint |
| --- | --- |
| `cloud.sandboxes.create({ template?, region?, sleepAfterS?, ttlS?, deleteAfter?, acceptPrice? })` → `CloudSandbox` | `POST /v1/sandboxes` |
| `cloud.sandboxes.list({ all?, limit?, cursor? })` → `CloudSandbox[]` | `GET /v1/sandboxes` |
| `cloud.sandboxes.listPage({ all?, limit?, cursor? })` → `{ sandboxes, nextCursor }` | `GET /v1/sandboxes` |
| `cloud.sandboxes.iterate({ all?, limit? })` → async iterable of `CloudSandbox` | every page, following `nextCursor` |
| `cloud.sandboxes.get(id)` → `CloudSandbox` | `GET /v1/sandboxes/{id}` |
| `cloud.templates()` → `CloudTemplate[]` | `GET /v1/templates` |
| `box.exec(cmd, { image?, env? })` → `{ exitCode, stdout, stderr, wokeMs? }` | `POST …/exec` (a string runs through `sh -c`) |
| `box.update({ ttlS?, deleteAfter?, sleepAfterS? })` → `{ sandbox, notes }` | `PATCH /v1/sandboxes/{id}`; `{ ttlS: null }` clears the lifetime |
| `box.sleep()`, `box.wake()`, `box.refresh()`, `box.delete()` | `POST …/sleep`, `POST …/wake`, `GET`, `DELETE` |

`ttlS` is seconds from now (60 to 7776000, 90 days); `deleteAfter` is a time (Unix ms or a `Date`). Give one or the other; both are checked before any request is made. `sleepAfterS` is idle seconds before the sandbox sleeps (0 to 604800; 0 never). `acceptPrice` is for a paid kosa8 Store item: its current price in USD, which the person agreed to. `box.info` is a `CloudSandboxInfo`: `state`, `template`, `source` (`pool`, `restore`, `cold` or `fork`), `parent_id`, `delete_after`, `sleep_after_s`, `host_unreachable`, `origin_item_version`, `region`, `own_host`, `cost_usd` and the rest of the API's Sandbox schema.

The Cloud API is adding cursor pagination. Until it has, `limit` and `cursor` are ignored, every sandbox comes back at once and `nextCursor` is `null`; `iterate()` works either way.

### Files, checkpoints, rewind, fork and ports (data plane)

These need the host's data plane. On hosts without it the API answers 501 (`not_available`/`not_supported`), thrown as `Kosa8UnsupportedError`: they may answer 501 on current hosts, because not every kosa8 Cloud host has the data plane yet. `GET /v1/capabilities` says whether your org's hosts have it.

| method | endpoint |
| --- | --- |
| `box.files.read(path)` → `Uint8Array`, `box.files.readText(path)` → `string` | `GET …/files?path=` (raw bytes) |
| `box.files.write(path, string \| Uint8Array)` → `CloudFileInfo` | `PUT …/files?path=` (raw bytes) |
| `box.files.list(path = '/workspace')` → `CloudFileInfo[]` | `GET …/files/list?path=` |
| `box.files.mkdir(path)` → `CloudFileInfo` | `POST …/files/mkdir` |
| `box.files.delete(path, { recursive? })` → the removed path | `DELETE …/files?path=` |
| `box.checkpoint(label?)` → `CloudCheckpoint` | `POST …/checkpoints` (the newest 10 are kept) |
| `box.checkpoints()` → `CloudCheckpoint[]` | `GET …/checkpoints` (oldest first) |
| `box.rewind(checkpointOrId)` → `{ checkpoint, backup, ms }` | `POST …/rewind` (the state before is saved as `backup`) |
| `box.fork(n = 1)` → `CloudSandbox[]` | `POST …/fork` (1 to 100 copies, all or nothing) |
| `box.ports()` → `{ port, address, container, loopback }[]` | `GET …/ports` |

```ts
const cp = await box.checkpoint('before the risky bit');
await box.exec('rm -rf /workspace/*');
await box.rewind(cp);                 // /workspace is back
const [copy] = await box.fork(1);     // a second sandbox, as this one is now
```

The Cloud API has no sandbox labels or metadata.

### Functions

```ts
await cloud.functions.deploy('hello', {
  runtime: 'python3.12',
  code: 'def handler(event):\n    return {"hello": event.get("name", "world")}\n',
});
const out = await cloud.functions.invoke('hello', { name: 'kosa8' });
console.log(out.ok, out.result); // true { hello: 'kosa8' }
```

`cloud.functions` also has `list`, `get`, `delete` and `map`. `cloud.me()` and `cloud.usage()` answer the org and this month's bill.

### Cloud errors

Every error from the cloud is a `Kosa8Error` with the cloud's stable `code`, its sentence as `message`, `status`, and the whole answer as `body`.

| class | when |
| --- | --- |
| `Kosa8PaymentRequiredError` | 402: `code` is `payment_required`, `spending_cap_reached`, `price_not_accepted`, … `upgradeUrl` is where the person adds a card or credit and `agentMessage` is a sentence an agent should relay word for word (each `null` when absent) |
| `Kosa8OrgFrozenError` | 423 `org_frozen`: the org is frozen in the Security Center; an owner or admin must unfreeze it |
| `Kosa8RateLimitError` | 429: rate limited or a quota reached (`quota_exceeded`); `retryAfter` is the Retry-After header in seconds, when sent |
| `Kosa8ExecTimeoutError` | a buffered exec ran past about 30 s (504, `exec_timeout`, or a 502 `host_failed` on exec that timed out); run the job in the background instead |
| `Kosa8UnsupportedError` | 501 `not_available`/`not_supported`: this host has no data plane yet |
| `Kosa8NotFoundError`, `Kosa8BadRequestError`, `Kosa8AuthError`, `Kosa8ConflictError` | 404, 400, 401, 409 |
| `Kosa8ConnectionError`, `Kosa8TimeoutError` | the cloud could not be reached, or did not answer in time (default 120 s, `timeoutMs`) |

```ts
import { Kosa8Cloud, Kosa8ExecTimeoutError, Kosa8PaymentRequiredError } from '@kosa8/sdk';

const cloud = new Kosa8Cloud();
try {
  const box = await cloud.sandboxes.create({ ttlS: 600 });
  await box.exec('sleep 45');
} catch (err) {
  if (err instanceof Kosa8PaymentRequiredError) {
    console.log(err.code, err.agentMessage ?? err.message, err.upgradeUrl);
  } else if (err instanceof Kosa8ExecTimeoutError) {
    console.log('run it in the background:', err.message);
  } else {
    throw err;
  }
}
```

## Local daemon

`Kosa8Client` talks to the kosa8 daemon on your own machine over its unix socket. It covers sandboxes, running and exec'ing commands, the sandbox toolbox (code, files, git, shell sessions, terminals, previews, lifecycle, templates), checkpoint and rewind, fork, explore, and snapshots. Every endpoint, field and response shape comes from the daemon's source.

### Requirements

- kosa8 installed, with its daemon running (`kosa8 daemon start`). Install it with:

  ```sh
  curl -fsSL https://kosa8.com/install.sh | sh
  ```

- macOS on Apple silicon, or x86-64 Linux.
- Node.js 18 or later.

### Install

```sh
npm install @kosa8/sdk@^0.4.0
```

### Quickstart

```ts
import { Kosa8Client } from '@kosa8/sdk';

const kosa8 = new Kosa8Client(); // $HOME/.kosa8/run/kosa8.sock

console.log(await kosa8.version());

// A microVM that can reach only api.anthropic.com.
const { sandbox } = await kosa8.createSandbox({
  name: 'demo',
  egressAllow: ['api.anthropic.com'],
});

// The sandbox has its own container engine. Images are fetched on the host.
await kosa8.pullIntoSandbox('demo', 'alpine:latest');

// Run a container to completion.
const r = await kosa8.run('demo', 'alpine:latest', ['sh', '-c', 'echo hi; exit 3']);
console.log(r.exitCode, r.stdout); // 3 "hi\n"

// Or keep a container running and exec into it.
const cid = await kosa8.startContainer('demo', 'alpine:latest', ['sh', '-c', 'while :; do sleep 3600; done']);
await kosa8.exec('demo', cid, ['sh', '-c', 'echo v1 > /note']);

// Undo button: checkpoint, break something, rewind. Processes come back too.
await kosa8.checkpoint('demo', { label: 'before the risky bit' });
await kosa8.exec('demo', cid, ['sh', '-c', 'rm /note']);
await kosa8.rewind('demo');
console.log((await kosa8.exec('demo', cid, ['cat', '/note'])).stdout); // "v1\n"

// Try approaches in parallel, then keep the one that works.
const best = await kosa8.explore('demo', { variants: ['npm test', 'make test'] });
console.log(best.winner);

await kosa8.deleteSandbox('demo');
```

`kosa8.sandbox('demo')` returns a handle with the same methods, already bound to that sandbox (`run`, `exec`, `checkpoint`, `rewind`, `fork` and the rest).

### How commands run

A kosa8 sandbox is a microVM that runs its own container engine. `run` starts a container from an image and runs it to completion. `startContainer` starts a detached one, and `exec` runs a command in it. A sandbox's engine does not pull images by itself, so pull first with `pullIntoSandbox`. The image is fetched on the host and checked against your org's registry policy, so pulling works even when the sandbox has no network.

### API reference

All methods return promises. Every method takes `{ approval?, signal? }` as its last argument: `approval` is a signed-approval id (see Errors), and `signal` is an `AbortSignal`.

#### Client

`new Kosa8Client(options?)`

| option | default | |
| --- | --- | --- |
| `socketPath` | `$HOME/.kosa8/run/kosa8.sock` | daemon socket |
| `host` | `KOSA8_HOST` | remote worker: `https://…`, `tcp://host:port`, `host:port`, or `unix:///path.sock` |
| `token` | `KOSA8_TOKEN` (with `KOSA8_HOST`) | bearer token for a remote worker |
| `insecure` | `KOSA8_INSECURE=1` | allow plain http to a non-loopback host (refused by default, as in the CLI) |
| `workerFile` | `$HOME/.kosa8/worker.json` | the CLI's saved worker connection, used when no `host`, `KOSA8_HOST` or `socketPath` is given; `null` reads none |
| `actor` | `'tool'` | `X-Kosa8-Actor`: how the audit log files these requests (`human`, `agent`, `tool`) |
| `agentToken` | `KOSA8_AGENT_TOKEN` | agent identity token, for policies that require one |
| `checkpointStore` | `FileCheckpointStore` (`~/.kosa8/checkpoints.json`) | where checkpoint stacks live; `MemoryCheckpointStore` keeps them in memory |

Where requests go, in order: `host` or `KOSA8_HOST`; else the connection the
CLI saved (`kosa8 wsl setup` on Windows, where the engine runs in WSL2, or
`kosa8 worker join` anywhere), with its token; else the local daemon's socket.
So on Windows, once `kosa8 wsl setup` has run, `new Kosa8Client()` reaches the
WSL2 engine with no configuration.

#### Status

| method | endpoint |
| --- | --- |
| `health()` → `{ status, version, commit, go, uptime_seconds, phase }` | `GET /kosa8/v1/health` |
| `version()` → `string` | `GET /kosa8/v1/health` |
| `pull(ref)` | `POST /kosa8/v1/pull` (host engine) |

#### Sandboxes

| method | endpoint |
| --- | --- |
| `createSandbox({ name?, cpus?, memMb?, diskGb?, mounts?, egress?, egressAllow?, capture?, labels?, broker?, autoStopMin?, ttlMin?, autoDeleteMin?, ephemeral?, template? })` → `{ sandbox, boot_ms, broker? }` | `POST /kosa8/v1/sandboxes` |
| `listSandboxes()` → `Sandbox[]` | `GET /kosa8/v1/sandboxes` |
| `getSandbox(idOrName)` → `Sandbox \| undefined` | (from the list) |
| `startSandbox(id)` | `POST /kosa8/v1/sandboxes/{id}/up` |
| `stopSandbox(id)` | `POST /kosa8/v1/sandboxes/{id}/down` |
| `deleteSandbox(id, { wipe?, keepCheckpoints? })` | `DELETE /kosa8/v1/sandboxes/{id}` (drops its checkpoints too, as `kosa8 sandbox rm` does) |
| `pullIntoSandbox(id, ref)` | `POST /kosa8/v1/sandboxes/{id}/pull` |
| `sandboxImages(id)`, `sandboxContainers(id)` | `GET …/images`, `GET …/containers` |
| `sandboxEgress(id)` → the policy enforced, and pass/deny counters | `GET …/egress` |

`egress` takes `'deny'`, `'any'`, `'fakenet'`, `'allow:a.com,*.b.com,10.0.0.0/8'` or `{ allow: [...] }`. `egressAllow: [...]` is shorthand for the allow-list. If you set neither, the daemon applies the org policy's default egress, or `any` when there is none. `broker` puts the sandbox behind kosa8's egress broker: real credentials stay on the host and the sandbox holds only placeholders (returned in `broker.placeholders`). `autoStopMin` stops the sandbox after that many idle minutes, `ttlMin` that long after it was created, `autoDeleteMin` deletes it once it has been stopped that long, and `ephemeral` deletes it whenever it stops. `template` starts it with a template's image (see Toolbox).

#### Run and exec

| method | endpoint |
| --- | --- |
| `run(id, image, args?, { env?, onStdout?, onStderr?, onStatus? })` → `ExecResult` | `POST …/run` |
| `startContainer(id, image, args?)` → container id | `POST …/start` |
| `exec(id, container, args, { onStdout?, onStderr? })` → `ExecResult` | `POST …/exec` |
| `execFrames(id, container, args)` → async iterable of frames | `POST …/exec` |
| `startInteractive(id, image, args?, { env?, tty? })` → container id | `POST …/start-interactive` |
| `writeStdin(id, container, data \| asyncIterable)` | `POST …/containers/{cid}/stdin` |
| `attach(id, container)` → `ExecResult` | `POST …/containers/{cid}/attach` |

`ExecResult` is `{ exitCode, stdout, stderr, stdoutBytes, stderrBytes }`. A non-zero exit code is a result, not an error.

#### Toolbox

The toolbox is for agents that want to work in a sandbox the way they work on a laptop: run a snippet, read and write files, use git, keep a shell. None of it needs an image pulled first; the daemon picks one (or the sandbox template's).

```ts
const sb = kosa8.sandbox('demo');

const r = await sb.runCode('print(6 * 7)');            // python by default
console.log(r.ok, r.stdout, r.artifacts);              // matplotlib charts come back as PNG bytes

await sb.writeFile('/workspace/app.py', 'print("hi")\n');
console.log(await sb.readText('/workspace/app.py'));

await sb.gitClone('https://github.com/octocat/Hello-World.git', { path: 'hw', depth: 1 });
await sb.gitCommit('hw', 'my change', { authorName: 'Agent', authorEmail: 'agent@example.com' });

await sb.shell('cd /tmp && export FOO=bar');           // the session "main" is made on first use
console.log((await sb.shell('echo $FOO; pwd')).stdout); // "bar\n/tmp\n"
```

| method | endpoint |
| --- | --- |
| `runCode(id, code, { language?, image?, env?, timeoutS? })` → `CodeResult` | `POST …/code` |
| `listFiles(id, path?)`, `statFile(id, path)` → `FileInfo` | `GET …/files`, `GET …/files/stat` |
| `readFile(id, path)` → `Buffer`, `readText(id, path)` → `string` | `GET …/files/content` |
| `writeFile(id, path, data, { mode? })` | `PUT …/files/content` (bytes, a string or an async iterable) |
| `deleteFile(id, path, { recursive? })`, `makeDir(id, path)`, `moveFile(id, from, to)` | `DELETE …/files`, `POST …/files/mkdir`, `POST …/files/move` |
| `git(id, op, fields)` → `GitResult` | `POST …/git` (`clone`, `status`, `add`, `commit`, `push`, `pull`, `checkout`, `branches`, `log`, `diff`) |
| `gitClone(id, url, { path?, depth?, … })`, `gitStatus(id, path)`, `gitCommit(id, path, message, { addAll? })` | `POST …/git` (`gitCommit` stages everything first) |
| `createSession(id, name?, { image?, env? })`, `listSessions(id)`, `deleteSession(id, name)` | `POST/GET …/sessions`, `DELETE …/sessions/{name}` |
| `sessionExec(id, session, command, { timeoutS? })` → `ShellResult` | `POST …/sessions/{name}/exec` |
| `shell(id, command, { session?, timeoutS? })` → `ShellResult` | as `sessionExec`, making the session (default `main`) on first use |
| `startPty(id, { image?, command?, cols?, rows?, env? })` → container id, `resizePty(id, cid, cols, rows)` | `POST …/pty`, `POST …/containers/{cid}/resize` |
| `createPreview(id, port, { session?, container?, expiresInS? })` → `{ url, token, expires_at, … }` | `POST …/previews` |
| `revokePreviews()` | `POST /kosa8/v1/previews/rotate` (ends every preview link) |
| `setLifecycle(id, { autoStopMin?, ttlMin?, autoDeleteMin?, ephemeral? })` → `Sandbox` | `POST …/lifecycle` (left out keeps its value, 0 turns it off) |
| `listTemplates()`, `deleteTemplate(name)` | `GET /kosa8/v1/templates`, `DELETE /kosa8/v1/templates/{name}` |
| `buildTemplate(name, contextDir?, { dockerfile?, buildArgs?, egress?, replace?, onOutput? })` → final frame | `POST /kosa8/v1/templates` |

`CodeResult` is `{ ok, exitCode, stdout, stderr, language, image, artifacts, durationMs, timedOut, truncated }` and `ShellResult` is `{ ok, exitCode, stdout, stderr, cwd, durationMs, timedOut, truncated }`. As with `run`, a non-zero exit code is a result, and so is a git failure (`ok: false`). Only a refusal throws. `buildTemplate` packs the context directory as a tar, leaving out what `.dockerignore` names (paths and their prefixes), builds it in a throwaway sandbox, and keeps the image, so that `createSandbox({ template })` starts from it. A failed build throws `Kosa8StreamError`. The sandbox handle has every per-sandbox toolbox method, with the sandbox id already bound (`sb.runCode(code)`, `sb.sessions()`, …).

#### Snapshots, fork, explore

| method | endpoint |
| --- | --- |
| `snapshot(id, { id?, encrypt? })` | `POST …/snapshot` |
| `listSnapshots()` | `GET /kosa8/v1/snapshots` |
| `restoreSnapshot(snapshotId, { name?, label?, allowTampered? })` | `POST /kosa8/v1/snapshots/{id}/restore` |
| `deleteSnapshot(snapshotId, { wipe?, force? })` | `DELETE /kosa8/v1/snapshots/{id}` |
| `fork(id, { n?, prefix?, label? })` → `{ forks, snapshot, fork_ms, count }` | `POST …/fork` |
| `explore(id, { variants, image?, keepAll?, keep?, timeoutMs?, prefix?, pull? })` → `{ branches, winner, removed }` | pull, fork, then a run in each branch, as `kosa8 explore` |

`explore` forks the sandbox once per variant and runs `sh -c VARIANT` in `image` (default `alpine:latest`) in every branch at the same time. It keeps the fastest successful branch and deletes the others. It pulls `image` into the parent first, so every branch already has it (turn this off with `pull: false`).

#### Checkpoints

| method | |
| --- | --- |
| `checkpoint(id, { label? })` → `{ checkpoint, evicted, snapshot }` | snapshot `<id>-ckpt-<n>`, recorded on the sandbox's stack (at most 10, oldest evicted) |
| `listCheckpoints(id)` | oldest first |
| `rewind(id, { to? })` → `{ sandbox, checkpoint, dropped, restore_ms }` | back to the latest checkpoint, or to one named by id or label, with processes resumed |

The daemon has no checkpoint endpoint. Checkpoints are bookkeeping kept on the client side over snapshots, exactly as in the kosa8 CLI and MCP server. By default they go in the CLI's own store, so `kosa8 rewind` sees checkpoints you took with the SDK, and the SDK sees the CLI's. A rewind deletes the sandbox and restores the checkpoint under the same name, and checkpoints taken after the target are discarded.

### Errors

Every error extends `Kosa8Error`. An error from the daemon carries `status`, `daemonMessage` (the daemon's `error`, verbatim) and `remediation` (what to do), and its `message` is `"<error> (<remediation>)"`.

| class | when |
| --- | --- |
| `Kosa8ConnectionError` | the daemon cannot be reached (is it running?) |
| `Kosa8BadRequestError` | 400: for example an egress policy the daemon refuses |
| `Kosa8AuthError` | 401: remote worker token or agent token |
| `Kosa8PolicyError` | 403: refused by the org policy, the registry allow-list or labels |
| `Kosa8ApprovalRequiredError` | 403: the policy wants signed approval from named people. `error.approval` is the daemon's refusal (`why`, `signers`, `request_command`, `requirement`, …) |
| `Kosa8NotFoundError` | 404 |
| `Kosa8ConflictError` | 409: for example the sandbox exists but is stopped, or a snapshot id is already taken |
| `Kosa8UnsupportedError` | 501: no microVM backend on this platform |
| `Kosa8StreamError` | a run, exec or template build ended with an error frame (output so far in `stdout`/`stderr`), or a file read was cut short |
| `Kosa8CheckpointError` | no checkpoint to rewind to, or an invalid name |

The kosa8 Cloud errors (`Kosa8PaymentRequiredError`, `Kosa8OrgFrozenError`, `Kosa8RateLimitError`, `Kosa8ExecTimeoutError`) are listed under [Cloud errors](#cloud-errors).

When an action needs approval, a human opens a request (`error.approval.request_command`), the approvers sign it, and you repeat the call with the id:

```ts
try {
  await kosa8.fork('web', { n: 8 });
} catch (err) {
  if (err instanceof Kosa8ApprovalRequiredError) {
    console.log(err.approval.why, err.approval.signers, err.approval.request_command);
    // later: await kosa8.fork('web', { n: 8, approval: 'APPROVAL_ID' });
  }
}
```

## License

MIT. The license covers this SDK package only, not kosa8 itself.
