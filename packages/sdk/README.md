# @kosa8/sdk

Typed TypeScript client for the [kosa8](https://kosa8.com) native API. kosa8 gives every AI agent its own sealed machine: a real microVM with its own kernel, with the network closed except for the hosts on an allow-list you write. This package talks to the kosa8 daemon over its unix socket. It covers sandboxes, running and exec'ing commands, the sandbox toolbox (code, files, git, shell sessions, terminals, previews, lifecycle, templates), checkpoint and rewind, fork, explore, and snapshots.

- No runtime dependencies. It uses Node's own `http` with `socketPath`.
- ESM and CommonJS builds with `.d.ts` types. Node 18 or later.
- Every endpoint, field and response shape comes from the daemon's source.
- Errors are typed and keep the daemon's own words: what went wrong, and what to do about it.

## Requirements

- kosa8 installed, with its daemon running (`kosa8 daemon start`). Install it with:

  ```sh
  curl -fsSL https://kosa8.com/install.sh | sh
  ```

- macOS on Apple silicon, or x86-64 Linux.
- Node.js 18 or later.

## Install

```sh
npm install @kosa8/sdk
```

## Quickstart

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

## How commands run

A kosa8 sandbox is a microVM that runs its own container engine. `run` starts a container from an image and runs it to completion. `startContainer` starts a detached one, and `exec` runs a command in it. A sandbox's engine does not pull images by itself, so pull first with `pullIntoSandbox`. The image is fetched on the host and checked against your org's registry policy, so pulling works even when the sandbox has no network.

## API reference

All methods return promises. Every method takes `{ approval?, signal? }` as its last argument: `approval` is a signed-approval id (see Errors), and `signal` is an `AbortSignal`.

### Client

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

### Status

| method | endpoint |
| --- | --- |
| `health()` → `{ status, version, commit, go, uptime_seconds, phase }` | `GET /kosa8/v1/health` |
| `version()` → `string` | `GET /kosa8/v1/health` |
| `pull(ref)` | `POST /kosa8/v1/pull` (host engine) |

### Sandboxes

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

### Run and exec

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

### Toolbox

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

### Snapshots, fork, explore

| method | endpoint |
| --- | --- |
| `snapshot(id, { id?, encrypt? })` | `POST …/snapshot` |
| `listSnapshots()` | `GET /kosa8/v1/snapshots` |
| `restoreSnapshot(snapshotId, { name?, label?, allowTampered? })` | `POST /kosa8/v1/snapshots/{id}/restore` |
| `deleteSnapshot(snapshotId, { wipe?, force? })` | `DELETE /kosa8/v1/snapshots/{id}` |
| `fork(id, { n?, prefix?, label? })` → `{ forks, snapshot, fork_ms, count }` | `POST …/fork` |
| `explore(id, { variants, image?, keepAll?, keep?, timeoutMs?, prefix?, pull? })` → `{ branches, winner, removed }` | pull, fork, then a run in each branch, as `kosa8 explore` |

`explore` forks the sandbox once per variant and runs `sh -c VARIANT` in `image` (default `alpine:latest`) in every branch at the same time. It keeps the fastest successful branch and deletes the others. It pulls `image` into the parent first, so every branch already has it (turn this off with `pull: false`).

### Checkpoints

| method | |
| --- | --- |
| `checkpoint(id, { label? })` → `{ checkpoint, evicted, snapshot }` | snapshot `<id>-ckpt-<n>`, recorded on the sandbox's stack (at most 10, oldest evicted) |
| `listCheckpoints(id)` | oldest first |
| `rewind(id, { to? })` → `{ sandbox, checkpoint, dropped, restore_ms }` | back to the latest checkpoint, or to one named by id or label, with processes resumed |

The daemon has no checkpoint endpoint. Checkpoints are bookkeeping kept on the client side over snapshots, exactly as in the kosa8 CLI and MCP server. By default they go in the CLI's own store, so `kosa8 rewind` sees checkpoints you took with the SDK, and the SDK sees the CLI's. A rewind deletes the sandbox and restores the checkpoint under the same name, and checkpoints taken after the target are discarded.

## kosa8 Cloud

The same client shape, against kosa8 Cloud instead of the local daemon. Make
an API key in the cloud dashboard and set `KOSA8_API_KEY`.

```ts
import { Kosa8Cloud, Kosa8PaymentRequiredError } from '@kosa8/sdk';

const cloud = new Kosa8Cloud(); // or new Kosa8Cloud({ apiKey: 'k8c_live_…' })

const box = await cloud.sandboxes.create({ template: 'python', sleepAfterS: 600 });
const r = await box.exec(['python3', '-c', 'print(6 * 7)']);
console.log(r.exitCode, r.stdout); // 0 "42\n"
await box.sleep();   // costs only snapshot storage while asleep
await box.exec('ls /workspace'); // wakes it, files and all
await box.delete();

await cloud.functions.deploy('hello', {
  runtime: 'python3.12',
  code: 'def handler(event):\n    return {"hello": event.get("name", "world")}\n',
});
const out = await cloud.functions.invoke('hello', { name: 'kosa8' });
console.log(out.ok, out.result); // true { hello: 'kosa8' }
```

A new organization runs nothing until a payment method is on file; until
then creating a sandbox throws `Kosa8PaymentRequiredError` (`code`
`payment_required`), whose message says what to do. Every error from the
cloud carries its stable `code`.

## Errors

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
