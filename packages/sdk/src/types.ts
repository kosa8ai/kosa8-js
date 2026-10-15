/**
 * Shapes of the kosa8 native API (/kosa8/v1), taken from the daemon's Go
 * source (pkg/apid/native, pkg/sandbox, pkg/engine, pkg/vnet). Field names
 * are the daemon's JSON names, unchanged.
 */

/** GET /kosa8/v1/health */
export interface Health {
  status: string;
  version: string;
  commit: string;
  go: string;
  uptime_seconds: number;
  phase: string;
}

/** A host directory exposed inside a sandbox (pkg/sandbox Mount). */
export interface Mount {
  host_path: string;
  guest_path: string;
  read_only: boolean;
}

/**
 * Egress policy string the daemon accepts (pkg/vnet ParsePolicy):
 * `any`, `deny`, `fakenet`, or `allow:HOST[,HOST...]` where each entry is a
 * hostname, a `*.domain` wildcard, an IPv4 address or an IPv4 CIDR.
 */
export type EgressPolicyString = 'any' | 'deny' | 'fakenet' | `allow:${string}`;

/**
 * Egress policy as this SDK takes it: one of the daemon's strings, or
 * `{ allow: [...] }` for an allow-list (everything else is refused on the host).
 */
export type EgressPolicy = EgressPolicyString | { allow: readonly string[] };

/** A host the sandbox may reach through an egress broker (pkg/broker HostRule). */
export interface BrokerHostRule {
  /** Exact DNS name, a `*.domain` wildcard, or a literal IPv4 address. */
  host: string;
  /** Ports the host may be reached on. Empty means 443 and 80. */
  ports?: number[];
  /** Methods allowed for plain-HTTP requests. Empty means any. */
  methods?: string[];
}

/** A credentialed upstream behind the broker (pkg/sandbox BrokerRoute). */
export interface BrokerRoute {
  name: string;
  upstream: string;
  methods?: string[];
  paths?: string[];
  /** Header the broker sets on the way out, e.g. `Authorization` or `x-api-key`. */
  header: string;
  scheme?: string;
  /** The real credential. Held by the broker on the host, never by the sandbox. */
  secret: string;
}

/** Puts a sandbox behind an egress broker (pkg/sandbox BrokerSpec). */
export interface BrokerSpec {
  allow?: BrokerHostRule[];
  routes?: BrokerRoute[];
}

/** The broker as a running sandbox reports it (pkg/sandbox BrokerInfo). */
export interface BrokerInfo {
  url: string;
  hosts?: string[];
  routes?: string[];
}

/** Packet capture to a pcapng file on the host (pkg/sandbox CaptureSpec). */
export interface CaptureSpec {
  /** Absolute path on the host. */
  path: string;
  max_bytes?: number;
  max_files?: number;
}

/** A sandbox (pkg/sandbox Sandbox). */
export interface Sandbox {
  id: string;
  name: string;
  created: string;
  /** running | paused | stopped */
  state: string;
  parent?: string;
  cpus: number;
  mem_mb: number;
  disk_gb?: number;
  mounts?: Mount[];
  egress?: string;
  capture?: string;
  ip?: string;
  labels?: Record<string, string>;
  broker?: BrokerInfo;
}

/** A saved sandbox state (pkg/sandbox Snapshot). */
export interface Snapshot {
  id: string;
  sandbox: string;
  created: string;
  machine_id?: string;
  mac?: string;
  cpus: number;
  mem_mb: number;
  cmdline: string;
  size_bytes: number;
  state_path: string;
  disk_path?: string;
  data_path?: string;
  disk_gb?: number;
  ephemeral?: boolean;
  mounts?: Mount[];
  egress?: string;
  received?: boolean;
  received_mounts?: string[];
  sealed?: boolean;
  labels?: Record<string, string>;
  encryption?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A container inside an engine (pkg/engine Container). */
export interface Container {
  id: string;
  image: string;
  status: string;
  exit?: number;
  ip?: string;
}

/** POST /kosa8/v1/sandboxes answer. */
export interface CreateSandboxResult {
  sandbox: Sandbox;
  boot_ms: number;
  /** Present when the sandbox was created behind a broker: the stand-ins the sandbox holds. */
  broker?: { url: string; placeholders: Record<string, string> };
}

/** POST /kosa8/v1/sandboxes/{id}/up answer. */
export interface StartSandboxResult {
  sandbox: Sandbox;
  boot_ms: number;
  warning?: string;
}

/** POST /kosa8/v1/sandboxes/{id}/down answer. */
export interface StopSandboxResult {
  ok: boolean;
  sandbox?: Sandbox;
  warning?: string;
  already_stopped?: boolean;
}

/** DELETE /kosa8/v1/sandboxes/{id} answer. */
export interface DeleteSandboxResult {
  ok: boolean;
  wipe?: unknown;
  files?: unknown;
}

/** POST /kosa8/v1/sandboxes/{id}/snapshot answer. */
export interface SnapshotSandboxResult {
  snapshot: Snapshot;
  snapshot_ms: number;
  encrypted_by_policy?: string;
  encrypt_ms?: number;
  encryption?: unknown;
}

/** POST /kosa8/v1/sandboxes/{id}/fork answer. */
export interface ForkResult {
  forks: Sandbox[];
  /** The (ephemeral) snapshot the forks were restored from. */
  snapshot: string;
  fork_ms: number;
  count: number;
  encrypted_by_policy?: string;
  encrypt_ms?: number;
}

/** POST /kosa8/v1/snapshots/{id}/restore answer. */
export interface RestoreResult {
  sandbox: Sandbox;
  restore_ms: number;
  seal?: unknown;
}

/** DELETE /kosa8/v1/snapshots/{id} answer. */
export interface DeleteSnapshotResult {
  ok: boolean;
  removed: string;
  encrypted: boolean;
  shred?: unknown;
  wipe?: unknown;
  files?: unknown;
}

/** GET /kosa8/v1/sandboxes/{id}/egress answer (pkg/sandbox EgressStatus). */
export interface EgressStatus {
  policy: string;
  stats: {
    passed: number;
    denied: number;
    dropped: number;
    dns_answered: number;
    dns_refused: number;
    fakenet?: number;
  };
  capture?: string;
  wildcards?: { wildcard: string; names?: string[]; more?: number }[];
  fakenet?: { interactions: number; dropped?: number; ca?: string; log?: string };
}

/** One frame of a streamed answer (pkg/engine Frame), with `data` decoded. */
export interface Frame {
  /** stdout | stderr | status */
  stream?: string;
  data?: Buffer;
  done?: boolean;
  ok?: boolean;
  error?: string;
  exit?: number;
  id?: string;
  image?: string;
  [key: string]: unknown;
}

/** The collected result of a streamed run or exec. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: Buffer;
  stderrBytes: Buffer;
}

/** A client-side restore point (same record as `kosa8 checkpoint`, pkg/checkpoint). */
export interface Checkpoint {
  /** The underlying snapshot id, e.g. `web-ckpt-3`. */
  id: string;
  sandbox: string;
  label: string;
  auto?: boolean;
  /** RFC 3339 time it was taken. */
  created: string;
}

/** One branch of an explore. */
export interface ExploreBranch {
  /** The forked sandbox's id. */
  name: string;
  variant: string;
  exit: number;
  output: string;
  duration_ms: number;
  error?: string;
}

export interface ExploreResult {
  parent: string;
  branches: ExploreBranch[];
  /** The fastest successful branch, or "" when every branch failed. */
  winner: string;
  removed: number;
}
