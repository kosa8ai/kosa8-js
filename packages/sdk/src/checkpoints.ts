import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Kosa8CheckpointError } from './errors.js';
import type { Checkpoint } from './types.js';

/**
 * Checkpoints are client-side bookkeeping over daemon snapshots, exactly as
 * in the kosa8 CLI and MCP server (pkg/checkpoint): a checkpoint is a
 * snapshot with the id `<sandbox>-ckpt-<n>`, and an ordered stack of them per
 * sandbox records labels and order. The daemon itself has no checkpoint
 * endpoint.
 */

/** How many checkpoints are kept per sandbox; the oldest is evicted (pkg/checkpoint MaxPerSandbox). */
export const MAX_CHECKPOINTS_PER_SANDBOX = 10;

type StoreData = Record<string, Checkpoint[]>;

/** Where checkpoint stacks are kept. */
export interface CheckpointStore {
  /** Read every stack. */
  load(): Promise<StoreData>;
  /** Run `fn` on the stacks and save what it leaves, serialised against other updates. */
  update<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T>;
}

/** Reject a name that could escape the store (pkg/checkpoint validSandbox). */
export function validateSandboxName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name) || name.startsWith('.')) {
    throw new Kosa8CheckpointError(`invalid sandbox name ${JSON.stringify(name)}`);
  }
}

/** Keeps stacks in memory only; nothing is shared with the kosa8 CLI. */
export class MemoryCheckpointStore implements CheckpointStore {
  private data: StoreData = {};
  private queue: Promise<unknown> = Promise.resolve();

  async load(): Promise<StoreData> {
    return structuredClone(this.data);
  }

  update<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const copy = structuredClone(this.data);
      const out = await fn(copy);
      this.data = copy;
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * The store the kosa8 CLI, MCP server and desk use: `~/.kosa8/checkpoints.json`
 * (mode 0600, rewritten atomically). Checkpoints taken through the SDK are
 * therefore visible to `kosa8 rewind` and the other way round.
 *
 * Updates are serialised within this process and between Node processes
 * using this store (an exclusive lock file beside it). The Go tools lock the
 * same file with flock(2), which Node cannot take, so an SDK update that
 * lands in the same instant as a CLI update could lose one record; the
 * snapshots themselves are unaffected.
 */
export class FileCheckpointStore implements CheckpointStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath?: string) {
    this.path = filePath ?? path.join(os.homedir(), '.kosa8', 'checkpoints.json');
  }

  async load(): Promise<StoreData> {
    let buf: string;
    try {
      buf = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      const parsed = JSON.parse(buf) as unknown;
      // A corrupt store must not make the sandbox unusable (as in pkg/checkpoint).
      return parsed && typeof parsed === 'object' ? (parsed as StoreData) : {};
    } catch {
      return {};
    }
  }

  update<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.locked(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async locked<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = this.path + '.node.lock';
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const h = await fs.open(lock, 'wx', 0o600);
        await h.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // A lock older than 30s belongs to a process that died holding it.
        try {
          const st = await fs.stat(lock);
          if (Date.now() - st.mtimeMs > 30_000) {
            await fs.rm(lock, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Kosa8CheckpointError(`timed out waiting for the checkpoint store lock ${lock}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      const data = await this.load();
      const out = await fn(data);
      const tmp = this.path + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.path);
      return out;
    } finally {
      await fs.rm(lock, { force: true });
    }
  }
}

function seqOf(id: string, sandbox: string): number {
  const pre = sandbox + '-ckpt-';
  if (!id.startsWith(pre)) return 0;
  const m = /^(\d+)/.exec(id.slice(pre.length));
  return m ? Number(m[1]) : 0;
}

function sorted(list: Checkpoint[]): Checkpoint[] {
  return list
    .map((c, i) => ({ c, i, t: Date.parse(c.created) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.c);
}

/** The stack logic of pkg/checkpoint, over any store. */
export class CheckpointBook {
  constructor(readonly store: CheckpointStore) {}

  /** The snapshot id the next checkpoint should use, and ids to evict to stay under the cap. */
  async nextId(sandbox: string): Promise<{ id: string; evict: string[] }> {
    validateSandboxName(sandbox);
    const list = (await this.store.load())[sandbox] ?? [];
    let n = list.length + 1;
    for (const c of list) {
      const v = seqOf(c.id, sandbox);
      if (v >= n) n = v + 1;
    }
    const evict: string[] = [];
    const over = list.length + 1 - MAX_CHECKPOINTS_PER_SANDBOX;
    if (over > 0) for (const c of list.slice(0, over)) evict.push(c.id);
    return { id: `${sandbox}-ckpt-${n}`, evict };
  }

  async record(c: Omit<Checkpoint, 'created'> & { created?: string }, evicted: string[] = []): Promise<Checkpoint> {
    validateSandboxName(c.sandbox);
    const rec: Checkpoint = {
      id: c.id,
      sandbox: c.sandbox,
      label: c.label ?? '',
      ...(c.auto ? { auto: true } : {}),
      created: c.created ?? new Date().toISOString(),
    };
    await this.store.update((s) => {
      const drop = new Set(evicted);
      s[c.sandbox] = [...(s[c.sandbox] ?? []).filter((e) => !drop.has(e.id)), rec];
    });
    return rec;
  }

  async list(sandbox: string): Promise<Checkpoint[]> {
    return sorted([...((await this.store.load())[sandbox] ?? [])]);
  }

  async latest(sandbox: string): Promise<Checkpoint> {
    const list = await this.list(sandbox);
    if (list.length === 0) {
      throw new Kosa8CheckpointError(
        `no checkpoints for ${JSON.stringify(sandbox)} — take one with checkpoint() or \`kosa8 checkpoint ${sandbox}\``,
      );
    }
    return list[list.length - 1]!;
  }

  /** Find by id or (case-insensitive) label, newest match first. */
  async resolve(sandbox: string, ref: string): Promise<Checkpoint> {
    const list = await this.list(sandbox);
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i]!;
      if (c.id === ref || c.label.toLowerCase() === ref.toLowerCase()) return c;
    }
    throw new Kosa8CheckpointError(`no checkpoint ${JSON.stringify(ref)} for sandbox ${JSON.stringify(sandbox)}`);
  }

  /** Keep `id` as the top of the stack; return the ids taken after it (now meaningless). */
  async pop(sandbox: string, id: string): Promise<string[]> {
    return this.store.update((s) => {
      const list = s[sandbox] ?? [];
      const idx = list.findIndex((c) => c.id === id);
      if (idx < 0) throw new Kosa8CheckpointError(`no checkpoint ${JSON.stringify(id)} for sandbox ${JSON.stringify(sandbox)}`);
      const orphaned = list.slice(idx + 1).map((c) => c.id);
      s[sandbox] = list.slice(0, idx + 1);
      return orphaned;
    });
  }

  /** Drop every checkpoint of a sandbox; return the snapshot ids to delete. */
  async forget(sandbox: string): Promise<string[]> {
    return this.store.update((s) => {
      const ids = (s[sandbox] ?? []).map((c) => c.id);
      delete s[sandbox];
      return ids;
    });
  }
}
