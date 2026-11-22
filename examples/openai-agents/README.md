# OpenAI Agents SDK agent in a kosa8 Cloud sandbox

An [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) agent (`@openai/agents`) whose function tools, `run_command`, `read_file` and `write_file`, execute in a [kosa8 Cloud](https://kosa8.com) sandbox through [`@kosa8/sdk`](../../packages/sdk).

`agent.ts`:

- **One sandbox per run.** `runInSandbox(task, runner)` creates a sandbox (Python template), passes it to the tools as the run's context (`runner.run(agent, task, { context: { box } })`), and deletes it in `finally`, also when the run throws.
- **Labels**: `{ example, run }` on every sandbox, so `cloud.sandboxes.list({ labels: { example: 'openai-agents' } })` finds them (and `cloud.sandboxes.drain({ labels })` deletes them).
- **Timeouts at every level**: `timeoutS` on each command (kosa8 Cloud stops it), `timeoutMs` on each tool (the Agents SDK gives up on the call), `maxTurns` on the run, and `ttlS` on the sandbox (deleted after 15 minutes whatever happens).
- **Network closed by default**: `egress: { internet: false, allow: ['pypi.org', 'files.pythonhosted.org'] }`. The agent checks it: PyPI is reachable, `example.com` is not.

The agent writes `wordfreq.py` with a self-test, runs it, reads it back and probes the network.

## Run

Node.js 22 or later.

```sh
cd examples/openai-agents
npm install
export KOSA8_API_KEY=k8c_live_...      # from https://app.kosa8.com
export OPENAI_API_KEY=sk-...           # optional, see below
npx tsx agent.ts
npm run check                          # typecheck
```

| env | |
| --- | --- |
| `KOSA8_API_KEY` | kosa8 Cloud API key (required) |
| `OPENAI_API_KEY` | the model; the Agents SDK's default model, or set `OPENAI_DEFAULT_MODEL` |
| `KOSA8_EXAMPLE_FAKE_MODEL=1` | use the scripted stand-in model even when `OPENAI_API_KEY` is set |

**No model key?** Without `OPENAI_API_KEY` the script says so and runs a scripted stand-in: `ScriptedModel` implements the Agents SDK `Model` interface and returns fixed `function_call` items, given to a `Runner` as its `modelProvider` (tracing off). The Agents SDK still runs the loop and the tools, and the sandbox, commands and files are all real. A real model reacts to what the tools return; the stand-in always does the same thing.

What a stand-in run prints:

```
[sandbox] sbx_EcwDWasiuMeUfqQg3f3HfwZf labels={"example":"openai-agents","run":"run-mwrpkpiz"}
  wrote /workspace/wordfreq.py (294 chars)
  $ echo "the cat and the hat and the bat" | python3 wordfreq.py && uname -sm
    [('the', 3), ('and', 2), ('cat', 1)]
    Linux x86_64
  [exit 0]
  read /workspace/wordfreq.py (294 chars)
  $ for u in https://pypi.org/simple/ https://example.com/; do ...; done
    reachable https://pypi.org/simple/
    blocked   https://example.com/
  [exit 0]
[sandbox] sbx_EcwDWasiuMeUfqQg3f3HfwZf deleted
[agent] wordfreq.py counts words; ... PyPI is reachable and everything else is blocked.
```

## Cost

kosa8 plans start at $29/month; there is no free tier. Sandbox time comes out of your plan's Cloud sandbox-hours (one hour of a standard 2 vCPU / 4 GB sandbox is one sandbox-hour; Solo includes 100 a month, and extra hours are $15 per 100). One run uses one sandbox for well under a minute. Model tokens are billed by OpenAI.
