import { randomBytes } from 'node:crypto';
import * as posix from 'node:path/posix';
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
} from '@ai-sdk/harness';
import {
  extractLines,
  type Experimental_SandboxProcess as SandboxProcess,
  type Experimental_SandboxSession as SandboxSession,
} from '@ai-sdk/provider-utils';
import {
  Kosa8Error,
  Kosa8NotFoundError,
  Kosa8UnsupportedError,
  type CloudBackgroundExec,
  type CloudBackgroundExecInfo,
  type CloudEgressPolicy,
  type CloudSandbox,
} from '@kosa8/sdk';
import { restrictedView } from './kosa8-sandbox-session.js';

export const KOSA8_CLOUD_PROVIDER_ID = 'kosa8-cloud-sandbox';

/** The folder the kosa8 Cloud files API reaches. */
export const CLOUD_FILES_ROOT = '/workspace';
/** Where the session stages file parts, large commands and stderr. */
export const CLOUD_SPILL_DIR = `${CLOUD_FILES_ROOT}/.kosa8-run`;
/** The files API carries at most this much per request. */
export const MAX_FILES_API_BYTES = 8 * 1024 * 1024;
/** The API reads at most 64 KiB of JSON per exec request; leave room for the wrapper. */
const EXEC_BODY_LIMIT = 60_000;
/** Bytes per exec when the files API is not there: 48,000 base64 characters. */
const EXEC_UPLOAD_CHUNK = 36_000;
/** A buffered exec keeps the first 1 MiB of a stream; 512 KiB of file is ~700 KB of base64. */
const EXEC_DOWNLOAD_CHUNK = 512 * 1024;
const MAX_ENV = 128;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Map the AI SDK network policy onto a kosa8 Cloud egress policy. kosa8 Cloud
 * has both an allow-list and a deny-list, so every mode maps, `deniedCIDRs`
 * included (a deny entry wins over an allow entry).
 */
export function toCloudEgress(policy: HarnessV1NetworkPolicy): CloudEgressPolicy {
  switch (policy.mode) {
    case 'allow-all':
      return { internet: true };
    case 'deny-all':
      return { internet: false, allow: [], deny: [] };
    case 'custom': {
      const allow = [...(policy.allowedHosts ?? []), ...(policy.allowedCIDRs ?? [])].map((h) => h.trim()).filter(Boolean);
      const deny = (policy.deniedCIDRs ?? []).map((h) => h.trim()).filter(Boolean);
      if (allow.length === 0) {
        throw new HarnessCapabilityUnsupportedError({
          harnessId: KOSA8_CLOUD_PROVIDER_ID,
          message: 'a custom network policy needs at least one entry in allowedHosts or allowedCIDRs; use { mode: "deny-all" } for no network.',
        });
      }
      return { internet: false, allow, deny };
    }
  }
}

function describeCloudEgress(p: CloudEgressPolicy | undefined): string {
  if (!p) return "the organization's default egress policy";
  const allow = p.allow ?? [];
  const deny = p.deny?.length ? `; never ${p.deny.join(', ')}` : '';
  if (p.internet) return `the whole internet${deny}`;
  if (allow.length === 0 && !p.presets?.length) return 'no network access (every outbound connection is refused)';
  return `outbound access only to ${[...allow, ...(p.presets ?? []).map((x) => `preset:${x}`)].join(', ')}${deny}; everything else is refused`;
}

export interface Kosa8CloudSessionTarget {
  /** The kosa8 Cloud sandbox (from `@kosa8/sdk`). */
  box: CloudSandbox;
  workingDirectory: string;
  /** Environment applied to every command (per-call env wins). */
  env?: Record<string, string>;
  /** Seconds after which kosa8 Cloud stops a command (`timeout_s`); none by default. */
  commandTimeoutS?: number;
  /** Longest wait between polls of a running command, ms (default 1000). */
  pollIntervalMs?: number;
  /** For the description: what it runs (template or image). */
  label?: string;
  /** For the description: the egress policy it was given. */
  egress?: CloudEgressPolicy;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function bytesOf(u: Uint8Array): Buffer {
  return Buffer.from(u.buffer, u.byteOffset, u.byteLength);
}

function u8(b: Buffer): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function checkEnv(env: Record<string, string>): void {
  for (const k of Object.keys(env)) {
    if (!ENV_KEY.test(k)) throw new Error(`invalid environment variable name ${JSON.stringify(k)}`);
  }
}

// --- shell scripts (POSIX sh: busybox ash, dash and bash run them) -------------
//
// Data travels in K8_* environment variables, not argv: the API takes at most
// 8192 characters per argument but a 64 KiB body.

/**
 * Runs K8_CMD (or the script file K8_CMDFILE) in K8_CWD with stdin from
 * /dev/null. stderr goes to K8_ERR, so it can be told apart from stdout
 * (a background command's output file holds both otherwise).
 */
const RUN_SCRIPT = [
  'c=$K8_CMD; cf=$K8_CMDFILE; w=$K8_CWD; e=$K8_ERR; unset K8_CMD K8_CMDFILE K8_CWD K8_ERR',
  'mkdir -p "${e%/*}" 2>/dev/null; exec 2>"$e"',
  'cd "$w" || exit $?',
  'if [ -n "$cf" ]; then sh "$cf" </dev/null; r=$?; rm -f "$cf"; exit $r; fi',
  'exec sh -c "$c" </dev/null',
].join('\n');

/**
 * $1 target, then staged part files: write them, in order, into the target
 * and remove them (no parts: an empty file). Parent folders are made. Errors
 * go to stderr as K8ERR:<code>.
 */
const INSTALL_SCRIPT = [
  't=$1; shift',
  '[ -d "$t" ] && { rm -f "$@"; echo K8ERR:is_directory >&2; exit 21; }',
  'dir=${t%/*}; [ -z "$dir" ] && dir=/',
  'if [ ! -d "$dir" ]; then mkdir -p "$dir" 2>/dev/null || { rm -f "$@"; if [ -e "$dir" ]; then echo K8ERR:not_a_directory >&2; else echo K8ERR:permission_denied >&2; fi; exit 22; }; fi',
  '( : >> "$t" ) 2>/dev/null || { rm -f "$@"; echo K8ERR:permission_denied >&2; exit 23; }',
  'if [ "$#" = 0 ]; then : > "$t"; exit 0; fi',
  'cat "$@" > "$t" 2>/dev/null; r=$?; rm -f "$@"',
  '[ "$r" = 0 ] || { echo K8ERR:write_failed >&2; exit 25; }',
].join('\n');

/**
 * $1 file, $2 part size, $3 part prefix, $4 1 to always split. Prints
 * "K8:<status> <size> <parts>"; a file over $2 bytes (or any, with $4) is
 * split into $3.0, $3.1, ... for the files API to read.
 */
const READ_CHECK_SCRIPT = [
  'p=$1; b=$2; o=$3',
  'if [ -d "$p" ]; then echo K8:is_directory; exit 0; fi',
  'if [ ! -e "$p" ]; then echo K8:file_not_found; exit 0; fi',
  'if [ ! -r "$p" ]; then echo K8:permission_denied; exit 0; fi',
  'z=$(wc -c < "$p" 2>/dev/null) || { echo K8:permission_denied; exit 0; }; z=$((z + 0))',
  'n=0; if [ "$z" -gt "$b" ] || [ "$4" = 1 ]; then mkdir -p "${o%/*}" || exit 1',
  'while [ $((n * b)) -lt "$z" ]; do dd if="$p" of="$o.$n" bs="$b" skip="$n" count=1 2>/dev/null || { rm -f "$o".*; exit 1; }; n=$((n + 1)); done; fi',
  'echo "K8:ok $z $n"',
].join('\n');

/** $1 path, $2 w (truncate, making parent folders) or a (append); data (base64) in K8_DATA. */
const EXEC_UPLOAD_SCRIPT = [
  'p=$1; m=$2; d=$K8_DATA; unset K8_DATA',
  'if [ "$m" = w ]; then',
  '  dir=${p%/*}; [ -z "$dir" ] && dir=/',
  '  mkdir -p "$dir" 2>/dev/null || { echo K8ERR:permission_denied >&2; exit 22; }',
  '  ( : > "$p" ) 2>/dev/null || { echo K8ERR:permission_denied >&2; exit 23; }',
  'fi',
  '[ -z "$d" ] && exit 0',
  'command -v base64 >/dev/null 2>&1 || { echo K8ERR:base64_missing >&2; exit 24; }',
  'printf %s "$d" | base64 -d >> "$p" || { echo K8ERR:write_failed >&2; exit 25; }',
].join('\n');

/** $1 path, $2 chunk size, $3 chunk index. Chunk 0 starts with a status line. */
const EXEC_DOWNLOAD_SCRIPT = [
  'p=$1; c=$2; n=$3',
  'if [ "$n" = 0 ]; then',
  '  if [ -d "$p" ]; then echo K8:is_directory; exit 0; fi',
  '  if [ ! -e "$p" ]; then echo K8:file_not_found; exit 0; fi',
  '  if [ ! -r "$p" ]; then echo K8:permission_denied; exit 0; fi',
  '  z=$(wc -c < "$p" 2>/dev/null) || { echo K8:permission_denied; exit 0; }',
  '  command -v base64 >/dev/null 2>&1 || { echo K8:base64_missing; exit 0; }',
  '  echo "K8:ok $((z + 0))"',
  'fi',
  'dd if="$p" bs="$c" skip="$n" count=1 2>/dev/null | base64',
].join('\n');

function writeError(abs: string, stderr: string, exit: number | null): Error {
  const code = /K8ERR:([a-z_]+)/.exec(stderr)?.[1];
  if (code === 'is_directory') return new Error(`could not write ${abs}: it is a directory`);
  if (code === 'not_a_directory') return new Error(`could not write ${abs}: a parent is not a directory`);
  if (code === 'permission_denied') return new Error(`could not write ${abs}: permission denied`);
  if (code === 'base64_missing') return new Error('the sandbox image has no base64 command, which file transfer needs');
  return new Error(`could not write ${abs}: ${stderr.replace(/K8ERR:\S+/g, '').trim() || `exit ${exit}`}`);
}

function readError(abs: string, status: string): Error {
  if (status === 'is_directory') return new Error(`${abs} is a directory`);
  if (status === 'permission_denied') return new Error(`could not read ${abs}: permission denied`);
  if (status === 'base64_missing') return new Error('the sandbox image has no base64 command, which file transfer needs');
  return new Error(`could not read ${abs}: ${status}`);
}

/** How a file is read: through the files API (the path itself or staged parts), or through exec. */
type ReadPlan = { kind: 'missing' } | { kind: 'direct'; path: string } | { kind: 'parts'; parts: string[] } | { kind: 'exec' };

/**
 * `Experimental_SandboxSession` over a kosa8 Cloud sandbox.
 *
 * - Commands run as background execs (`POST …/exec` with `background: true`),
 *   so they are not held to the 90 s limit of a buffered exec, and
 *   `kill()`/`abortSignal` stop them through `…/exec/{id}/stop`. Their output
 *   is read by polling `GET …/exec/{id}`; stderr goes to a file of its own.
 * - Files travel through the files API (`/workspace` only, at most 8 MiB per
 *   request): a write is staged in `/workspace/.kosa8-run` in parts and moved
 *   into place by one exec, which makes parent folders; a read is checked by
 *   one exec, which also splits a file over 8 MiB (or outside `/workspace`)
 *   into staged parts. A host without the files API gets the bytes through
 *   exec, base64-encoded, in chunks.
 */
export class Kosa8CloudSandboxSession implements SandboxSession {
  /** undefined until the first transfer finds out whether the host has the files API. */
  private filesApi: boolean | undefined;

  constructor(protected readonly target: Kosa8CloudSessionTarget) {}

  get description(): string {
    const t = this.target;
    return [
      `kosa8 Cloud sandbox ${t.box.id}: a microVM with its own kernel${t.label ? `, running ${t.label}` : ''}.`,
      `Working directory: ${t.workingDirectory}. Relative paths resolve against it.`,
      `Network: ${describeCloudEgress(t.egress)}.`,
      'Files written anywhere persist for the lifetime of the sandbox; /workspace is its data disk.',
    ].join('\n');
  }

  protected abs(p: string): string {
    return posix.resolve(this.target.workingDirectory, p);
  }

  /** A short shell script through a buffered exec; `$1…` are `args`. */
  protected sh(script: string, args: string[] = [], env?: Record<string, string>, signal?: AbortSignal) {
    return this.target.box.exec(['sh', '-c', script, 'k8', ...args], { env, signal });
  }

  // --- commands ----------------------------------------------------------------

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
    const t = this.target;
    const tag = randomBytes(8).toString('hex');
    const errFile = `${CLOUD_SPILL_DIR}/${tag}.err`;
    const userEnv = { ...(t.env ?? {}), ...(options.env ?? {}) };
    checkEnv(userEnv);
    const k8: Record<string, string> = {
      K8_CMD: options.command,
      K8_CWD: options.workingDirectory !== undefined ? this.abs(options.workingDirectory) : t.workingDirectory,
      K8_ERR: errFile,
    };
    if (Object.keys(userEnv).length + Object.keys(k8).length + 1 > MAX_ENV) {
      throw new Error(`at most ${MAX_ENV - 4} environment variables per command on kosa8 Cloud`);
    }
    const size = () =>
      Buffer.byteLength(
        JSON.stringify({
          cmd: ['sh', '-c', RUN_SCRIPT, 'k8'],
          env: Object.entries({ ...userEnv, ...k8 }).map(([k, v]) => `${k}=${v}`),
          background: true,
          timeout_s: 86_400,
        }),
      );
    if (size() > EXEC_BODY_LIMIT) {
      // Too big for one request: the command travels as a staged file.
      const file = `${CLOUD_SPILL_DIR}/cmd-${tag}.sh`;
      await this.writeBytes(file, Buffer.from(options.command, 'utf8'), signal);
      delete k8.K8_CMD;
      k8.K8_CMDFILE = file;
      if (size() > EXEC_BODY_LIMIT) throw new Error("the command's environment is too large for one kosa8 Cloud exec request");
    }

    const job = await t.box.execBackground(['sh', '-c', RUN_SCRIPT, 'k8'], {
      env: { ...userEnv, ...k8 },
      timeoutS: t.commandTimeoutS,
      signal,
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
      if (closed || data.length === 0) return;
      try {
        c.enqueue(u8(data));
      } catch {
        /* reader cancelled */
      }
    };

    let killed = false;
    let exited = false;
    let stopping: Promise<unknown> | undefined;
    let wake: (() => void) | undefined;
    const kill = async () => {
      if (killed || exited) return;
      killed = true;
      stopping = job.stop().catch(() => undefined);
      wake?.();
      await stopping;
    };

    const exit: Promise<{ exitCode: number }> = (async () => {
      let emitted = 0;
      let fromStatus = true;
      let interval = 100;
      let failures = 0;
      let info: CloudBackgroundExecInfo = job.info;
      for (;;) {
        try {
          info = await job.status();
          failures = 0;
        } catch (err) {
          // A poll that fails now and then must not lose the command.
          if (++failures >= 4) throw err;
          await sleep(500 * failures);
          continue;
        }
        if (info.output_truncated) fromStatus = false;
        if (fromStatus && typeof info.output === 'string') {
          const b = Buffer.from(info.output, 'utf8');
          if (b.length > emitted) {
            push(outCtl, b.subarray(emitted));
            emitted = b.length;
          }
        }
        if (info.state === 'exited') break;
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, interval);
        });
        wake = undefined;
        interval = Math.min(Math.round(interval * 1.5), t.pollIntervalMs ?? 1000);
      }
      // The rest of stdout when the status answer did not carry all of it.
      const outPath = info.output_path ?? job.info.output_path;
      if (outPath && (!fromStatus || (typeof info.output_bytes === 'number' && info.output_bytes > emitted))) {
        const all = await this.readBinaryFile({ path: outPath }).catch(() => null);
        if (all && all.byteLength > emitted) push(outCtl, bytesOf(all).subarray(emitted));
      }
      const err = await this.readBinaryFile({ path: errFile }).catch(() => null);
      if (err) push(errCtl, bytesOf(err));
      // Leave nothing behind: stderr and the background command's files.
      const base = outPath ? outPath.replace(/\.out$/, '') : undefined;
      void this.sh('rm -f "$@"', [errFile, ...(base ? [`${base}.out`, `${base}.exit`, `${base}.pid`] : [])]).catch(() => undefined);
      if (typeof info.exit === 'number') return { exitCode: info.exit };
      return { exitCode: info.timed_out ? 124 : 1 };
    })();
    exit.then(
      () => {
        exited = true;
        close();
      },
      (err) => {
        exited = true;
        close(signal?.aborted || killed ? undefined : err);
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

  // --- files -------------------------------------------------------------------

  private underFilesRoot(abs: string): boolean {
    return abs.startsWith(`${CLOUD_FILES_ROOT}/`) && posix.normalize(abs) === abs;
  }

  /** Make the staging folder through the files API; false when the host has no files API. */
  private async filesApiReady(): Promise<boolean> {
    if (this.filesApi !== undefined) return this.filesApi;
    try {
      await this.target.box.files.mkdir(CLOUD_SPILL_DIR);
      this.filesApi = true;
    } catch (err) {
      if (!(err instanceof Kosa8UnsupportedError)) throw err;
      this.filesApi = false;
    }
    return this.filesApi;
  }

  /** Write bytes from any source to `abs` (absolute), making parent folders. */
  private async writeSource(abs: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (await this.filesApiReady()) return this.writeViaFilesApi(abs, source, signal);
    return this.writeViaExec(abs, source, signal);
  }

  private writeBytes(abs: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    return this.writeSource(
      abs,
      (async function* () {
        yield data;
      })(),
      signal,
    );
  }

  private async writeViaFilesApi(abs: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
    const files = this.target.box.files;
    const prefix = `${CLOUD_SPILL_DIR}/up-${randomBytes(8).toString('hex')}`;
    const parts: string[] = [];
    try {
      let pending = Buffer.alloc(0);
      const put = async (buf: Buffer) => {
        signal?.throwIfAborted();
        const name = `${prefix}.${parts.length}`;
        parts.push(name);
        await files.write(name, u8(buf));
      };
      for await (const chunk of source) {
        pending = pending.length ? Buffer.concat([pending, bytesOf(chunk)]) : Buffer.from(bytesOf(chunk));
        while (pending.length >= MAX_FILES_API_BYTES) {
          await put(pending.subarray(0, MAX_FILES_API_BYTES));
          pending = pending.subarray(MAX_FILES_API_BYTES);
        }
      }
      if (pending.length) await put(pending);
      signal?.throwIfAborted();
      // One exec moves the parts into place (and removes them), so parent
      // folders are made and the sandbox's own permissions apply.
      const r = await this.sh(INSTALL_SCRIPT, [abs, ...parts]);
      parts.length = 0;
      if (r.exitCode !== 0) throw writeError(abs, r.stderr, r.exitCode);
    } catch (err) {
      if (parts.length) await this.sh('rm -f "$@"', parts).catch(() => undefined);
      if (signal?.aborted) throw abortReason(signal);
      throw err;
    }
  }

  private async writeViaExec(abs: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
    const tmp = `${abs}.kosa8-tmp-${randomBytes(4).toString('hex')}`;
    let first = true;
    const send = async (buf: Buffer) => {
      signal?.throwIfAborted();
      const r = await this.sh(EXEC_UPLOAD_SCRIPT, [tmp, first ? 'w' : 'a'], { K8_DATA: buf.toString('base64') }, signal);
      first = false;
      if (r.exitCode !== 0) throw writeError(abs, r.stderr, r.exitCode);
    };
    try {
      let pending = Buffer.alloc(0);
      for await (const chunk of source) {
        pending = pending.length ? Buffer.concat([pending, bytesOf(chunk)]) : Buffer.from(bytesOf(chunk));
        while (pending.length >= EXEC_UPLOAD_CHUNK) {
          await send(pending.subarray(0, EXEC_UPLOAD_CHUNK));
          pending = pending.subarray(EXEC_UPLOAD_CHUNK);
        }
      }
      if (pending.length || first) await send(pending);
      const mv = await this.sh('[ -d "$2" ] && { echo K8ERR:is_directory >&2; exit 21; }; mv -f -- "$1" "$2"', [tmp, abs], undefined, signal);
      if (mv.exitCode !== 0) throw writeError(abs, mv.stderr, mv.exitCode);
    } catch (err) {
      await this.sh('rm -f -- "$1"', [tmp]).catch(() => undefined);
      if (signal?.aborted) throw abortReason(signal);
      throw err;
    }
  }

  /** Check a file and, through the files API, stage it in parts when it is large or outside /workspace. */
  private async readPlan(abs: string, signal?: AbortSignal): Promise<ReadPlan> {
    if (!(await this.filesApiReady())) return { kind: 'exec' };
    const prefix = `${CLOUD_SPILL_DIR}/dl-${randomBytes(8).toString('hex')}`;
    const split = this.underFilesRoot(abs) ? '0' : '1';
    const r = await this.sh(READ_CHECK_SCRIPT, [abs, String(MAX_FILES_API_BYTES), prefix, split], undefined, signal);
    const head = r.stdout.trim().split(/\s+/);
    if (r.exitCode !== 0 || !head[0]?.startsWith('K8:')) {
      throw new Error(`could not read ${abs}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
    const status = head[0].slice(3);
    if (status === 'file_not_found') return { kind: 'missing' };
    if (status !== 'ok') throw readError(abs, status);
    const n = Number(head[2] ?? 0);
    if (n === 0) {
      // Empty files outside /workspace have no parts.
      return split === '1' ? { kind: 'parts', parts: [] } : { kind: 'direct', path: abs };
    }
    return { kind: 'parts', parts: Array.from({ length: n }, (_, i) => `${prefix}.${i}`) };
  }

  /** A file's bytes through exec, base64-encoded, chunk by chunk; null when missing. */
  private async *readViaExec(abs: string, signal?: AbortSignal): AsyncGenerator<Uint8Array, void, undefined> {
    let size = -1;
    let got = 0;
    for (let n = 0; size < 0 || got < size; n++) {
      const r = await this.sh(EXEC_DOWNLOAD_SCRIPT, [abs, String(EXEC_DOWNLOAD_CHUNK), String(n)], undefined, signal);
      if (r.exitCode !== 0) throw new Error(`could not read ${abs}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
      let text = r.stdout;
      if (n === 0) {
        const nl = text.indexOf('\n');
        const head = (nl >= 0 ? text.slice(0, nl) : text).trim().split(/\s+/);
        text = nl >= 0 ? text.slice(nl + 1) : '';
        if (!head[0]?.startsWith('K8:')) throw new Error(`could not read ${abs}: unexpected answer`);
        const status = head[0].slice(3);
        if (status !== 'ok') throw Object.assign(readError(abs, status), { k8status: status });
        size = Number(head[1]);
      }
      const part = Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
      if (part.length === 0 && got < size) throw new Error(`could not read ${abs}: expected ${size} bytes, got ${got} (the file changed?)`);
      got += part.length;
      if (part.length) yield u8(part);
    }
  }

  async readFile(options: { path: string; abortSignal?: AbortSignal }): Promise<ReadableStream<Uint8Array> | null> {
    const signal = options.abortSignal;
    signal?.throwIfAborted();
    const abs = this.abs(options.path);
    const plan = await this.readPlan(abs, signal);
    if (plan.kind === 'missing') return null;
    const files = this.target.box.files;
    let source: AsyncIterator<Uint8Array>;
    let cleanup = async () => {};
    if (plan.kind === 'exec') {
      const it = this.readViaExec(abs, signal);
      // Read the first chunk now, so a missing file is null rather than a stream error.
      let first: IteratorResult<Uint8Array>;
      try {
        first = await it.next();
      } catch (err) {
        if ((err as { k8status?: string }).k8status === 'file_not_found') return null;
        throw err;
      }
      let used = false;
      source = {
        next: async () => {
          if (!used) {
            used = true;
            return first;
          }
          return it.next();
        },
        return: async () => {
          await it.return(undefined);
          return { done: true, value: undefined };
        },
      };
    } else if (plan.kind === 'direct') {
      source = (async function* () {
        yield await files.read(plan.path);
      })();
    } else {
      const parts = plan.parts;
      cleanup = async () => {
        if (parts.length) await this.sh('rm -f "$@"', parts).catch(() => undefined);
      };
      source = (async function* () {
        for (const p of parts) {
          signal?.throwIfAborted();
          yield await files.read(p);
        }
      })();
    }
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      await cleanup();
    };
    return new ReadableStream<Uint8Array>({
      async pull(ctl) {
        try {
          // Loop past empty chunks: a pull that enqueues nothing is not called again.
          for (;;) {
            const r = await source.next();
            if (r.done) {
              await finish();
              ctl.close();
              return;
            }
            if (r.value.byteLength) {
              ctl.enqueue(r.value);
              return;
            }
          }
        } catch (err) {
          await finish();
          ctl.error(signal?.aborted ? abortReason(signal) : err);
        }
      },
      async cancel() {
        await source.return?.(undefined);
        await finish();
      },
    });
  }

  async readBinaryFile(options: { path: string; abortSignal?: AbortSignal }): Promise<Uint8Array | null> {
    const stream = await this.readFile(options);
    if (stream == null) return null;
    const chunks: Buffer[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(bytesOf(value));
    }
    return u8(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
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
    const text = bytesOf(bytes).toString((options.encoding ?? 'utf-8') as BufferEncoding);
    return extractLines({ text, startLine: options.startLine, endLine: options.endLine });
  }

  async writeFile(options: { path: string; content: ReadableStream<Uint8Array>; abortSignal?: AbortSignal }): Promise<void> {
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
    await this.writeSource(this.abs(options.path), source, options.abortSignal);
  }

  async writeBinaryFile(options: { path: string; content: Uint8Array; abortSignal?: AbortSignal }): Promise<void> {
    await this.writeBytes(this.abs(options.path), options.content, options.abortSignal);
  }

  async writeTextFile(options: { path: string; content: string; encoding?: string; abortSignal?: AbortSignal }): Promise<void> {
    const buf = Buffer.from(options.content, (options.encoding ?? 'utf-8') as BufferEncoding);
    await this.writeBytes(this.abs(options.path), u8(buf), options.abortSignal);
  }
}

export interface Kosa8CloudNetworkSessionInit extends Kosa8CloudSessionTarget {
  /** Whether stop()/destroy() act on the sandbox (false when wrapping one the caller owns). */
  ownsLifecycle: boolean;
}

/**
 * `HarnessV1NetworkSandboxSession` over a kosa8 Cloud sandbox: the tool-safe
 * session plus lifecycle, network policy and ports.
 *
 * - `stop()` puts the sandbox to sleep (kosa8 Cloud snapshots it, memory and
 *   files, and frees its VM). Resuming wakes it as it was.
 * - `destroy()` deletes the sandbox.
 * - `setNetworkPolicy()` changes the sandbox's egress at once.
 * - `getPortEndpoint()` opens a private kosa8 Cloud preview of the port: an
 *   https URL with a signed token (`wss://` for `protocol: 'ws'`).
 * - Request transformations are not offered: kosa8 Cloud keeps credentials
 *   outside the sandbox with org secrets (`secrets` at create), which work as
 *   placeholders swapped on the way out, not as rules set per session.
 */
export class Kosa8CloudNetworkSandboxSession extends Kosa8CloudSandboxSession implements HarnessV1NetworkSandboxSession {
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  private readonly ownsLifecycle: boolean;
  private readonly openPorts = new Set<number>();
  private stopped = false;
  private destroyed = false;

  constructor(init: Kosa8CloudNetworkSessionInit) {
    super(init);
    this.id = init.box.id;
    this.defaultWorkingDirectory = init.workingDirectory;
    this.ownsLifecycle = init.ownsLifecycle;
  }

  /** The kosa8 Cloud sandbox id (`sbx_…`); resume with it. */
  get sandboxId(): string {
    return this.target.box.id;
  }

  /** The `@kosa8/sdk` handle, for everything else kosa8 Cloud offers (checkpoints, fork, previews, ...). */
  get sandbox(): CloudSandbox {
    return this.target.box;
  }

  get ports(): ReadonlyArray<number> {
    return [...this.openPorts].sort((a, b) => a - b);
  }

  restricted(): SandboxSession {
    return restrictedView(this);
  }

  getPortEndpoint = async (options: { port: number; protocol?: 'http' | 'https' | 'ws' }): Promise<HarnessV1PortEndpoint> => {
    const previews = this.target.box.previews;
    let url: string;
    try {
      url = (await previews.create(options.port)).url;
    } catch (err) {
      // Already open: a fresh signed link to it.
      if (!(err instanceof Kosa8Error) || err.status !== 409) throw err;
      url = (await previews.link(options.port)).url;
    }
    this.openPorts.add(options.port);
    if (options.protocol === 'ws') url = url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    return { url };
  };

  /** @deprecated Use `getPortEndpoint` instead. */
  getPortUrl = async (options: { port: number; protocol?: 'http' | 'https' | 'ws' }): Promise<string> => {
    return (await this.getPortEndpoint(options)).url;
  };

  setPorts = async (ports: ReadonlyArray<number>, options?: { abortSignal?: AbortSignal }): Promise<void> => {
    const want = new Set(ports);
    for (const p of [...this.openPorts]) {
      options?.abortSignal?.throwIfAborted();
      if (want.has(p)) continue;
      await this.target.box.previews.delete(p).catch((err) => {
        if (!(err instanceof Kosa8NotFoundError)) throw err;
      });
      this.openPorts.delete(p);
    }
    for (const p of want) {
      options?.abortSignal?.throwIfAborted();
      if (!this.openPorts.has(p)) await this.getPortEndpoint({ port: p });
    }
  };

  setNetworkPolicy = async (policy: HarnessV1NetworkPolicy): Promise<void> => {
    const egress = toCloudEgress(policy);
    await this.target.box.setEgress(egress);
    this.target.egress = egress;
  };

  stop = async (): Promise<void> => {
    if (!this.ownsLifecycle || this.stopped || this.destroyed) return;
    const box = this.target.box;
    await box.refresh().catch(() => undefined);
    if (box.state === 'running') await box.sleep();
    this.stopped = true;
  };

  destroy = async (): Promise<void> => {
    if (!this.ownsLifecycle || this.destroyed) return;
    await this.target.box.delete().catch((err) => {
      if (!(err instanceof Kosa8NotFoundError)) throw err;
    });
    this.destroyed = true;
  };
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(bytesOf(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
