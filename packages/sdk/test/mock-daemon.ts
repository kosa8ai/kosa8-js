import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type Handler = (
  req: Recorded,
  res: http.ServerResponse,
) => void | Promise<void>;

/** A minimal stand-in for kosa8d on a unix socket, for unit tests. */
export class MockDaemon {
  readonly socketPath: string;
  readonly requests: Recorded[] = [];
  private routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  private server: http.Server;
  private dir: string;

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8m-'));
    this.socketPath = path.join(this.dir, 'd.sock');
    this.server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const rec: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      this.requests.push(rec);
      const p = rec.url.split('?')[0]!;
      const route = this.routes.find((r) => r.method === rec.method && r.pattern.test(p));
      if (!route) {
        json(res, 404, { error: `no route ${rec.method} ${p}`, remediation: '' });
        return;
      }
      await route.handler(rec, res);
    });
  }

  on(method: string, pattern: string | RegExp, handler: Handler): this {
    const re = typeof pattern === 'string' ? new RegExp('^' + pattern.replace(/\{[^}]+\}/g, '[^/]+') + '$') : pattern;
    this.routes.unshift({ method, pattern: re, handler });
    return this;
  }

  start(): Promise<void> {
    return new Promise((r) => this.server.listen(this.socketPath, () => r()));
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  find(method: string, prefix: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.url.startsWith(prefix));
  }
}

export function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body) + '\n');
}

/** Write NDJSON frames as the daemon does (data base64-encoded). */
export function frames(
  res: http.ServerResponse,
  list: { stream?: string; data?: string | Buffer; done?: boolean; ok?: boolean; exit?: number; error?: string }[],
): void {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const f of list) {
    const out: Record<string, unknown> = { ...f };
    if (f.data !== undefined) out.data = Buffer.from(f.data).toString('base64');
    res.write(JSON.stringify(out) + '\n');
  }
  res.end();
}

export function sandbox(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: name,
    name,
    created: new Date().toISOString(),
    state: 'running',
    cpus: 2,
    mem_mb: 1024,
    ...extra,
  };
}
