# @kosa8/ai-sdk-sandbox

**[kosa8](https://kosa8.com): Zero Trust cybersecurity infrastructure for AI agents.**

A [kosa8](https://kosa8.com) sandbox for the [Vercel AI SDK 7](https://ai-sdk.dev). Your agent's commands and files run in a microVM with its own kernel, and its network is closed except for the hosts you allow. Run it on **kosa8 Cloud** with an API key, or on your own machine with the kosa8 daemon. Use it with `HarnessAgent`, or hand a session to AI SDK tools as `experimental_sandbox`.

It implements the AI SDK 7 sandbox interfaces (`Experimental_SandboxSession`, `HarnessV1NetworkSandboxSession`, `HarnessV1SandboxProvider`) in the same shape as `@ai-sdk/sandbox-vercel` and `@e2b/ai-sdk-sandbox`. It is built on [`@kosa8/sdk`](https://www.npmjs.com/package/@kosa8/sdk).

| | kosa8 Cloud | local |
| --- | --- | --- |
| create | `createKosa8CloudSandboxSession()` | `createKosa8NetworkSandboxSession()` |
| resume | `resumeKosa8CloudSandboxSession({ sandboxId })` | `resumeKosa8NetworkSandboxSession({ sandboxId })` |
| wrap your own | `createKosa8CloudSandboxSessionFromSandbox()` | `createKosa8NetworkSandboxSessionFromSandbox()` |
| provider shape | `createKosa8CloudSandbox()` | `createKosa8Sandbox()` |
| needs | a kosa8 Cloud API key (`KOSA8_API_KEY`) | kosa8 installed, its daemon running |

## Requirements

- Node.js 22 or later (as required by `@ai-sdk/harness`).
- **kosa8 Cloud**: an API key (`k8c_live_…`) from the kosa8 Cloud dashboard, in `KOSA8_API_KEY` or passed as `apiKey`. kosa8 plans start at $29/month; there is no free tier.
- **Local**: kosa8 installed, with its daemon running (`kosa8 daemon start`), on macOS on Apple silicon or x86-64 Linux. No account is needed.

  ```sh
  curl -fsSL https://kosa8.com/install.sh | sh
  ```

## Install

```sh
npm install @kosa8/ai-sdk-sandbox ai
```

## kosa8 Cloud quickstart

```ts
import { createKosa8CloudSandboxSession } from '@kosa8/ai-sdk-sandbox';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

// Reads KOSA8_API_KEY. Everything not set follows your org's settings.
const session = await createKosa8CloudSandboxSession({
  template: 'python', // or image/size, e.g. { size: '4x8' }
  ttlS: 3600, // deleted after an hour, whatever happens
  networkPolicy: { mode: 'custom', allowedHosts: ['pypi.org', 'files.pythonhosted.org'] },
});

try {
  const sandbox = session.restricted(); // file I/O, run and spawn only
  const result = await generateText({
    model,
    stopWhen: stepCountIs(10),
    prompt: `Write fib.py, run it and report the 30th Fibonacci number.\n\nSandbox:\n${sandbox.description}`,
    experimental_sandbox: sandbox,
    tools: {
      writeFile: tool({
        description: 'Write a file in the sandbox.',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ path, content }, { experimental_sandbox, abortSignal }) => {
          await experimental_sandbox!.writeTextFile({ path, content, abortSignal });
          return { written: path };
        },
      }),
      shell: tool({
        description: 'Run a shell command in the sandbox.',
        inputSchema: z.object({ command: z.string() }),
        execute: ({ command }, { experimental_sandbox, abortSignal }) =>
          experimental_sandbox!.run({ command, abortSignal }),
      }),
    },
  });
  console.log(result.text);
} finally {
  await session.destroy(); // or session.stop() to sleep it and resume later
}
```

With `HarnessAgent`:

```ts
const session = await createKosa8CloudSandboxSession({ template: 'node' });
const agentSession = await agent.createSession({ sandboxSession: session });
```

### How it maps onto kosa8 Cloud

- Each session is one kosa8 Cloud sandbox (`session.id` is its `sbx_…` id; `sandboxId` at create sets its name). `template` is a kosa8 Cloud template key (`base`, `python`, `node`, ... or a kosa8 Store item); `image`, `size`, `cpus`/`memMb`, `diskGb`, `region`, `ttlS`, `sleepAfterS`, `persistent`, `secrets` and `labels` go to `POST /v1/sandboxes` as they are.
- `run` and `spawn` start each command as a background exec, so a command is not held to the 90 s limit of a buffered exec. Output is read by polling the command's status (it streams while the command runs); stderr goes to a file of its own so it stays apart from stdout. `kill()` and `abortSignal` stop the command and what it started (SIGTERM, then SIGKILL after 5 s). `commandTimeoutS` sets a limit kosa8 Cloud enforces.
- Files travel through the files API, which reaches `/workspace` only, at most 8 MiB per request. A write is sent in 8 MiB parts to `/workspace/.kosa8-run` and moved into place by one exec, which makes parent folders. A read is checked by one exec, which also splits a file over 8 MiB, or outside `/workspace`, into parts. On a host without the files API the bytes go through exec, base64-encoded, in chunks. A missing file reads as `null`.
- `stop()` puts the sandbox to sleep: kosa8 Cloud snapshots it and frees its VM. `resumeKosa8CloudSandboxSession({ sandboxId })` (its `sbx_…` id or its name) wakes it as it was. `destroy()` deletes it.
- `setNetworkPolicy()` changes the egress of the running sandbox at once. `allow-all` maps to the whole internet, `deny-all` to nothing, and `custom` to an allow-list with `deniedCIDRs` as a deny-list.
- `getPortEndpoint({ port })` opens a private kosa8 Cloud preview of the port: an https URL with a signed token (`wss://` for `protocol: 'ws'`). `setPorts` opens and closes previews.
- An AI SDK `template` (`{ identity, prepare }`) is prepared once and kept as a kosa8 Cloud snapshot; later sessions with the same identity start from it. Use `cloudTemplate` for the kosa8 Cloud template it is prepared on.
- `session.sandbox` is the `@kosa8/sdk` `CloudSandbox`, for what the AI SDK interface does not cover (checkpoints, fork, metrics, ...).
- Request transformations are not offered. kosa8 Cloud keeps credentials outside the sandbox with org `secrets`, which are placeholders swapped on the way out.

### `createKosa8CloudSandboxSession(options?)` settings

| setting | default | |
| --- | --- | --- |
| `cloud` / `apiKey` / `baseUrl` | `KOSA8_API_KEY`, `https://api.kosa8.com` | a `Kosa8Cloud` client, or how to make one |
| `sandboxId` | | a name for the sandbox; a live sandbox with that name is a conflict |
| `template` | org default (`base`) | kosa8 Cloud template key, or an AI SDK `{ identity, prepare }` template |
| `image`, `size`, `cpus`, `memMb`, `diskGb`, `region`, `persistent`, `cpu` | org defaults | sized and image creates boot cold |
| `ttlS`, `sleepAfterS` | org defaults | lifetime and idle-sleep timer, in seconds |
| `networkPolicy` / `egress` | org default policy | AI SDK policy, or kosa8 Cloud egress (`{ internet, allow, deny, presets }`) |
| `workingDirectory` | `/workspace` | created if missing; relative paths resolve against it |
| `env` | | environment for every command, sent with each command |
| `secrets`, `labels` | | org secret names; labels |
| `setupCommands` | | shell commands run once on a fresh sandbox |
| `commandTimeoutS` | none | kosa8 Cloud stops a command after this many seconds |
| `pollIntervalMs` | 1000 | longest wait between polls of a running command |

`examples/cloud-live-check.ts` in the repository runs the whole interface against kosa8 Cloud and deletes what it made.

## Local quickstart

```ts
import { createKosa8NetworkSandboxSession } from '@kosa8/ai-sdk-sandbox';

const session = await createKosa8NetworkSandboxSession({
  image: 'alpine:latest',
  networkPolicy: { mode: 'custom', allowedHosts: ['registry.npmjs.org'] },
});

// The tool-safe view: file I/O, run and spawn, with no lifecycle or network controls.
const sandbox = session.restricted();

await sandbox.writeTextFile({ path: 'hello.txt', content: 'hi' });
const { stdout } = await sandbox.run({ command: 'cat hello.txt' });
console.log(stdout); // "hi"

await session.destroy();
```

### With AI SDK tools

```ts
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model,
  stopWhen: stepCountIs(10),
  prompt: `Run the tests.\n\nSandbox:\n${sandbox.description}`,
  experimental_sandbox: sandbox,
  tools: {
    shell: tool({
      description: 'Run a shell command in the sandbox.',
      inputSchema: z.object({ command: z.string() }),
      execute: ({ command }, { experimental_sandbox, abortSignal }) =>
        experimental_sandbox!.run({ command, abortSignal }),
    }),
  },
});
```

[`examples/scripted-agent.ts`](https://github.com/kosa8ai/kosa8-js/blob/main/examples/scripted-agent.ts) runs a full `generateText` tool loop against a kosa8 sandbox with a scripted model, so it needs no API key.

### With HarnessAgent

```ts
const session = await createKosa8NetworkSandboxSession({ image: 'node:22-alpine' });
const agentSession = await agent.createSession({ sandboxSession: session });
```

The older provider shape still works too: `new HarnessAgent({ sandbox: createKosa8Sandbox({ ... }) })`.

## How the local session maps onto kosa8

- Each session is one kosa8 sandbox (a microVM). Inside it, one long-lived container from `image` runs every command and holds every file. The image is pulled through the host, so pulling works even with `deny-all`.
- `run` and `spawn` go through the native exec endpoint. `workingDirectory` and `env` are applied per command. A non-zero exit is reported in the result, not thrown. `kill()` and `abortSignal` end the command and everything it started.
- File I/O also runs through exec: reads use `cat`, and writes are chunked, base64-encoded, then renamed into place, with parent directories created. The image needs `sh` and `base64` (alpine, debian and node images have both). A missing file reads as `null`.
- `restricted()` returns a frozen object with only `description`, the read and write methods, `run` and `spawn`. Code holding it cannot reach the client, stop the sandbox or change its network.
- `stop()` snapshots the running machine (memory, processes, disks) and stops it. `resumeKosa8NetworkSandboxSession({ sandboxId })` restores that snapshot under the same name, so files and processes come back. `destroy()` deletes the sandbox.
- `template` (and `identity` + `onFirstCreate` in the provider shape) runs the setup once and saves the result as a kosa8 snapshot. Later sessions restore that snapshot instead of repeating the setup.

### Network policy

| AI SDK policy | kosa8 egress |
| --- | --- |
| `{ mode: 'allow-all' }` | `any` |
| `{ mode: 'deny-all' }` | `deny`: every outbound connection is refused |
| `{ mode: 'custom', allowedHosts, allowedCIDRs }` | `allow:` those hosts and CIDRs, which can include `*.domain` wildcards; everything else is refused on the host |

You set the policy when you create the session (`networkPolicy`, or kosa8's own `egress`). If you set neither, the daemon applies the org policy's default egress, or unrestricted access when there is none.

## What the local session cannot do (honest errors)

| AI SDK feature | behaviour |
| --- | --- |
| `setNetworkPolicy()` on a running session | kosa8 sets a sandbox's egress when it is created. Asking for the policy already in force does nothing. Any other policy throws `HarnessCapabilityUnsupportedError`. |
| `deniedCIDRs` | throws `HarnessCapabilityUnsupportedError`. kosa8's egress is an allow-list with no deny-list, and anything not listed is already refused. |
| `getPortEndpoint`, `setPorts([...])` | throw `HarnessCapabilityUnsupportedError`. The native API has no port forwarding for sandboxes, and `ports` is `[]`. |
| `setRequestTransformations`, `addRequestTransformations` | not provided. kosa8's egress broker keeps credentials outside the sandbox, but you configure it at creation (`broker` setting) and it works by routes, not by rewriting HTTPS requests in flight. |
| `spawn` stdin, `pid` | exec has no stdin, so `pid` is not exposed. |

## Local API reference

### `createKosa8NetworkSandboxSession(options?)`

Creates a sandbox and returns a `Kosa8NetworkSandboxSession`. It takes the AI SDK create options (`sandboxId`, `template`, `abortSignal`) plus these settings:

| setting | default | |
| --- | --- | --- |
| `client` | `new Kosa8Client()` | a `Kosa8Client` or its options (socket, `KOSA8_HOST`, …) |
| `image` | `alpine:latest` | image of the work container |
| `workingDirectory` | `/workspace` | created if missing; relative paths resolve against it |
| `env` | | environment for every command |
| `networkPolicy` / `egress` | daemon default | see Network policy |
| `cpus`, `memMb`, `diskGb` | daemon defaults | |
| `mounts` | | host directories as `{ host_path, guest_path, read_only }` |
| `labels`, `broker` | | kosa8 classification labels; egress broker |
| `setupCommands` | | shell commands run once on a fresh sandbox |
| `approval` | | signed-approval id sent with every call, when the org policy wants one |

### `resumeKosa8NetworkSandboxSession({ sandboxId, ...settings })`

Reattaches to an existing sandbox. It restores the snapshot that `stop()` left, or starts the sandbox if it was stopped some other way. It never creates a sandbox.

### `createKosa8NetworkSandboxSessionFromSandbox({ sandbox, container?, ...settings })`

Wraps a sandbox you manage yourself. `stop()` and `destroy()` do nothing.

### `createKosa8SandboxSessionFromContainer({ sandbox, container, ... })`

Returns only the restricted, tool-safe session for an existing sandbox and container.

### `createKosa8Sandbox(settings)` / `Kosa8SandboxProvider`

The `HarnessV1SandboxProvider` shape (`createSession`, `resumeSession`). A `sessionId` maps to a deterministic sandbox name (`sandboxNameForSession`).

### Helpers

`toKosa8Egress(policy)`, `toCloudEgress(policy)`, `cloudTemplateSnapshotName(...)`, `KOSA8_CLOUD_PROVIDER_ID` (`'kosa8-cloud-sandbox'`), `restrictedView(session)`, `templateSnapshotId(...)`, `resumeSnapshotId(name)`, `KOSA8_PROVIDER_ID` (`'kosa8-sandbox'`).

Errors from the daemon reach you as `@kosa8/sdk`'s typed errors, with the daemon's message and remediation. For example, `Kosa8ApprovalRequiredError` explains which approvals the org policy wants.

## License

MIT. The license covers this SDK package only, not kosa8 itself.
