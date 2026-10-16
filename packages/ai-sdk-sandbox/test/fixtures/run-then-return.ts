// Run one command through the adapter and return, with no process.exit():
// the process must then exit on its own. Started by exit.test.ts in a child
// process, against the daemon socket given as the first argument.
import { Kosa8Client } from '@kosa8/sdk';
import { Kosa8SandboxSession } from '../../src/index.js';

const [socketPath, mode] = process.argv.slice(2);
const client = new Kosa8Client({ socketPath, env: {} });
const session = new Kosa8SandboxSession({
  client,
  sandbox: 'sb',
  container: 'c-1',
  image: 'alpine:latest',
  workingDirectory: '/work',
});

if (mode === 'read') {
  const stream = await session.readFile({ path: 'f.txt' });
  const text = stream ? await new Response(stream).text() : null;
  console.log(JSON.stringify({ text }));
} else {
  const r = await session.run({ command: 'echo hi' });
  console.log(JSON.stringify(r));
}
