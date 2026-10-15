# @kosa8/ai-sdk-sandbox

A [kosa8](https://kosa8.com) sandbox for the [Vercel AI SDK 7](https://ai-sdk.dev). Your agent's commands and files run in a local microVM with its own kernel, and its network is closed except for the hosts you allow. Use it with `HarnessAgent`, or hand a session to AI SDK tools as `experimental_sandbox`.

It implements the AI SDK 7 sandbox interfaces (`Experimental_SandboxSession`, `HarnessV1NetworkSandboxSession`, `HarnessV1SandboxProvider`) in the same shape as `@ai-sdk/sandbox-vercel` and `@e2b/ai-sdk-sandbox`. It is built on [`@kosa8/sdk`](https://www.npmjs.com/package/@kosa8/sdk).

## Requirements

- kosa8 installed, with its daemon running (`kosa8 daemon start`):

  ```sh
  curl -fsSL https://kosa8.com/install.sh | sh
  ```

- macOS on Apple silicon, or x86-64 Linux.
- Node.js 22 or later (as required by `@ai-sdk/harness`).
- No API keys or accounts: everything runs on your machine.

## Install

```sh
npm install @kosa8/ai-sdk-sandbox ai
```

## Quickstart

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

## How it maps onto kosa8

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

## What kosa8 cannot do here (honest errors)

| AI SDK feature | behaviour |
| --- | --- |
| `setNetworkPolicy()` on a running session | kosa8 sets a sandbox's egress when it is created. Asking for the policy already in force does nothing. Any other policy throws `HarnessCapabilityUnsupportedError`. |
| `deniedCIDRs` | throws `HarnessCapabilityUnsupportedError`. kosa8's egress is an allow-list with no deny-list, and anything not listed is already refused. |
| `getPortEndpoint`, `setPorts([...])` | throw `HarnessCapabilityUnsupportedError`. The native API has no port forwarding for sandboxes, and `ports` is `[]`. |
| `setRequestTransformations`, `addRequestTransformations` | not provided. kosa8's egress broker keeps credentials outside the sandbox, but you configure it at creation (`broker` setting) and it works by routes, not by rewriting HTTPS requests in flight. |
| `spawn` stdin, `pid` | exec has no stdin, so `pid` is not exposed. |

## API reference

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

`toKosa8Egress(policy)`, `restrictedView(session)`, `templateSnapshotId(...)`, `resumeSnapshotId(name)`, `KOSA8_PROVIDER_ID` (`'kosa8-sandbox'`).

Errors from the daemon reach you as `@kosa8/sdk`'s typed errors, with the daemon's message and remediation. For example, `Kosa8ApprovalRequiredError` explains which approvals the org policy wants.

## License

MIT. The license covers this SDK package only, not kosa8 itself.
