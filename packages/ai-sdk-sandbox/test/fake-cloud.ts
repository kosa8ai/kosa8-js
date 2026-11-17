import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A kosa8 Cloud API in a fetch function, for tests. Execs run as real
 * processes on the host (so the adapter's shell scripts run for real), with
 * the sandbox's /workspace mapped to a temp dir: "/workspace" in argv and env
 * is rewritten to that dir, and back in output.
 */
export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

interface Job {
  id: string;
  sandbox: string;
  proc: ChildProcess;
  state: 'running' | 'exited';
  exit: number | null;
  stopped: boolean;
  out: string;
}

const KEY = 'k8c_live_testkey';
export const TEST_KEY = KEY;

export class FakeCloud {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'k8cloud-'));
  readonly seen: Seen[] = [];
  readonly sandboxes = new Map<string, Record<string, unknown>>();
  readonly snapshots: Record<string, unknown>[] = [];
  readonly jobs = new Map<string, Job>();
  readonly previews = new Map<number, string>();
  /** false: the files endpoints answer 501, as on a host without the data plane. */
  filesApi = true;
  /** Cap on `output` in a background status, to exercise truncation. */
  statusOutputCap = Infinity;
  private n = 0;
  private bg = 0;

  constructor() {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Host path of a sandbox path. */
  host(p: string): string {
    return p.replace(/^\/workspace(?=\/|$)/, this.root);
  }

  private toHost(s: string): string {
    return s.split('/workspace').join(this.root);
  }

  private fromHost(s: string): string {
    return s.split(this.root).join('/workspace');
  }

  calls(method: string, suffix: string): Seen[] {
    return this.seen.filter((s) => s.method === method && s.path.endsWith(suffix));
  }

  info(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id, state: 'running', template: 'base', cpus: 1, mem_mb: 256, source: 'pool', region: 'us-ash1', own_host: false,
      created_at: 1, started_at: 1, stopped_at: null, deleted_at: null, last_error: null, running_s: 0, asleep_s: 0,
      cost_usd: 0, ...over,
    };
  }

  addSandbox(over: Record<string, unknown> = {}): string {
    const id = `sbx_${++this.n}`;
    this.sandboxes.set(id, this.info(id, over));
    return id;
  }

  fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    let body: unknown;
    if (init.body instanceof Uint8Array) body = init.body;
    else if (typeof init.body === 'string' && init.body !== '') body = JSON.parse(init.body);
    const s: Seen = { method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, body };
    this.seen.push(s);
    if ((init.headers as Record<string, string>).Authorization !== `Bearer ${KEY}`) return j(401, { error: 'unauthorized' });
    return this.route(s);
  }) as unknown as typeof fetch;

  private async route(s: Seen): Promise<Response> {
    const m = /^\/v1\/sandboxes(?:\/([^/]+))?(\/.*)?$/.exec(s.path);
    if (s.path === '/v1/snapshots' && s.method === 'GET') return j(200, { snapshots: this.snapshots });
    if (!m) return j(404, { error: 'not_found', message: `no route ${s.path}` });
    const [, id, rest = ''] = m;
    if (!id) {
      if (s.method === 'POST') {
        const b = s.body as Record<string, unknown>;
        const nid = this.addSandbox({
          name: b.name ?? null, template: b.template ?? 'base', image: b.image ?? null, snapshot_id: b.snapshot ?? null,
        });
        return j(201, { sandbox: this.sandboxes.get(nid) });
      }
      const name = s.query.get('name');
      const list = [...this.sandboxes.values()].filter((x) => x.state !== 'deleted' && (name === null || x.name === name));
      return j(200, { sandboxes: list });
    }
    const box = this.sandboxes.get(id);
    if (!box || box.state === 'deleted') return j(404, { error: 'not_found', message: `no sandbox ${id}` });
    if (rest === '') {
      if (s.method === 'DELETE') {
        box.state = 'deleted';
        return j(200, { ok: true, id });
      }
      return j(200, { sandbox: box });
    }
    if (rest === '/labels' && s.method === 'PUT') {
      box.labels = (s.body as { labels: Record<string, string> }).labels;
      return j(200, { labels: box.labels });
    }
    if (rest === '/sleep') return j(200, { sandbox: Object.assign(box, { state: 'sleeping' }) });
    if (rest === '/wake') return j(200, { sandbox: Object.assign(box, { state: 'running' }) });
    if (rest === '/egress') {
      if (s.method === 'PUT') box.egress = s.body;
      const e = (box.egress ?? {}) as Record<string, unknown>;
      return j(200, { egress: { internet: e.internet ?? true, allow: e.allow ?? [], deny: e.deny ?? [], presets: [], source: 'sandbox', enforced: 'none' } });
    }
    if (rest === '/snapshots' && s.method === 'POST') {
      const snap = { id: `snap_${this.snapshots.length + 1}`, name: (s.body as { name?: string }).name ?? null, state: 'ready', source_sandbox_id: id };
      this.snapshots.push(snap);
      return j(201, { snapshot: snap });
    }
    if (rest === '/previews' && s.method === 'POST') {
      const port = (s.body as { port: number }).port;
      if (this.previews.has(port)) return j(409, { error: 'conflict', message: 'already open' });
      const url = `https://${port}-${id}.preview.test/?token=t${port}`;
      this.previews.set(port, url);
      return j(201, { preview: { port, public: false, url, host: 'x' } });
    }
    const link = /^\/previews\/(\d+)\/link$/.exec(rest);
    if (link) return j(200, { preview: { port: Number(link[1]), public: false, url: `${this.previews.get(Number(link[1]))}&fresh=1`, host: 'x' } });
    const del = /^\/previews\/(\d+)$/.exec(rest);
    if (del && s.method === 'DELETE') {
      this.previews.delete(Number(del[1]));
      return j(200, { ok: true });
    }
    if (rest.startsWith('/files')) return this.files(rest, s);
    if (rest === '/exec') return this.exec(id, s.body as { cmd: string[]; env?: string[]; background?: boolean });
    const st = /^\/exec\/([^/]+)(\/stop)?$/.exec(rest);
    if (st) {
      const job = this.jobs.get(st[1]!);
      if (!job) return j(404, { error: 'not_found' });
      if (st[2]) {
        if (job.state === 'exited') return j(200, { exec: { id: job.id, sandbox_id: id, state: 'exited' } });
        job.stopped = true;
        try {
          process.kill(-job.proc.pid!, 'SIGTERM');
        } catch {
          /* gone */
        }
        return j(200, { exec: { id: job.id, sandbox_id: id, state: 'stopping' } });
      }
      return j(200, { exec: this.status(job) });
    }
    return j(404, { error: 'not_found', message: `no route ${s.path}` });
  }

  private status(job: Job) {
    const onDisk = fs.existsSync(this.host(job.out)) ? fs.readFileSync(this.host(job.out)) : Buffer.alloc(0);
    const raw = Buffer.from(this.fromHost(onDisk.toString('utf8')));
    const truncated = raw.length > this.statusOutputCap;
    return {
      id: job.id, sandbox_id: job.sandbox, state: job.state, pid: job.proc.pid ?? null, exit: job.exit,
      output_path: job.out, exit_path: job.out.replace(/\.out$/, '.exit'),
      output: (truncated ? raw.subarray(0, this.statusOutputCap) : raw).toString('utf8'),
      output_bytes: raw.length, output_truncated: truncated, ...(job.stopped ? { stopped: true } : {}),
    };
  }

  private files(rest: string, s: Seen): Response {
    if (!this.filesApi) return j(501, { error: 'not_available', message: 'this host has no files API' });
    if (rest === '/files/mkdir') {
      fs.mkdirSync(this.host((s.body as { path: string }).path), { recursive: true });
      return j(200, { file: { path: (s.body as { path: string }).path, type: 'dir' } });
    }
    const p = s.query.get('path')!;
    if (!p.startsWith('/workspace/')) return j(400, { error: 'invalid_path', message: 'the files API reaches /workspace only' });
    const h = this.host(p);
    if (s.method === 'PUT') {
      if (!fs.existsSync(path.dirname(h))) return j(404, { error: 'not_found', message: 'no parent folder' });
      const data = s.body as Uint8Array;
      if (data.byteLength > 8 * 1024 * 1024) return j(413, { error: 'too_large' });
      fs.writeFileSync(h, data);
      return j(200, { file: { path: p, type: 'file', size: data.byteLength } });
    }
    if (!fs.existsSync(h)) return j(404, { error: 'not_found', message: `no such file: ${p}` });
    const data = fs.readFileSync(h);
    if (data.length > 8 * 1024 * 1024) return j(413, { error: 'too_large' });
    return new Response(new Uint8Array(data), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  }

  private exec(sandbox: string, b: { cmd: string[]; env?: string[]; background?: boolean }): Promise<Response> | Response {
    if (b.cmd.some((a) => a.length > 8192)) return j(400, { error: 'invalid_request', message: 'an argument is over 8192 characters' });
    if (Buffer.byteLength(JSON.stringify(b)) > 64 * 1024) return j(413, { error: 'too_large', message: 'body over 64 KiB' });
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir() };
    for (const kv of b.env ?? []) {
      const i = kv.indexOf('=');
      env[kv.slice(0, i)] = this.toHost(kv.slice(i + 1));
    }
    const argv = b.cmd.map((a) => this.toHost(a));
    if (b.background) {
      const id = `bg_${++this.bg}`;
      const out = `/workspace/.kosa8-bg/${id}.out`;
      fs.mkdirSync(this.host('/workspace/.kosa8-bg'), { recursive: true });
      const fd = fs.openSync(this.host(out), 'w');
      const proc = spawn(argv[0]!, argv.slice(1), { env, cwd: this.root, stdio: ['ignore', fd, fd], detached: true });
      fs.closeSync(fd);
      const job: Job = { id, sandbox, proc, state: 'running', exit: null, stopped: false, out };
      proc.on('close', (code, sig) => {
        job.exit = code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 0);
        job.state = 'exited';
        fs.writeFileSync(this.host(out.replace(/\.out$/, '.exit')), String(job.exit));
      });
      this.jobs.set(id, job);
      return j(202, { exec: { id, sandbox_id: sandbox, state: 'running', pid: proc.pid, exit: null, output_path: out, exit_path: out.replace(/\.out$/, '.exit') } });
    }
    return new Promise((resolve) => {
      const p = spawn(argv[0]!, argv.slice(1), { env, cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      p.stdout!.on('data', (d: Buffer) => out.push(d));
      p.stderr!.on('data', (d: Buffer) => err.push(d));
      p.on('close', (code) =>
        resolve(j(200, { exit: code, stdout: this.fromHost(Buffer.concat(out).toString()), stderr: this.fromHost(Buffer.concat(err).toString()) })),
      );
    });
  }

  close(): void {
    for (const job of this.jobs.values()) {
      if (job.state === 'running') {
        try {
          process.kill(-job.proc.pid!, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
