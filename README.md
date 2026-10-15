# kosa8-js

TypeScript packages for [kosa8](https://kosa8.com), secure local infrastructure for AI agents: every agent gets its own sealed microVM, with the network closed except for an allow-list you write.

| package | |
| --- | --- |
| [`@kosa8/sdk`](packages/sdk) | typed client for the kosa8 native API over the daemon's unix socket: sandboxes, run and exec, checkpoint and rewind, fork, explore, snapshots |
| [`@kosa8/ai-sdk-sandbox`](packages/ai-sdk-sandbox) | kosa8 sandbox for the Vercel AI SDK 7 (`experimental_sandbox`, `HarnessAgent`) |

Both packages need kosa8 installed with its daemon running, on macOS (Apple silicon) or x86-64 Linux:

```sh
curl -fsSL https://kosa8.com/install.sh | sh
kosa8 daemon start
```

## Development

```sh
npm install
npm run build
npm test                    # unit tests against a mock daemon on a unix socket
npm run test:integration    # against a real kosa8 daemon (default socket, or KOSA8_HOST=unix:///path.sock)
npx tsx examples/scripted-agent.ts   # AI SDK 7 tool loop with a scripted model, no API key
```

## License

MIT. The license covers the SDK packages in this repository only, not kosa8 itself.
