# Vercel AI SDK agent in a kosa8 Cloud sandbox

Two short [AI SDK 7](https://ai-sdk.dev) agents whose shell and files live in a [kosa8 Cloud](https://kosa8.com) sandbox, through [`@kosa8/ai-sdk-sandbox`](../../packages/ai-sdk-sandbox):

- **`agent.ts`**: `createKosa8CloudSandboxSession()` makes a sandbox (Node.js template, network closed), the agent writes `slugify.mjs` and its `node:test` tests with `writeFile`, runs them with `shell`, fixes the bug they catch with `editFile`, and the sandbox is deleted in `finally`. The tools reach the sandbox only through `experimental_sandbox`, given `session.restricted()`: they can read, write and run, but not stop the sandbox or open its network.
- **`best-of-n.ts`**: sets a sandbox up once (the tests), then `cloud.forkMap()` forks it 3 times and runs an attempt in each copy at once. Every copy is graded the same way (`node --test`), the best attempt wins, and each fork is deleted as soon as its attempt ends. The same pattern scales to many attempts, or to RL rollouts (see `rl` in [`@kosa8/sdk`](../../packages/sdk)).

`tools.ts` has the four tools (`shell`, `readFile`, `writeFile`, `editFile`); `model.ts` picks the model.

## Run

Node.js 22 or later.

```sh
cd examples/vercel-ai-sdk
npm install
export KOSA8_API_KEY=k8c_live_...      # from https://app.kosa8.com
export AI_GATEWAY_API_KEY=...          # Vercel AI Gateway; optional, see below
npx tsx agent.ts
npx tsx best-of-n.ts
npm run check                          # typecheck
```

| env | |
| --- | --- |
| `KOSA8_API_KEY` | kosa8 Cloud API key (required) |
| `AI_GATEWAY_API_KEY` | the model, through the [AI Gateway](https://vercel.com/docs/ai-gateway); any AI SDK provider works in its place (change `pickModel` in `model.ts`) |
| `KOSA8_EXAMPLE_MODEL` | gateway model id, default `anthropic/claude-sonnet-4.5` |
| `KOSA8_EXAMPLE_FAKE_MODEL=1` | use the scripted stand-in model even when a model key is set |

**No model key?** Without `AI_GATEWAY_API_KEY` both scripts say so and use a scripted stand-in model (`MockLanguageModelV4` from `ai/test`) that replays fixed tool calls. The sandbox, commands and files are all real, so this is a quick way to check your kosa8 setup. A real model reacts to what the tools return; the stand-in always does the same thing.

What a stand-in run of `agent.ts` prints:

```
[sandbox] sbx_RMK9BUioXJGtujQKLIDwZf
  wrote slugify.mjs (75 chars)
  wrote slugify.test.mjs (289 chars)
  $ node --test --test-reporter=tap 2>&1 | grep -E "^# (pass|fail)"
    # pass 1
    # fail 1
  edited slugify.mjs
  $ node --test --test-reporter=tap 2>&1 | grep -E "^# (pass|fail)"; cat slugify.mjs
    # pass 2
    # fail 0
    export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
[agent] slugify.mjs written; ... both tests pass. (6 steps)
[sandbox] sbx_RMK9BUioXJGtujQKLIDwZf deleted
```

## Cost

kosa8 plans start at $29/month; there is no free tier. Sandbox time comes out of your plan's Cloud sandbox-hours (one hour of a standard 2 vCPU / 4 GB sandbox is one sandbox-hour; Solo includes 100 a month, and extra hours are $15 per 100). `agent.ts` uses one sandbox for well under a minute; `best-of-n.ts` uses four (the base and three forks) for about 10 seconds each. Model tokens are billed by your model provider. Every sandbox is created with `ttlS: 900`, so even a killed script leaves nothing running for more than 15 minutes.
