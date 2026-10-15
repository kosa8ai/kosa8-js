import { randomBytes } from 'node:crypto';
import * as posix from 'node:path/posix';
import {
  extractLines,
  type Experimental_SandboxProcess as SandboxProcess,
  type Experimental_SandboxSession as SandboxSession,
} from '@ai-sdk/provider-utils';
import { Kosa8StreamError, type Kosa8Client } from '@kosa8/sdk';
import {
  EISDIR_MARK,
  ENOENT_MARK,
  READ_SCRIPT,
  STAT_SCRIPT,
  commandScript,
  killScript,
  resolvePath,
  shq,
} from './shell.js';

/** Base64 characters per exec argument when writing files (Linux caps one argument at 128 KiB). */
const WRITE_CHUNK_B64 = 96 * 1024;
const WRITE_CHUNK_BYTES = (WRITE_CHUNK_B64 / 4) * 3;

export interface Kosa8SessionTarget {
  client: Kosa8Client;
  /** Sandbox id (its name). */
  sandbox: string;
  /** The long-lived container inside the sandbox that commands and file I/O use. */
  container: string;
  image: string;
  workingDirectory: string;
  /** Environment applied to every command (per-call env wins). */
  env?: Record<string, string>;
  /** Signed-approval id sent with every daemon call this session makes. */
  approval?: string;
  /** Network policy in force, for the description. */
  egress?: string;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

/**
 * `Experimental_SandboxSession` over a kosa8 sandbox. Commands and file I/O
 * run in one long-lived container inside the sandbox's microVM, through the
 * native exec endpoint (POST /kosa8/v1/sandboxes/{id}/exec).
 */
export class Kosa8SandboxSession implements SandboxSession {
  constructor(protected readonly target: Kosa8SessionTarget) {}

  get description(): string {
    const t = this.target;
    return [
      `kosa8 sandbox "${t.sandbox}": a microVM with its own kernel. Commands run in a ${t.image} container inside it (container ${t.container.slice(0, 12)}).`,
      `Working directory: ${t.workingDirectory}. Relative paths resolve against it.`,
      `Network: ${t.egress ? describeEgress(t.egress) : 'the daemon default (the org policy default egress, else unrestricted)'}.`,
      'Filesystem changes persist for the lifetime of the sandbox. No ports are exposed to the host.',
    ].join('\n');
  }

  private abs(p: string): string {
    return resolvePath(p, this.target.workingDirectory);
  }

  private exec(args: string[], signal?: AbortSignal) {
    return this.target.client.exec(this.target.sandbox, this.target.container, args, {
      approval: this.target.approval,
      signal,
    });
  }

  private async killTag(tag: string): Promise<void> {
    await this.exec(['sh', '-c', killScript(tag)]).catch(() => undefined);
  }

  async run(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = await this.spawn(options);
    const [stdout, stderr, result] = await Promise.all([
      streamToString(proc.stdout),
      streamToString(proc.stderr),
      proc.wait(),
    ]);
    return { exitCode: result.exitCode, stdout, stderr };
  }

  async spawn(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<SandboxProcess> {
    const signal = options.abortSignal;
    signal?.throwIfAborted();
    const tag = randomBytes(8).toString('hex');
    const script = commandScript({
      command: options.command,
      cwd: options.workingDirectory !== undefined ? this.abs(options.workingDirectory) : this.target.workingDirectory,
      env: { ...(this.target.env ?? {}), ...(options.env ?? {}) },
      tag,
    });

    let outCtl!: ReadableStreamDefaultController<Uint8Array>;
    let errCtl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (outCtl = c) });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (errCtl = c) });
    let closed = false;
    const close = (err?: unknown) => {
      if (closed) return;
      closed = true;
      for (const c of [outCtl, errCtl]) {
        try {
          if (err !== undefined) c.error(err);
          else c.close();
        } catch {
          /* already closed */
        }
      }
    };
    const push = (c: ReadableStreamDefaultController<Uint8Array>, data: Buffer) => {
      if (closed) return;
      try {
        c.enqueue(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } catch {
        /* reader cancelled */
      }
    };

    // The HTTP request is not tied to the abort signal: dropping it would not
    // stop the command (the daemon keeps running it), so abort kills the
    // process instead and the stream ends when it exits.
    const frames = this.target.client.execFrames(this.target.sandbox, this.target.container, ['sh', '-c', script], {
      approval: this.target.approval,
    });
    // Not awaited: the daemon sends nothing (not even headers) until the
    // command first writes, so spawn returns at once and a refusal surfaces
    // from wait() and as an error on the output streams.
    const iter = frames[Symbol.asyncIterator]();
    let killed = false;
    let exited = false;
    const kill = async () => {
      if (killed || exited) return;
      killed = true;
      await this.killTag(tag);
    };

    const exit: Promise<{ exitCode: number }> = (async () => {
      let r = await iter.next();
      while (!r.done) {
        const f = r.value;
        if (f.done) {
          if (f.error) throw new Kosa8StreamError(f.error, { stdout: '', stderr: '' }, { daemonMessage: f.error });
          return { exitCode: typeof f.exit === 'number' ? f.exit : 0 };
        }
        if (f.data) {
          if (f.stream === 'stderr') push(errCtl, f.data);
          else if (f.stream !== 'status') push(outCtl, f.data);
        }
        r = await iter.next();
      }
      throw new Kosa8StreamError('exec stream ended without an exit code', { stdout: '', stderr: '' });
    })();
    exit.then(
      () => {
        exited = true;
        close();
      },
      (err) => {
        exited = true;
        close(signal?.aborted ? undefined : err);
      },
    );

    const onAbort = () => void kill();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      void exit.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    }

    return {
      stdout,
      stderr,
      async wait() {
        let result: { exitCode: number } | undefined;
        try {
          result = await exit;
        } catch (err) {
          if (!signal?.aborted) throw err;
        }
        if (signal?.aborted) throw abortReason(signal);
        return result!;
      },
      async kill() {
        await kill();
        await exit.catch(() => undefined);
      },
    };
  }

  /** null when the path does not exist; throws for a directory or any other failure. */
  private async stat(abs: string, signal?: AbortSignal): Promise<boolean> {
    const r = await this.exec(['sh', '-c', STAT_SCRIPT, 'sh', abs], signal);
    if (r.exitCode === 0) return true;
    if (r.stderr.includes(ENOENT_MARK)) return false;
    if (r.stderr.includes(EISDIR_MARK)) throw new Error(`${abs} is a directory`);
    throw new Error(`could not read ${abs}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async readFile(options: { path: string; abortSignal?: AbortSignal }): Promise<ReadableStream<Uint8Array> | null> {
    const signal = options.abortSignal;
    signal?.throwIfAborted();
    const abs = this.abs(options.path);
    if (!(await this.stat(abs, signal))) return null;
    const frames = this.target.client.execFrames(this.target.sandbox, this.target.container, ['cat', '--', abs], {
      approval: this.target.approval,
      signal,
    });
    const iter = frames[Symbol.asyncIterator]();
    let stderr = '';
    return new ReadableStream<Uint8Array>({
      async pull(ctl) {
        for (;;) {
          const r = await iter.next();
          if (r.done) {
            ctl.error(new Error(`reading ${abs}: stream ended without an exit code`));
            return;
          }
          const f = r.value;
          if (f.done) {
            if (f.error) ctl.error(new Error(`reading ${abs}: ${f.error}`));
            else if (f.exit) ctl.error(new Error(`reading ${abs}: ${stderr.trim() || `exit ${f.exit}`}`));
            else ctl.close();
            return;
          }
          if (f.data && f.stream === 'stderr') stderr += f.data.toString('utf8');
          else if (f.data && f.stream !== 'status') {
            ctl.enqueue(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength));
            return;
          }
        }
      },
      async cancel() {
        await iter.return?.(undefined);
      },
    });
  }

  async readBinaryFile(options: { path: string; abortSignal?: AbortSignal }): Promise<Uint8Array | null> {
    options.abortSignal?.throwIfAborted();
    const abs = this.abs(options.path);
    const r = await this.exec(['sh', '-c', READ_SCRIPT, 'sh', abs], options.abortSignal);
    if (r.exitCode !== 0) {
      if (r.stderr.includes(ENOENT_MARK)) return null;
      if (r.stderr.includes(EISDIR_MARK)) throw new Error(`${abs} is a directory`);
      throw new Error(`could not read ${abs}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
    return new Uint8Array(r.stdoutBytes.buffer, r.stdoutBytes.byteOffset, r.stdoutBytes.byteLength);
  }

  async readTextFile(options: {
    path: string;
    encoding?: string;
    startLine?: number;
    endLine?: number;
    abortSignal?: AbortSignal;
  }): Promise<string | null> {
    const bytes = await this.readBinaryFile(options);
    if (bytes == null) return null;
    const text = Buffer.from(bytes).toString((options.encoding ?? 'utf-8') as BufferEncoding);
    return extractLines({ text, startLine: options.startLine, endLine: options.endLine });
  }

  /**
   * Write from any byte source, in chunks: each chunk travels base64-encoded
   * as an exec argument and is appended to a temporary file, which is then
   * renamed over the target. Parent directories are created.
   */
  private async writeChunks(path: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const abs = this.abs(path);
    const tmp = `${abs}.kosa8-tmp-${randomBytes(4).toString('hex')}`;
    const prep = await this.exec(
      [
        'sh',
        '-c',
        'command -v base64 >/dev/null 2>&1 || { echo "base64 is not available in this image; it is needed to write files" >&2; exit 127; }; mkdir -p -- "$1" && : > "$2"',
        'sh',
        posix.dirname(abs),
        tmp,
      ],
      signal,
    );
    if (prep.exitCode !== 0) throw new Error(`could not write ${abs}: ${prep.stderr.trim() || `exit ${prep.exitCode}`}`);
    try {
      let pending = Buffer.alloc(0);
      const flush = async (buf: Buffer) => {
        const r = await this.exec(
          ['sh', '-c', 'printf %s "$2" | base64 -d >> "$1"', 'sh', tmp, buf.toString('base64')],
          signal,
        );
        if (r.exitCode !== 0) throw new Error(`could not write ${abs}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
      };
      for await (const chunk of source) {
        pending = pending.length ? Buffer.concat([pending, Buffer.from(chunk)]) : Buffer.from(chunk);
        while (pending.length >= WRITE_CHUNK_BYTES) {
          await flush(pending.subarray(0, WRITE_CHUNK_BYTES));
          pending = pending.subarray(WRITE_CHUNK_BYTES);
        }
      }
      if (pending.length) await flush(pending);
      const mv = await this.exec(['sh', '-c', 'mv -f -- "$1" "$2"', 'sh', tmp, abs], signal);
      if (mv.exitCode !== 0) throw new Error(`could not write ${abs}: ${mv.stderr.trim() || `exit ${mv.exitCode}`}`);
    } catch (err) {
      await this.exec(['rm', '-f', '--', tmp]).catch(() => undefined);
      if (signal?.aborted) throw abortReason(signal);
      throw err;
    }
  }

  async writeFile(options: {
    path: string;
    content: ReadableStream<Uint8Array>;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const reader = options.content.getReader();
    const source = (async function* () {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    })();
    await this.writeChunks(options.path, source, options.abortSignal);
  }

  async writeBinaryFile(options: { path: string; content: Uint8Array; abortSignal?: AbortSignal }): Promise<void> {
    const content = options.content;
    await this.writeChunks(
      options.path,
      (async function* () {
        yield content;
      })(),
      options.abortSignal,
    );
  }

  async writeTextFile(options: {
    path: string;
    content: string;
    encoding?: string;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const buf = Buffer.from(options.content, (options.encoding ?? 'utf-8') as BufferEncoding);
    await this.writeBinaryFile({ path: options.path, content: buf, abortSignal: options.abortSignal });
  }
}

/**
 * A view with only the tool-safe surface (file I/O, run, spawn). It is a
 * plain frozen object of bound functions, so code holding it cannot reach the
 * client, stop the sandbox or change its network policy.
 */
export function restrictedView(session: SandboxSession): SandboxSession {
  return Object.freeze({
    get description() {
      return session.description;
    },
    readFile: session.readFile.bind(session),
    readBinaryFile: session.readBinaryFile.bind(session),
    readTextFile: session.readTextFile.bind(session),
    writeFile: session.writeFile.bind(session),
    writeBinaryFile: session.writeBinaryFile.bind(session),
    writeTextFile: session.writeTextFile.bind(session),
    spawn: session.spawn.bind(session),
    run: session.run.bind(session),
  });
}

export function describeEgress(egress: string): string {
  if (egress === 'any' || egress === '') return 'unrestricted outbound access';
  if (egress === 'deny') return 'no network access (every outbound connection is refused)';
  if (egress === 'fakenet') return 'a simulated internet (nothing leaves the host)';
  if (egress.startsWith('allow:')) return `outbound access only to ${egress.slice(6).split(',').join(', ')}; everything else is refused`;
  return egress;
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export { shq };
