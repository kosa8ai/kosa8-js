import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A script that runs a command through the adapter and returns must let Node
 * exit. In 0.1.0 it did not: spawn stopped reading the exec stream at the
 * done frame without closing it, so the HTTP response was never destroyed
 * and its socket kept the process alive (until the daemon's keep-alive
 * timeout, minutes later). The script runs in a child process here, so the
 * test can see whether it exits.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'run-then-return.ts');
const root = path.resolve(here, '..', '..', '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');

let dir: string;
let socketPath: string;
let server: http.Server;
let holdOpen = false;

function frame(f: Record<string, unknown>): string {
  return JSON.stringify(f) + '\n';
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8x-'));
  socketPath = path.join(dir, 'd.sock');
  holdOpen = false;
  server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    if (req.method === 'POST' && /\/exec$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(frame({ stream: 'stdout', data: Buffer.from('hi\n').toString('base64') }));
      res.write(frame({ done: true, ok: true, exit: 0 }));
      // kosa8d ends the response after the done frame; a proxy or a slow
      // daemon may not yet. Either way the client must let go.
      if (!holdOpen) res.end();
      return;
    }
    res.writeHead(404).end();
  });
  // Like kosa8d's idle connection timeout: long enough that a client which
  // keeps the socket would still be waiting when the test gives up.
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => server.listen(socketPath, () => r()));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function runChild(mode: string): Promise<{ code: number | null; stdout: string; exitedAlone: boolean }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', tsx, fixture, socketPath, mode], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      resolve({ code: null, stdout, exitedAlone: false });
    }, 8_000);
    p.on('error', reject);
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) reject(new Error(`child failed (${code}): ${stderr}`));
      else resolve({ code, stdout, exitedAlone: true });
    });
  });
}

describe('the process exits after a command', () => {
  it('after run(), with the response ended by the daemon', async () => {
    const r = await runChild('run');
    expect(r.exitedAlone).toBe(true);
    expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 0, stdout: 'hi\n' });
  }, 20_000);

  it('after run(), with the response still open after the done frame', async () => {
    holdOpen = true;
    const r = await runChild('run');
    expect(r.exitedAlone).toBe(true);
    expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 0, stdout: 'hi\n' });
  }, 20_000);

  it('after readFile()', async () => {
    holdOpen = true;
    const r = await runChild('read');
    expect(r.exitedAlone).toBe(true);
    expect(JSON.parse(r.stdout)).toEqual({ text: 'hi\n' });
  }, 20_000);
});
