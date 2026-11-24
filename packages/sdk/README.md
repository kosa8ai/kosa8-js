# @kosa8/sdk

**[kosa8](https://kosa8.com): Zero Trust cybersecurity infrastructure for AI agents.**

> **Switching from E2B / Daytona / Modal / Vercel Sandbox? Change one import.** Your code runs on kosa8 Cloud as it is; a call kosa8 cannot do throws `Unsupported` naming the kosa8 way.
>
> ```ts
> import { Sandbox } from '@kosa8/sdk/e2b';         // was: from 'e2b'
> import { Daytona } from '@kosa8/sdk/daytona';     // was: from '@daytonaio/sdk'
> import { ModalClient } from '@kosa8/sdk/modal';   // was: from 'modal'
> import { Sandbox } from '@kosa8/sdk/vercel';      // was: from '@vercel/sandbox'
> ```

Typed TypeScript client for [kosa8](https://kosa8.com). kosa8 gives every AI agent its own sealed machine. This package talks to both places those machines run:

- **kosa8 Cloud** (`Kosa8Cloud`): sandboxes on kosa8's hosts, over HTTPS at `https://api.kosa8.com`, with an API key. Nothing to install.
- **The local daemon** (`Kosa8Client`): microVMs on your own Mac or Linux box, over the daemon's unix socket, with egress allow-lists, the sandbox toolbox, checkpoint and rewind, fork, explore and snapshots.

No runtime dependencies. ESM and CommonJS builds with `.d.ts` types. Node 18 or later. Errors are typed and keep the server's own words.

## kosa8 Cloud quickstart

Sign up free at [app.kosa8.com](https://app.kosa8.com) (the Starter plan, no card) and make an API key, then:

```sh
npm install @kosa8/sdk
export KOSA8_API_KEY=k8c_live_...
```

```ts
import { Kosa8Cloud } from '@kosa8/sdk';

const cloud = new Kosa8Cloud(); // reads KOSA8_API_KEY; talks to https://api.kosa8.com

// Deleted automatically in an hour, even if this script dies.
const box = await cloud.sandboxes.create({ ttlS: 3600 });
// Or a small size for a mostly idle agent: cloud.sandboxes.create({ size: '0.25x0.5' }) (or cpus: 0.25, memMb: 512).

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
- Each exec is a fresh process, and files in `/workspace` persist for the sandbox's life. Anything else (installed packages, `cd`, `export`, files outside `/workspace`, processes a command leaves running) needs `{ persistent: true }`: without it a command may run in a fresh container that shares only `/workspace`. A persistent sandbox runs every exec in one long-lived container; the code interpreter (`runCode`) needs it, and it counts against your plan's persistent-sandbox limit.
- `exec(cmd, { timeoutS: 30 })` stops a command in the sandbox when it runs that long.
- A buffered `exec` runs at most **90 s**; past that the Cloud API stops the command and answers 504 `exec_timeout`, raised as `Kosa8ExecTimeoutError`. A **streamed exec** has no such limit and hands over output as it prints: `box.exec(cmd, { onStdout, onStderr })`, `box.exec(cmd, { timeoutS: 600 })` (a `timeoutS` over 90 streams), or iterate `box.execStream(cmd)`:

  ```ts
  const s = await box.execStream('npm test', { timeoutS: 1800 });
  for await (const { stream, text } of s) process[stream].write(text);
  console.log(s.exitCode);
  ```

  Or start long jobs in the background, then wait, poll or stop them:

  ```ts
  const job = await box.execBackground('sleep 120; echo done', { timeoutS: 600 });
  const done = await job.wait(); // or job.status(), or job.stop()
  console.log(done.exit, done.output);
  ```

- A request body is at most **64 KiB** (`413 too_large`), so send big inputs as files. A file is at most **8 MiB** through the API.

### Sandboxes

| method | endpoint |
| --- | --- |
| `cloud.sandboxes.create({ template?, region?, sleepAfterS?, ttlS?, deleteAfter?, leaseS?, runId?, acceptPrice?, size?, cpus?, memMb?, image?, diskGb?, persistent?, docker?, cpu?, name?, env?, snapshot?, egress?, secrets?, labels?, record?, idempotencyKey?, wait? })` → `CloudSandbox` | `POST /v1/sandboxes` (waits for a cold boot unless `wait: false`; sends an Idempotency-Key) |
| `cloud.sandboxes.createMany(n, { …create fields, labels?, runId?, leaseS?, prefix?, partialOk?, wait? })` → `CloudSandboxBatch` | `POST /v1/sandboxes/batch` (1 to 1000) |
| `cloud.sandboxes.heartbeat({ runId?, labels?, ids?, extendS? })` → number extended | `POST /v1/sandboxes/heartbeat` |
| `cloud.sandboxes.drain({ runId?, labels?, ids? })` → `{ deleted, ids, failed, more }` | `POST /v1/sandboxes/drain` |
| `cloud.sandboxes.list({ all?, limit?, cursor?, name?, labels? })` → `CloudSandbox[]` | `GET /v1/sandboxes` (`labels: { team: 'ml', gpu: true }` → `label=team=ml&label=gpu`) |
| `cloud.sandboxes.listPage({ all?, limit?, cursor? })` → `{ sandboxes, nextCursor }` | `GET /v1/sandboxes` |
| `cloud.sandboxes.iterate({ all?, limit? })` → async iterable of `CloudSandbox` | every page, following `nextCursor` |
| `cloud.sandboxes.get(id)` → `CloudSandbox` | `GET /v1/sandboxes/{id}` |
| `cloud.templates()` → `CloudTemplate[]` | `GET /v1/templates` |
| `box.exec(cmd, { image?, env?, timeoutS?, signal? })` → `{ exitCode, stdout, stderr, wokeMs?, failureClass, retryable }` | `POST …/exec` (a string runs through `sh -c`) |
| `box.exec(cmd, { onStdout?, onStderr?, stream? })` (same result) / `box.execStream(cmd, { image?, env?, timeoutS?, signal? })` → `CloudExecStream` (async iterable of `{ stream, text }`, `result({ onStdout, onStderr })`, `exitCode`, `close()`) | `POST …/exec {stream: true}` (NDJSON frames as the command prints; `timeoutS` up to 86400) |
| `box.execBackground(cmd, { image?, env?, timeoutS?, signal? })` → `CloudBackgroundExec` (`status()`, `wait()`, `stop()`) | `POST …/exec {background: true}` → 202; `GET …/exec/{bg_id}`; `POST …/exec/{bg_id}/stop` |
| `box.getExec(bgId)` → `CloudBackgroundExec` | `GET …/exec/{bg_id}` |
| `box.waitUntilRunning({ timeoutMs? })` | polls `GET` while `creating` |
| `box.update({ ttlS?, deleteAfter?, sleepAfterS? })` → `{ sandbox, notes }` | `PATCH /v1/sandboxes/{id}`; `{ ttlS: null }` clears the lifetime |
| `box.sleep()`, `box.wake()`, `box.refresh()`, `box.delete()` | `POST …/sleep`, `POST …/wake`, `GET`, `DELETE` |
| `box.dispose()`, `await using box = …` | `DELETE` (a sandbox gone already is fine) |
| `box.heartbeat({ extendS? })`, `box.grade(cmd, opts)` | see [RL training and fan-out](#rl-training-and-fan-out) |

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
| `box.fork(n = 1, { labels?, runId?, leaseS?, prefix?, partialOk? })` → `CloudSandboxBatch` | `POST …/fork` (1 to 1000 copies; a plain `fork(n)` of at most 100 is all or nothing, otherwise partial: the rest are in `failed`) |
| `box.ports()` → `{ port, address, container, loopback }[]` | `GET …/ports` |

```ts
const cp = await box.checkpoint('before the risky bit');
await box.exec('rm -rf /workspace/*');
await box.rewind(cp);                 // /workspace is back
const [copy] = await box.fork(1);     // a second sandbox, as this one is now
```

### RL training and fan-out

Thousands of rollouts that do not leak sandboxes, grade in sealed copies and mask what the platform got wrong.

```ts
import { Kosa8Cloud, rl } from '@kosa8/sdk';

const cloud = new Kosa8Cloud();
await rl.withRun(cloud, { name: 'grpo-7', project: 'swe' }, async (run) => {
  const base = await cloud.sandboxes.create({ template: 'python' }); // set up once, fork per rollout
  await base.exec('pip install -e /workspace/repo');
  for (let step = 0; step < 100; step++) {
    const results = await run.map(base, tasks, solve, {
      gradeCmd: ['python', '/grader/test.py'], // with each task's hidden task.files
      groupSize: 8, concurrency: 64,
    });
    trainer.step(results.groups(), results.mask); // masked (infra, quota, error) have reward null, never 0
  }
}); // records what is left, drains the run's sandboxes, marks it finished (or failed on a throw)
```

| method | endpoint |
| --- | --- |
| `rl.RlRun.start(cloud, { name, project?, config?, leaseS?, drainOnExit?, flushEvery?, signals?, heartbeatMs? })`, `rl.RlRun.attach(cloud, runId)`, `rl.withRun(cloud, opts, fn)`, `await using run = …` | `POST /v1/rl/runs`; while open, every sandbox the client makes is labelled `kosa8.run=<id>` and leased |
| `run.map(base, tasks, solve, { gradeCmd?, files?, reward?, groupSize?, concurrency?, retries?, timeoutMs?, mask?, keep?, step?, signal? })` → `Rollouts` (`rewards`, `mask`, `meanReward`, `byClass`, `groups()`) | fork (or create) per rollout, `POST …/grade`, record, delete |
| `run.record(rows)`, `run.flush()` | `POST /v1/rl/runs/{id}/rollouts` (batches of up to 500) |
| `run.finish(status?)`, `run.summary()`, `run.update({ status?, name? })`, `run.rollouts(filters)`, `run.export()` (JSONL), `run.exportRows()`, `run.drain()`, `rl.RlRun.list(cloud, filters)` | `PATCH`, `GET /v1/rl/runs/{id}`, `GET …/rollouts`, `GET …/export`, `POST /v1/sandboxes/drain`, `GET /v1/rl/runs` |
| `rl.lease(cloud, { runId? \| labels? \| ids?, leaseS?, intervalMs?, drain?, signals? })` → `Lease` (`beat()`, `close()`, `await using`) | `POST /v1/sandboxes/heartbeat` every leaseS / 3; `POST /v1/sandboxes/drain` on close, SIGINT, SIGTERM or when the event loop runs dry |
| `rl.mapRollouts(solve, tasks, { base, cloud?, run?, … })` | the engine behind `run.map` |
| `cloud.forkMap(base, fn, items, { concurrency?, retries?, timeoutMs?, labels?, runId?, leaseS?, signal? })` → `ForkResult[]` | `fn(child, item)` in its own fork per item; children always deleted |
| `box.grade(cmd, { files?, timeoutS?, env?, keep?, runId?, rollout? })` → `{ reward, metrics, exitCode, failureClass, graderId, … }` | `POST …/grade`: a sealed copy with no network and the hidden files; `reward: null` when it did not finish |

`base` is a `CloudSandbox` to fork, a `snap_…` id, create options, or `async (task) => sandbox`. A rollout's reward is the grader's (the last stdout line that is JSON with a numeric `reward`, else 1 for exit 0 and 0 otherwise), or `reward(sandbox, task, output)`, or what `solve` resolved with (a number or `{ reward }`). Infra failures and rate limits are retried on a fresh sandbox with backoff and jitter (a failed grade is retried on its own first).

**Leases.** `leaseS` (60 to 86400) is a TTL that heartbeats move forward: a trainer that dies stops heartbeating and its sandboxes go `leaseS` later. A `Lease`'s timer is unref'd, so it never keeps the process up.

**Idempotency.** Creates, batches, forks, grades and job submits send an `Idempotency-Key` (a fresh UUID per call, or yours as `idempotencyKey`). The SDK's own key is kept across retries after no answer (a dropped connection or a timeout: the first try may still be running, and the key stops a second sandbox), a 429 and a 409 `idempotency_in_progress` / `template_building`; after a 5xx (502 `host_failed`, 503 `no_capacity`, …) the retry gets a new key, so it is a new attempt and never tied to the failed one. A key you pass is never changed.

**Retries.** `new Kosa8Cloud({ retry })` takes a `RetryPolicy` (default `new RetryPolicy()`: 3 tries, full-jitter backoff from 500 ms up to 8 s, at least the server's `Retry-After` header or `retry_after` seconds, up to 60 s) or `false`. Every request retries what the answer marks `retryable: true` (infra failures, rate limits). Reads, PUTs, deletes, heartbeats, drains and the creates, forks and grades (which send an Idempotency-Key) are retried on any of those. Any other POST is resent only on answers that refused it before anything ran: 429, 503 `database_busy` (kosa8 Cloud's database was overloaded) and 409 `template_building` (a benchmark's environment is still being built). `callWithRetry(fn, policy)` is the same loop for your own code.

**Failure classes.** Every error has `failureClass` (`timeout`, `infra`, `quota`, `client`, or `error` for one that is not the API's) and `retryable`, kosa8 Cloud's own when the answer had them; exec results have `failureClass` `ok`, `exit_nonzero` or `infra`. `classifyFailure(e)` classes anything thrown.

### Org templates, small sizes, tokens, embeds, domains, recordings, Burst

| method | endpoint |
| --- | --- |
| `cloud.orgTemplates.build({ name, image? \| dockerfile?, buildArgs?, setupCmd?, size?, cpus?, memMb?, region? })` | `POST /v1/templates` (202; then `create({ template: name })` restores its snapshot) |
| `cloud.orgTemplates.import(images, { size?, setupCmd?, partialOk? })` | `POST /v1/templates/import` (up to 1000, e.g. RL task images by digest) |
| `cloud.orgTemplates.get(idOrName)`, `.list()`, `.delete(idOrName)`, `.wait(idOrName)` | `GET /v1/templates/{id}`, `GET /v1/templates` (`org_templates`), `DELETE`, poll until ready |
| `create({ size: '0.25x0.5' })` (`SMALL_CLOUD_SIZES`: 0.25x0.5, 0.5x1, 1x2), or `cpus: 0.25, memMb: 512` | small sizes for mostly idle fleets, bursting above their reserve |
| `cloud.tokens.create({ scopes, sandboxIds?, labels?, ttlS?, name? })` → token with `secret`, `.list({ all? })`, `.revoke(id)` | `/v1/tokens`; a `k8c_tok_…` secret works as `apiKey` |
| `box.embeds.create({ origins, mode?, ui?, ttlS?, command? })` → `{ url, snippet, … }`, `.list()`, `.revoke(id)` | `POST …/embed`, `GET …/embeds`, `DELETE …/embeds/{id}` |
| `box.previews.domains(port)` or `cloud.previewDomains(previewId)`: `.add(hostname, { sslMethod? })`, `.list()`, `.get(hostname)`, `.remove(hostname)` | `…/previews/{port}/domains` |
| `create({ record: true })`, `cloud.recordings.list({ sandboxId?, limit? })`, `.link(id, { ttlS? })`, `.delete(id)`, `box.recordings()` | `/v1/recordings`, `…/recordings` |
| `cloud.burst.get()`, `cloud.burst.activate(quantity?)` | `GET`/`POST /v1/billing/burst` |

### Sized and Docker sandboxes, env, snapshots

```ts
// 4 vCPU / 8 GiB, Ubuntu with common toolchains, its own Docker engine and env.
const box = await cloud.sandboxes.create({
  size: '4x8',
  image: 'kosa8-template/universal-24.04-20261115.2',
  docker: true,
  env: { NODE_ENV: 'production' },
  name: 'web-1',
  labels: { team: 'web' },
  ttlS: 3600,
});
// A long command in the background, then its result.
const job = await box.execBackground('dockerd > /var/log/dockerd.log 2>&1 & sleep 3; docker run --rm hello-world');
const done = await job.wait();
console.log(done.exit, done.output);

// A durable snapshot, and a fresh sandbox from it (files, packages and processes as they were).
const snap = await box.snapshot('web-ready');
const copy = await cloud.sandboxes.create({ snapshot: snap, ttlS: 600 });
await cloud.snapshots.list();            // the org's snapshots
await cloud.snapshots.delete(snap.id);
```

A sized create (`size`, `cpus`+`memMb`, `image` or `diskGb`) boots cold and answers `creating`; `create` polls until it is running (or throws with `last_error`). `size` is `2x4`, `4x8`, `8x16` or `16x32` (`CLOUD_SIZES`). `docker` makes the sandbox persistent. `cpu: 'dedicated'` gives whole physical cores. `region` takes `us-ash1`, `eu-hel1` or the area alone (`us`, `eu`). A create `{ snapshot }` takes the snapshot's template, size and image, so `template`, `size`, `cpus`, `memMb`, `image`, `diskGb`, `docker`, `persistent`, `cpu` and `region` are refused before any request. `env` values are never logged or returned.

### Previews, terminal, code interpreter

```ts
await box.execBackground('python3 -m http.server 3000');
const p = await box.previews.create(3000);          // private: a signed link on kosa8labs.com
console.log(p.url);
await box.previews.create(8080, { public: true, wake: true });
const t = await box.terminal({ cols: 120, rows: 32 }); // wss:// URL for a PTY WebSocket
const r = await box.runCode('import math; math.pi'); // stateful Python; charts come back as image/png
```

| method | endpoint |
| --- | --- |
| `box.previews.create(port, { public?, expiresInS?, wake?, wakePerHour? })`, `list()`, `link(port, { expiresInS? })`, `rotate(port)`, `delete(port)` | `…/previews` |
| `box.terminal({ cols?, rows?, command? })` → `{ url, expires_at, protocol }` | `POST …/terminal` |
| `box.runCode(code, { context?, timeoutS? })` → `{ results, stdout, stderr, error? }` | `POST …/code` |
| `box.codeContexts.list()`, `create(name?)`, `reset(name)`, `delete(name)` | `…/code/contexts` |
| `box.files.readRaw(path)`, `box.files.writeRaw(path, data)` (no 8 MiB cap) | `…/files/raw` |
| `box.files.link(path, { method?: 'GET' \| 'PUT', ttlS? })` → presigned URL | `POST …/files/link` |
| `box.egress()`, `box.setEgress({ internet?, allow?, deny?, presets? })`, `box.resetEgress()` | `…/egress` |
| `cloud.egressPresets()`, `cloud.orgEgress()`, `cloud.setOrgEgress(policy \| null, { enforce? })` | `/v1/egress/presets`, `/v1/org/egress` |
| `box.schedules.create({ cron, cmd, env?, name?, wake? })`, `list()`, `run(id)`, `delete(id)` | `…/schedules` |
| `box.setLabels(labels)`, `box.metrics()`, `box.logs({ limit? })`, `box.secrets()` | `…/labels`, `…/metrics`, `…/logs`, `…/secrets` |
| `cloud.capabilities()` | `GET /v1/capabilities` (feature detection) |

### Secrets

```ts
// The value goes in a request body once and never comes back; sandboxes hold a placeholder.
await cloud.secrets.set('OPENAI', process.env.OPENAI_API_KEY!, { upstream: 'api.openai.com', pipelines: true });
const box = await cloud.sandboxes.create({ secrets: ['OPENAI'] });
await cloud.secrets.list();          // names and settings, never values
await cloud.secrets.delete('OPENAI'); // { deleted, stillHeldBy }
```

### Browsers (headless Chromium over CDP)

A cloud browser is headless Chromium you drive over CDP with Playwright or
Puppeteer, or use through quick page loads. $0.12 per browser-hour, billed per
second; `ttlS` (30 to 3600, default 300) closes it on its own.

```ts
import { chromium } from 'playwright';

await using b = await cloud.browser({ ttlS: 300 });        // closed on the way out
const png = await b.screenshot('https://example.com');      // PNG bytes (a Buffer on Node); { fullPage: true } for the whole page
const { title, text } = await b.goto('https://example.com');

const browser = await chromium.connectOverCDP(b.cdpUrl!);   // valid 10 minutes; b.refresh() for a new one
const page = browser.contexts()[0]?.pages()[0] ?? (await browser.newPage());
await page.goto('https://example.com');
await browser.close();

await cloud.listBrowsers({ state: 'all' }); await cloud.getBrowser('brw_...'); await cloud.browsers.delete('brw_...');
```

Puppeteer: `puppeteer.connect({ browserWSEndpoint: b.cdpUrl })`. `await cloud.browsers.cdp('brw_...')` reads a
browser again and gives a fresh `cdpUrl` (the `wss://…/v1/browsers/{id}/cdp?token=…` WebSocket) and its expiry.

### AI gateway

Model calls from sandboxes go through the org's gateway: provider keys stay on
kosa8 Cloud, with caching, a rate limit and per-sandbox usage.

```ts
await cloud.setAiKey('openai', process.env.OPENAI_API_KEY!);   // never sent back; listAiKeys() shows a hint
await cloud.updateAiSettings({ enabled: true, cacheTtlS: 3600, ratePerMin: 120 });
const box = await cloud.sandboxes.create({ aiGateway: true }); // OPENAI_BASE_URL, ANTHROPIC_BASE_URL, KOSA8_AI_GATEWAY_URL, KOSA8_AI_TOKEN set
console.log((await cloud.aiUsage('2026-11')).total);          // calls, cost_usd, tokens_in, tokens_out, cached, errors
await cloud.deleteAiKey('openai');
```

Outside a sandbox, point a provider's own client at the gateway with your kosa8 API key as its key:

```ts
import OpenAI from 'openai';
const openai = new OpenAI({ baseURL: cloud.ai.gatewayUrl('openai'), apiKey: process.env.KOSA8_API_KEY });
// cloud.ai.gatewayUrl('anthropic') for Anthropic's SDK (it appends v1/messages)
```

### Pipelines

```ts
const run = await cloud.pipelines.run({ repoUrl: 'https://github.com/me/app', ref: 'main', size: '4x8', secrets: ['NPM_TOKEN'] });
const done = await cloud.pipelines.wait(run.id);  // success | failure | cancelled | error
const logs = await cloud.pipelines.logs(run.id);  // per job; pass logs[i].next as `after` to follow
for (const a of await cloud.pipelines.artifacts(run.id)) {
  const tgz = await cloud.pipelines.downloadArtifact(run.id, a.job, a.idx);
}
const hook = await cloud.pipelines.hooks.create({ repoUrl: 'https://github.com/me/app', provider: 'github', cron: '0 3 * * *' });
console.log(hook.url, hook.secret); // give both to GitHub's webhook settings
```

`cloud.pipelines` also has `list({ state?, limit? })`, `get(id)` and `cancel(id)`; `cloud.pipelines.hooks` has `list()` and `delete(id)`.

### Functions

```ts
await cloud.functions.deploy('hello', {
  runtime: 'python3.12',
  code: 'def handler(event):\n    return {"hello": event.get("name", "world")}\n',
});
const out = await cloud.functions.invoke('hello', { name: 'kosa8' });
console.log(out.ok, out.result); // true { hello: 'kosa8' }
```

`cloud.functions` also has `list`, `get`, `delete`, `map` and `invocations(name, { limit? })` (recent calls, newest first).

### Org: usage, limits, keys, webhooks, audit

| call | API |
| --- | --- |
| `cloud.me()`, `cloud.usage()`, `cloud.usageInsights()` | the org; this month's bill; spend day by day, top sandboxes, projected month end |
| `cloud.pricing()`, `cloud.limits()`, `cloud.requestLimit(maxRunning, reason?)` | the rate card; the running-sandbox limit; ask for more |
| `cloud.lineage()`, `cloud.checkpoints()`, `cloud.images()` | the fork tree; every sandbox's checkpoints; the images behind the templates |
| `cloud.apiKeys.list()` / `create({ name, scopes?, expiresInS? })` / `revoke(id)` / `rotate(id, { graceS? })` | `/v1/api-keys`; a new key's `secret` is shown once |
| `cloud.webhooks.list()` / `create(url, { events?, description? })` / `delete(id)` / `deliveries(id)` / `test(id)` | `/v1/webhooks`; the `whsec_` secret is shown once |
| `cloud.audit.list({ sandboxId?, actor?, action?, since?, until?, beforeSeq?, limit? })` / `verify()` / `export()` | the hash-chained audit log |

### Benchmarks and RL alerts

```ts
const [swe] = await cloud.benchmarks.list();                       // name, instances, environments ready/building
const { instances } = await cloud.benchmarks.instances(swe.name, { state: 'ready', limit: 10 });
await cloud.benchmarks.prepare(swe.name, 20, { seed: 1 });         // build environments ahead (ids, 'all' or a count)
const box = await cloud.sandboxes.create({ template: instances[0].template }); // waits out 409 template_building

await cloud.rl.compare(['run_a', 'run_b']);                         // 2 to 4 runs side by side
await cloud.rl.alerts.create({ kind: 'infra_rate', threshold: 0.2, window: 50, runId: 'run_a' }); // fires the rl.alert webhook event
```

### Cloud errors

Every error from the cloud is a `Kosa8Error` with the cloud's stable `code`, its sentence as `message`, `status`, and the whole answer as `body`.

| class | when |
| --- | --- |
| `Kosa8PaymentRequiredError` | 402: `code` is `plan_required`, `plan_limit`, `plan_feature`, `spend_cap`, `payment_required`, `price_not_accepted`, … `upgradeUrl` is where the person adds a card or credit and `agentMessage` is a sentence an agent should relay word for word. For `plan_limit`: `limitName`, `limit`, `used`, `plan`, `nextPlan`, `packUrl` and `options` (the ways past it, cheaper first). Each is `null` (`options` `[]`) when absent |
| `Kosa8OrgFrozenError` | 423 `org_frozen`: the org is frozen in the Security Center; an owner or admin must unfreeze it |
| `Kosa8RateLimitError` | 429: rate limited (retried) or a quota reached (`quota_exceeded`, not retried, with `agentMessage` and `requestUrl`, where to ask for more); `retryAfter` is the Retry-After header in seconds, when sent |
| `Kosa8ExecTimeoutError` | a buffered exec ran past its 90 s limit (504, `exec_timeout`, or a 502 `host_failed` on exec that timed out); run the job in the background instead |
| `Kosa8UnsupportedError` | 501 `not_available`/`not_supported`: the host cannot do this. A sandbox on kosa8's overflow capacity (Cloudflare) has no fork, checkpoint or sleep and says so in `message`; create it at a size a kosa8 host runs (such as `2x4`) for those |
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

### E2B shim (`@kosa8/sdk/e2b`)

Code written against E2B's JS SDK runs on kosa8 Cloud by changing one import:

```ts
import { Sandbox } from '@kosa8/sdk/e2b'; // was: import { Sandbox } from 'e2b'

const sbx = await Sandbox.create(); // kosa8's python template; KOSA8_API_KEY
await sbx.commands.run('pip install -q rich && python3 build.py', {
  onStdout: (d) => process.stdout.write(d), // called as it prints
  timeoutMs: 600_000,                        // over 90 s: a streamed exec
});
await sbx.files.write('notes.txt', 'hi');
console.log(await sbx.files.read('notes.txt'));
await sbx.kill();
```

It covers `Sandbox.create(template?, { timeoutMs, envs, metadata, allowInternetAccess, apiKey })`, `Sandbox.connect(id)`, `Sandbox.kill(id)`, `sandbox.sandboxId`, `kill()`, `setTimeout`, `getInfo`, `isRunning`, `pause`, `getHost`; `commands.run(cmd, { onStdout, onStderr, timeoutMs, envs, cwd, background })`, `commands.connect` / `kill`, the `CommandHandle` (`pid`, `wait({ onStdout })`, `kill()`); `files.read` / `write` / `list` / `exists` / `remove` / `makeDir` / `rename`. Anything else throws `Unsupported` (naming the kosa8 way), and errors come back as E2B's (`TimeoutError`, `NotFoundError`, `CommandExitError`, …) with the kosa8 error as `cause`. `sandbox.kosa8` is the `CloudSandbox` underneath.

What streams: `commands.run` with `onStdout` / `onStderr`, or a `timeoutMs` over 90 s (or 0, no limit), is a streamed exec: callbacks fire as the command prints and it is not held to 90 s. A plain `commands.run` is buffered (90 s at most, output when it ends). A background command's output is polled about once a second (`CommandHandle.pollIntervalMs`) and passed to `onStdout` as it appears, stdout and stderr together. Only `/workspace` outlives a command unless the sandbox is persistent; relative paths are under `/workspace`. No stdin or PTY.

### Daytona, Modal and Vercel Sandbox shims

The same one-import swap for three more SDKs. Each reads `KOSA8_API_KEY` (or the provider's own variable, `DAYTONA_API_KEY`, `MODAL_TOKEN_SECRET`, `VERCEL_TOKEN` / `VERCEL_OIDC_TOKEN`, only when it holds a kosa8 `k8c_` key; another provider's key is never sent anywhere). Sandboxes are created **persistent** (one long-lived container, like the VMs those SDKs give: installs, `$HOME` and background processes last between commands); when your plan has no persistent sandbox left, or the host cannot run one for that image, the shim warns and makes a plain one. Relative paths are under `/workspace`. A call kosa8 cannot do throws `Unsupported`, naming the kosa8 way; `.kosa8` on a sandbox is the `CloudSandbox` underneath.

```ts
import { Daytona } from '@kosa8/sdk/daytona'; // was: from '@daytonaio/sdk'
const daytona = new Daytona();
const sb = await daytona.create({ language: 'python', envVars: { A: '1' } });
console.log((await sb.process.executeCommand('python3 -c "print(6*7)"')).result);
console.log((await sb.getPreviewLink(3000)).url);
await sb.delete();
```

```ts
import { ModalClient } from '@kosa8/sdk/modal'; // was: from 'modal'
const modal = new ModalClient();
const app = await modal.apps.fromName('my-app', { createIfMissing: true });
const sb = await modal.sandboxes.create(app, modal.images.fromRegistry('python:3.12-slim'), { encryptedPorts: [8000] });
const p = await sb.exec(['python3', '-c', 'print(1)']);
console.log(await p.stdout.readText(), await p.wait());
console.log((await sb.tunnels())[8000].url);
await sb.terminate();
```

```ts
import { Sandbox } from '@kosa8/sdk/vercel'; // was: from '@vercel/sandbox'
const sb = await Sandbox.create({ ports: [3000], source: { type: 'git', url: 'https://github.com/your-org/your-app.git' } });
const r = await sb.runCommand('node', ['--version']);
console.log(await r.stdout(), sb.domain(3000));
await sb.delete();
```

- **Daytona** (`@daytonaio/sdk` 0.233): `create` (language, `snapshot` as a kosa8 template or `snap_…`, registry `image`, `envVars`, `labels`, `public`, `autoStopInterval`, `ttlMinutes`, `ephemeral`, `resources` cpu/memory/disk, `networkBlockAll` / `networkAllowList` / `domainAllowList`), `get` / `list` / `start` / `stop` / `delete` / `fork`; `process.executeCommand`, `codeRun` (python, javascript), sessions (`createSession`, `executeSessionCommand` incl. `runAsync`, `getSessionCommand`, `getSessionCommandLogs`; a session keeps its working folder and exported variables between commands); `fs` upload, download, list, details, folders, delete, move, permissions; `getPreviewLink`, `getSignedPreviewUrl`, `setLabels`, `setAutostopInterval`, `setTtl`, `updateNetworkSettings`, `createSnapshot`, `downloadUrl` / `uploadUrl`. Unsupported: declarative `Image` builds, volumes, GPUs, `user`, PTY, `git`, `computerUse`, `codeInterpreter`, LSP, SSH, `updateEnv`, `findFiles` / `searchFiles` / `replaceInFiles`, file streams, `archive`, `resize`, metrics, `jwtToken`.
- **Modal** (`modal` 0.11): `ModalClient`, `apps.fromName` (an app is the label `modal.app`), `images.fromRegistry` (a registry image, or a kosa8 template key such as `python`), `images.fromId` (a snapshot), `sandboxes.create` (`timeoutMs`, `idleTimeoutMs`, `workdir`, `command` entrypoint, `env`, `cpu` / `memoryMiB`, `encryptedPorts` / `unencryptedPorts`, `blockNetwork`, outbound allow-lists, `name`, `tags`), `fromId` / `fromName` / `list`; `exec` (streams to `stdout` / `stderr`, `readText()`, `wait()`, text or binary), `terminate`, `wait` / `poll` / `stdout` for an entrypoint, `tunnels`, `filesystem` (read, write, list, mkdir, remove, stat, copy to and from local), `setTags` / `getTags`, `updateNetworkPolicy`, `snapshotFilesystem`, `experimentalPause` / `Resume`; the older `App.lookup` + `app.createSandbox` style too. Unsupported: `dockerfileCommands` and image builds, registry secrets, secrets, volumes, bucket mounts, GPUs, PTY, stdin, `h2Ports`, inbound allow-lists, readiness probes, custom domains, several regions, `sandbox.logs`, `filesystem.watch`, functions.
- **Vercel Sandbox** (`@vercel/sandbox` 4.1): `Sandbox.create` (`source` git / tarball / a kosa8 `snap_` snapshot, `ports`, `timeout`, `resources.vcpus` at 2 GiB each, `runtime` node/python, `image`, `env`, `tags`, `networkPolicy` allow-all / deny-all / host and subnet lists, `persistent`), `Sandbox.get` / `list`; `runCommand` (both forms, `cwd`, `env`, `sudo`, `stdout` / `stderr` writables, `timeoutMs`; `detached` gives a `Command` with `logs()`, `wait()`, `kill()`), `getCommand`, `writeFiles`, `readFile`, `readFileToBuffer`, `downloadFile`, `mkDir`, `domain(port)`, `stop` (sleeps it, memory and disk kept), `delete`, `extendTimeout`, `update`, `updateNetworkPolicy`, `snapshot`, `openInteractive`. Unsupported: network rules with request transforms, `mounts`, `networkId`, `credentials`, regions, `keepLastSnapshots`, stdin, users and groups (`asUser`, `createUser`), `Sandbox.fork`, `sandbox.fs`.

## The same thing in each language

The five kosa8 SDKs (Python `kosa8`, JS `@kosa8/sdk`, Go `kosa8-go`, Ruby `kosa8`, Java
`com.kosa8:kosa8`) call the same kosa8 Cloud API, but some names differ by language. The ones
that catch people switching:

| | Python | JS / TS | Go | Ruby | Java |
|---|---|---|---|---|---|
| client | `Kosa8Cloud()` | `new Kosa8Cloud()` | `kosa8.NewCloud(kosa8.CloudOptions{})`, returns `(cloud, err)` | `Kosa8::Cloud.new` | `Kosa8Cloud.builder().build()` |
| lifetime on create | `ttl_s=3600` | `{ ttlS: 3600 }` | `CloudCreateOptions{TTLSeconds: 3600}` | `ttl_s: 3600` | `new CloudOptions.Create().ttlSeconds(3600)` |
| persistent sandbox | `persistent=True` | `{ persistent: true }` | `CloudCreateOptions{Persistent: true}` | `persistent: true` | `.persistent(true)` |
| sandbox id | `box.id` | `box.id` | `box.ID()`, a method (`fmt.Println(box.ID)` prints a func value; `go vet` reports it) | `box.id` | `box.id()` |
| shell command | `box.exec("ls /")` | `box.exec('ls /')` | `box.ExecShell(ctx, "ls /", nil)` | `box.exec("ls /")` | `box.exec("ls /")` |
| argv command | `box.exec(["ls", "/"])` | `box.exec(['ls', '/'])` | `box.Exec(ctx, []string{"ls", "/"}, nil)` | `box.exec(["ls", "/"])` | `box.exec(List.of("ls", "/"))` |
| per-exec timeout | `exec(cmd, timeout_s=30)` | `exec(cmd, { timeoutS: 30 })` | `&kosa8.CloudExecOptions{TimeoutS: 30}` | `exec(cmd, timeout_s: 30)` | `exec(cmd, null, null, 30)` |
| exit code | `r.exit_code` | `r.exitCode` | `r.ExitCode`, an `*int` (nil when the cloud sent none; `r.OK()` checks for 0) | `r.exit_code` | `r.exitCode()`, an `Integer` (may be null) |
| files | `box.files.write` / `read_text` / `list` | `box.files.write` / `readText` / `list` | `box.Files().WriteString` / `ReadText` / `List(ctx, "")` | `box.files.write` / `read_text` / `list` | `box.files().write` / `readText` / `list()` |
| no such sandbox | `Kosa8NotFoundError` | `Kosa8NotFoundError` | `*kosa8.Error` with `Kind` `KindNotFound` (`errors.Is(err, kosa8.ErrNotFound)`) | `Kosa8::NotFoundError` | `Kosa8Exception.NotFoundException` |

In every SDK a non-zero exit is returned in the result, not raised. Only `/workspace` is sure to
persist between commands, unless the sandbox is persistent.

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
npm install @kosa8/sdk
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
