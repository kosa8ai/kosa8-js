import * as posix from 'node:path/posix';

/** Quote a string for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Where pid files of running commands are kept inside the work container. */
export const PID_DIR = '/tmp/.kosa8-ai-sdk';

/** Marker file the work container creates, so a resumed session can find it again. */
export const MARKER = '/.kosa8-ai-sdk';

/**
 * The script a command runs under: records its pid (so kill() can reach it,
 * as the native exec endpoint has no kill), enters the working directory,
 * exports the environment and execs the command in a fresh `sh -c`.
 */
export function commandScript(opts: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  tag: string;
}): string {
  const parts = [`mkdir -p ${PID_DIR} 2>/dev/null; echo $$ > ${PID_DIR}/${opts.tag}.pid 2>/dev/null`];
  parts.push(`cd ${shq(opts.cwd)} || exit $?`);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!ENV_KEY.test(k)) throw new Error(`invalid environment variable name ${JSON.stringify(k)}`);
    parts.push(`export ${k}=${shq(v)}`);
  }
  parts.push(`exec sh -c ${shq(opts.command)}`);
  return parts.join('\n');
}

/**
 * Kill a command started under commandScript and every process below it
 * (found through /proc, or `ps` where there is no /proc), TERM first and
 * KILL after a grace period.
 */
export function killScript(tag: string, graceSeconds = 2): string {
  const f = `${PID_DIR}/${tag}.pid`;
  return [
    // The command may not have written its pid file yet.
    `n=0; while [ ! -s ${f} ] && [ $n -lt 30 ]; do sleep 0.1 2>/dev/null || sleep 1; n=$((n+1)); done`,
    `[ -s ${f} ] || exit 0`,
    `p=$(cat ${f})`,
    `tree() { if [ -r /proc/1/stat ]; then for s in /proc/[0-9]*/stat; do read -r c _ _ pp _ < "$s" 2>/dev/null && echo "$c $pp"; done; else ps -A -o pid= -o ppid= 2>/dev/null; fi; }`,
    `desc() { tree | while read -r c pp; do [ "$pp" = "$1" ] && echo "$c" && desc "$c"; done; }`,
    `all="$(desc "$p") $p"`,
    `kill -TERM $all 2>/dev/null`,
    `i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt ${graceSeconds * 10} ]; do sleep 0.1 2>/dev/null || sleep 1; i=$((i+1)); done`,
    `kill -KILL $all 2>/dev/null`,
    `rm -f ${f}`,
    `exit 0`,
  ].join('\n');
}

/** Resolve a sandbox path against the working directory. */
export function resolvePath(p: string, cwd: string): string {
  return posix.resolve(cwd, p);
}

export const ENOENT_MARK = 'KOSA8_AI_SDK_ENOENT';
export const EISDIR_MARK = 'KOSA8_AI_SDK_EISDIR';

/** Exists-and-is-a-file check that tells "missing" apart from other failures. */
export const STAT_SCRIPT = `if [ ! -e "$1" ]; then echo ${ENOENT_MARK} >&2; exit 44; fi
if [ -d "$1" ]; then echo ${EISDIR_MARK} >&2; exit 45; fi
exit 0`;

export const READ_SCRIPT = `${STAT_SCRIPT.replace(/\nexit 0$/, '')}
exec cat -- "$1"`;
