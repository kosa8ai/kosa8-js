/**
 * A build context as a tar stream, the way `kosa8 build` packs one: every
 * folder, file and symlink under the context, minus what `.dockerignore`
 * names (a path, or a prefix of one). No dependencies: plain ustar, with a
 * PAX header for a name or link target too long for it.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { Kosa8Error } from './errors.js';

const BLOCK = 512;

function octal(buf: Buffer, off: number, len: number, n: number): void {
  buf.write(n.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
}

function header(name: string, type: string, size: number, mode: number, mtime: number, link = ''): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  octal(h, 100, 8, mode & 0o7777);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(' ', 148, 156);
  h.write(type, 156, 1, 'ascii');
  h.write(link, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let n = Buffer.byteLength(body);
  let len = n + String(n).length;
  if (String(len).length !== String(n).length) len = n + String(len).length;
  return `${len}${body}`;
}

function pad(n: number): Buffer {
  const r = n % BLOCK;
  return Buffer.alloc(r === 0 ? 0 : BLOCK - r);
}

function entry(out: Buffer[], name: string, type: string, mode: number, mtime: number, data?: Buffer, link = ''): void {
  let pax = '';
  if (Buffer.byteLength(name) > 100) pax += paxRecord('path', name);
  if (Buffer.byteLength(link) > 100) pax += paxRecord('linkpath', link);
  if (pax !== '') {
    const p = Buffer.from(pax, 'utf8');
    out.push(header('PaxHeader', 'x', p.length, 0o644, mtime), p, pad(p.length));
  }
  const size = data?.length ?? 0;
  out.push(header(name.slice(0, 100), type, size, mode, mtime, link.slice(0, 100)));
  if (data) out.push(data, pad(size));
}

/** The `.dockerignore` entries: paths, normalised, comments and blanks dropped. */
async function readIgnore(dir: string): Promise<string[]> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(dir, '.dockerignore'), 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (l === '' || line.startsWith('#')) continue;
    out.push(path.posix.normalize(l.replace(/\\/g, '/')).replace(/\/+$/, '') || '.');
  }
  return out;
}

/**
 * Pack `dir` as a tar archive for POST /kosa8/v1/templates. Throws when the
 * Dockerfile is missing, so a bad path fails before anything is sent.
 */
export async function tarContext(dir: string, dockerfile = 'Dockerfile'): Promise<Buffer> {
  try {
    await fsp.access(path.join(dir, dockerfile));
  } catch {
    throw new Kosa8Error(`no ${dockerfile} in ${dir}`);
  }
  const ignore = await readIgnore(dir);
  const skip = (rel: string) => ignore.some((p) => rel === p || rel.startsWith(p + '/'));
  const out: Buffer[] = [];
  const walk = async (rel: string): Promise<void> => {
    const ents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const e of ents) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (skip(r)) continue;
      const full = path.join(dir, r);
      const st = await fsp.lstat(full);
      const mtime = Math.floor(st.mtimeMs / 1000);
      if (st.isSymbolicLink()) {
        entry(out, r, '2', st.mode, mtime, undefined, await fsp.readlink(full));
      } else if (st.isDirectory()) {
        entry(out, r + '/', '5', st.mode, mtime);
        subdirs.push(r);
      } else if (st.isFile()) {
        entry(out, r, '0', st.mode, mtime, await fsp.readFile(full));
      }
    }
    for (const s of subdirs) await walk(s);
  };
  await walk('');
  out.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(out);
}
