# kosa8-js

**[kosa8](https://kosa8.com): Zero Trust cybersecurity infrastructure for AI agents.**

> **Switching from E2B / Daytona / Modal / Vercel Sandbox? Change one import.** Your code runs on kosa8 Cloud as it is; a call kosa8 cannot do throws `Unsupported` naming the kosa8 way.
>
> ```ts
> import { Sandbox } from '@kosa8/sdk/e2b';         // was: from 'e2b'
> import { Daytona } from '@kosa8/sdk/daytona';     // was: from '@daytonaio/sdk'
> import { ModalClient } from '@kosa8/sdk/modal';   // was: from 'modal'
> import { Sandbox } from '@kosa8/sdk/vercel';      // was: from '@vercel/sandbox'
> ```

TypeScript packages for [kosa8](https://kosa8.com), Zero Trust cybersecurity infrastructure for AI agents: every agent gets its own sealed microVM, with the network closed except for an allow-list you write.

| package | |
| --- | --- |
| [`@kosa8/sdk`](packages/sdk) | typed client for kosa8 Cloud (`Kosa8Cloud`, `https://api.kosa8.com`, an API key) and for the local daemon's native API over its unix socket (`Kosa8Client`): sandboxes, run and exec, files, checkpoint and rewind, fork, explore, snapshots |
| [`@kosa8/ai-sdk-sandbox`](packages/ai-sdk-sandbox) | kosa8 sandbox for the Vercel AI SDK 7 (`experimental_sandbox`, `HarnessAgent`), on kosa8 Cloud or the local daemon |

## Start on kosa8 Cloud

1. Sign up free at [app.kosa8.com](https://app.kosa8.com): the Starter plan, no card. Make an API key there.
2. Install and run:

```sh
npm install @kosa8/sdk
export KOSA8_API_KEY=k8c_live_...
```

```ts
import { Kosa8Cloud } from '@kosa8/sdk';

const cloud = new Kosa8Cloud(); // KOSA8_API_KEY, else your `kosa8 login` (~/.kosa8/cloud.json); talks to https://api.kosa8.com
const box = await cloud.sandboxes.create({ template: 'python', ttlS: 3600 });
console.log((await box.exec('python3 -c "print(6 * 7)"')).stdout); // 42
await box.delete();
```

More in the [@kosa8/sdk README](packages/sdk#kosa8-cloud-quickstart).

## Run on your own machine

`Kosa8Client` and the local `@kosa8/ai-sdk-sandbox` session use kosa8 installed with its daemon running, on macOS (Apple silicon) or x86-64 Linux:

```sh
curl -fsSL https://kosa8.com/install.sh | sh
kosa8 daemon start
```

## Examples

Runnable agents on kosa8 Cloud, each with its own `package.json` (`npm install`, then `npx tsx ...`). Without a model key they use a scripted stand-in model, so the sandbox side still runs for real.

| example | |
| --- | --- |
| [`examples/vercel-ai-sdk`](examples/vercel-ai-sdk) | Vercel AI SDK 7: a coding agent that writes, tests and fixes code in a sandbox (`experimental_sandbox`), and best-of-n over forks of one sandbox (`cloud.forkMap`) |
| [`examples/openai-agents`](examples/openai-agents) | OpenAI Agents SDK: `run_command`, `read_file` and `write_file` tools in a per-run sandbox, with labels, timeouts and a network allow-list |

## Development

```sh
npm install
npm run build
npm test                    # unit tests against a mock daemon on a unix socket and a mocked kosa8 Cloud
npm run test:integration    # against a real kosa8 daemon (default socket, or KOSA8_HOST=unix:///path.sock)
npx tsx examples/scripted-agent.ts   # AI SDK 7 tool loop with a scripted model, no API key
KOSA8_API_KEY=k8c_live_... npx tsx examples/cloud-live-check.ts   # the AI SDK session against real kosa8 Cloud; deletes what it makes
```

## License

MIT. The license covers the SDK packages in this repository only, not kosa8 itself.
