// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

// A small in-memory kosa8 Cloud for the Daytona, Modal and Vercel shim
// tests: sandboxes, buffered / streamed / background exec, files, previews,
// egress, labels and snapshots.

import { Kosa8Cloud } from '../src/index.js';
import { KEY, info } from './helpers.js';

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

export interface FakeOpts {
  /** Refuse a persistent create (402 plan_limit persistent). */
  refusePersistent?: boolean;
  /** What a command prints: (argv) => [stdout, stderr, exit]. */
  run?: (argv: string[]) => [string, string, number];
  /** Background command polls: output pieces, last one exits. */
  bgPolls?: string[];
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

export function fakeCloud(opts: FakeOpts = {}) {
  const seen: Seen[] = [];
  const files = new Map<string, Uint8Array>();
  const boxes = new Map<string, Record<string, unknown>>();
  const bg: Record<string, { pieces: string[]; i: number }> = {};
  let n = 0;
  const run = opts.run ?? (() => ['ok\n', '', 0]);
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    let body: any;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body instanceof Uint8Array) body = init.body;
    const s: Seen = { method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, body };
    seen.push(s);
    const j = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    const p = s.path;
    if (p === '/v1/sandboxes' && s.method === 'POST') {
      if (opts.refusePersistent && body.persistent) {
        return j(402, { error: 'plan_limit', message: 'your plan allows 0 persistent sandboxes', limit_name: 'persistent' });
      }
      const id = `sbx_${++n}`;
      const b = info({ id, template: body.template ?? null, state: 'running', ...(body.labels ? { labels: body.labels } : {}), ...(body.name ? { name: body.name } : {}), persistent: !!body.persistent } as any);
      boxes.set(id, b as any);
      return j(201, { sandbox: b });
    }
    if (p === '/v1/sandboxes' && s.method === 'GET') return j(200, { sandboxes: [...boxes.values()] });
    let m = /^\/v1\/sandboxes\/(sbx_\d+)(\/.*)?$/.exec(p);
    if (!m) return j(404, { error: 'not_found', message: `no route ${s.method} ${p}` });
    const id = m[1]!, rest = m[2] ?? '';
    const box = boxes.get(id);
    if (!box) return j(404, { error: 'not_found', message: `no sandbox ${id}` });
    if (rest === '' && s.method === 'GET') return j(200, { sandbox: box });
    if (rest === '' && s.method === 'DELETE') { boxes.delete(id); return j(200, {}); }
    if (rest === '' && s.method === 'PATCH') return j(200, { sandbox: box, notes: [] });
    if (rest === '/sleep') { box.state = 'sleeping'; return j(200, { sandbox: box }); }
    if (rest === '/wake') { box.state = 'running'; return j(200, { sandbox: box }); }
    if (rest === '/labels') { box.labels = body.labels; return j(200, { labels: body.labels }); }
    if (rest === '/egress') return j(200, { egress: { internet: true, allow: [], deny: [], presets: [], ...body } });
    if (rest === '/snapshots') return j(201, { snapshot: { id: 'snap_1', name: body?.name ?? null } });
    if (rest === '/previews' && s.method === 'POST') {
      const host = `${body.port}-abc.kosa8labs.com`;
      return j(201, { preview: { port: body.port, public: !!body.public, host, url: body.public ? `https://${host}/` : `https://${host}/?kosa8_preview=tok`, ...(body.public ? {} : { token: 'tok' }) } });
    }
    if (rest === '/previews' && s.method === 'GET') return j(200, { previews: [] });
    if (rest === '/exec' && body?.background) {
      const bid = `bg_${++n}`;
      bg[bid] = { pieces: [...(opts.bgPolls ?? ['done\n'])], i: 0 };
      return j(202, { exec: { id: bid, state: 'running', exit: null } });
    }
    m = /^\/exec\/(bg_\d+)(\/stop)?$/.exec(rest);
    if (m) {
      const b = bg[m[1]!]!;
      if (m[2]) return j(200, { exec: { id: m[1], state: 'stopping' } });
      b.i = Math.min(b.i + 1, b.pieces.length);
      const done = b.i >= b.pieces.length;
      return j(200, { exec: { id: m[1], state: done ? 'exited' : 'running', exit: done ? 0 : null, output: b.pieces.slice(0, b.i).join('') } });
    }
    if (rest === '/exec') {
      const [out, err, exit] = run(body.cmd);
      if (body.stream) {
        const lines = [
          ...(out ? [{ stream: 'stdout', data: b64(out) }] : []),
          ...(err ? [{ stream: 'stderr', data: b64(err) }] : []),
          { done: true, exit },
        ].map((x) => JSON.stringify(x)).join('\n') + '\n';
        return new Response(lines, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      return j(200, { exit, stdout: out, stderr: err });
    }
    if (rest === '/files' && s.method === 'PUT') {
      files.set(s.query.get('path')!, body);
      return j(200, { file: { path: s.query.get('path'), type: 'file' } });
    }
    if (rest === '/files' && s.method === 'GET') {
      const d = files.get(s.query.get('path')!);
      if (!d) return j(404, { error: 'not_found', message: 'no such file' });
      return new Response(d as BodyInit, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }
    if (rest === '/files/list') {
      const dir = s.query.get('path')!;
      const out = [...files.keys()].filter((k) => k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/'))
        .map((k) => ({ name: k.slice(dir.length + 1), path: k, type: 'file', size: files.get(k)!.length }));
      return j(200, { files: out });
    }
    if (rest === '/files/mkdir') return j(200, { file: { path: body.path, type: 'dir' } });
    if (rest === '/files' && s.method === 'DELETE') { files.delete(s.query.get('path')!); return j(200, { removed: s.query.get('path') }); }
    return j(404, { error: 'not_found', message: `no route ${s.method} ${p}` });
  }) as unknown as typeof fetch;
  const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, baseUrl: 'http://127.0.0.1:9', fetch: f, retry: { baseMs: 1, maxMs: 2 } });
  const creates = () => seen.filter((x) => x.path === '/v1/sandboxes' && x.method === 'POST');
  const execs = () => seen.filter((x) => x.path.endsWith('/exec'));
  return { cloud, seen, files, creates, execs };
}
