/**
 * Typed errors. Every error the daemon answers with carries its own words:
 * `daemonMessage` is the daemon's `error` field verbatim, and `remediation`
 * is its `remediation` field (what to do about it). A refusal because the
 * org policy wants signed approvals also carries the refusal itself, under
 * `approval`, exactly as the daemon sent it.
 */

/** An approval rule from the org policy, as the daemon reports it. */
export interface ApprovalRule {
  [key: string]: unknown;
}

/** What the policy requires before an action may run. */
export interface ApprovalRequirement {
  policy: string;
  rules: ApprovalRule[];
}

/** The action a refusal is about. */
export interface ApprovalAction {
  kind: string;
  target?: string;
  command?: string[];
  sandbox?: string;
  [key: string]: unknown;
}

/**
 * The daemon's answer to a call the org policy wants signed approvals for
 * and that did not bring a usable one (pkg/approve Refusal).
 */
export interface ApprovalRefusal {
  route: string;
  action: ApprovalAction;
  description: string;
  /** read-only | contained | destructive | escalating */
  class: string;
  policy: string;
  policy_digest: string;
  requirement: ApprovalRequirement;
  /** The approval id the call presented, if any. */
  request_id?: string;
  /** What was wrong: nothing presented, not recorded, used, expired, ... */
  why: string;
  /** People the policy lets approve this action. */
  signers?: string[];
  /** The CLI command that opens a request for exactly this action. */
  request_command: string;
}

export interface Kosa8ErrorOptions {
  status?: number;
  daemonMessage?: string;
  remediation?: string;
  method?: string;
  path?: string;
  body?: unknown;
  cause?: unknown;
  /** kosa8 Cloud's stable error code, such as payment_required. */
  code?: string;
  /** Seconds from a Retry-After header, when the answer had one. */
  retryAfter?: number;
  /** The request's id (X-Request-Id, else Cloudflare's cf-ray), to quote to kosa8 support. */
  requestId?: string;
}

/**
 * Whose fault a failure was, as kosa8 Cloud says on every answer under
 * /v1/sandboxes: `ok`, `exit_nonzero` (the command ran and failed),
 * `timeout`, `infra` (a host failed, was not ready or had no room: mask it
 * in a training loop rather than scoring it 0), `quota` (plan, running,
 * payment or spending-cap limits) and `client` (the request was wrong).
 * `error` is the SDK's own: an exception that is not a kosa8 error (a bug
 * in your code).
 */
export const FAILURE_CLASSES = ['ok', 'exit_nonzero', 'timeout', 'oom', 'infra', 'quota', 'client', 'error'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

const INFRA_CODES = new Set([
  'host_failed', 'not_ready', 'no_capacity', 'host_unreachable', 'host_unavailable', 'host_busy', 'host_restarting',
  'wake_failed', 'try_again', 'internal', 'kernel_failed', 'egress_failed', 'dns_unreachable', 'host_lost', 'host_removed',
  'insufficient_storage', 'starting',
]);
const RATE_CODES = new Set(['rate_limited', 'slow_down', 'too_soon']);
const QUOTA_CODES = new Set([
  'quota_exceeded', 'running_limit', 'plan_required', 'plan_limit', 'plan_feature', 'payment_required', 'payment_declined',
  'spending_cap_reached', 'snapshot_limit', 'org_frozen', 'org_suspended', 'too_many_runs',
]);

/**
 * `{ failureClass, retryable }` for an HTTP status and a kosa8 Cloud error
 * code, the server's own rules (workers/cloud-api failures.js).
 */
export function failureOf(status: number, code?: string | null): { failureClass: FailureClass; retryable: boolean } {
  const c = typeof code === 'string' ? code : '';
  if (status < 400) return { failureClass: 'ok', retryable: false };
  if (c === 'exec_timeout') return { failureClass: 'timeout', retryable: false };
  if (/timeout/.test(c)) return { failureClass: 'timeout', retryable: true };
  if (RATE_CODES.has(c)) return { failureClass: 'quota', retryable: true };
  if (QUOTA_CODES.has(c) || status === 402 || status === 423) return { failureClass: 'quota', retryable: false };
  if (status === 429) return { failureClass: 'quota', retryable: c !== 'quota_exceeded' };
  if (c === 'not_available' || c === 'not_supported' || status === 501) return { failureClass: 'infra', retryable: false };
  if (INFRA_CODES.has(c) || status >= 500) return { failureClass: 'infra', retryable: true };
  return { failureClass: 'client', retryable: false };
}

/**
 * `{ failureClass, retryable }` for anything thrown. A kosa8 Cloud answer's
 * own `failure_class` and `retryable` are used as sent; otherwise no answer
 * (a connection error or a request timeout) is retryable `infra`, an exec
 * past its limit is `timeout`, and an HTTP error is classed by status and
 * code as the server does. Anything that is not a kosa8 error is `error`
 * (not retryable): a bug in your code.
 */
export function classifyFailure(e: unknown): { failureClass: FailureClass; retryable: boolean } {
  if (!(e instanceof Kosa8Error)) return { failureClass: 'error', retryable: false };
  const b = e.body;
  if (typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).failure_class === 'string') {
    const fc = (b as Record<string, unknown>).failure_class as FailureClass;
    const rt = (b as Record<string, unknown>).retryable;
    return { failureClass: fc, retryable: typeof rt === 'boolean' ? rt : fc === 'infra' };
  }
  if (e instanceof Kosa8ExecTimeoutError) return { failureClass: 'timeout', retryable: false };
  if (e instanceof Kosa8ConnectionError) return { failureClass: 'infra', retryable: true };
  if (e.status !== undefined) return failureOf(e.status, e.code);
  return { failureClass: 'error', retryable: false };
}

/** Base class of every error this SDK throws. */
export class Kosa8Error extends Error {
  /** HTTP status the daemon answered with, when there was an answer. */
  readonly status?: number;
  /** The daemon's `error` text, verbatim. */
  readonly daemonMessage?: string;
  /** The daemon's `remediation` text: what to do about it. */
  readonly remediation?: string;
  readonly method?: string;
  readonly path?: string;
  /** The decoded response body, when there was one. */
  readonly body?: unknown;
  /** kosa8 Cloud's stable error code (payment_required, quota_exceeded, ...). */
  readonly code?: string;
  /** Seconds to wait before trying again, from a Retry-After header or `retry_after_s`; undefined when none. */
  readonly retryAfter?: number;
  /** The request's id (kosa8 Cloud's X-Request-Id, else Cloudflare's cf-ray header); quote it to kosa8 support. */
  readonly requestId?: string;

  constructor(message: string, options: Kosa8ErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = options.status;
    this.daemonMessage = options.daemonMessage;
    this.remediation = options.remediation;
    this.method = options.method;
    this.path = options.path;
    this.body = options.body;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
    this.requestId = options.requestId;
  }

  /** Same as `retryAfter`: seconds to wait before trying again, from Retry-After or the body's `retry_after_s`. */
  get retryAfterS(): number | undefined {
    return this.retryAfter;
  }

  /**
   * Whose fault it was: `timeout`, `infra`, `quota`, `client` (kosa8 Cloud's
   * `failure_class` when the answer had one), or `error` for a failure that
   * is not the API's. See `classifyFailure`.
   */
  get failureClass(): FailureClass {
    return classifyFailure(this).failureClass;
  }

  /** Whether the same call may work if sent again (kosa8 Cloud's `retryable` when the answer had one). */
  get retryable(): boolean {
    return classifyFailure(this).retryable;
  }
}

/** The daemon could not be reached (no socket, connection refused, ...). */
export class Kosa8ConnectionError extends Kosa8Error {}

/**
 * A call took longer than its timeout. A connection error too, so code that
 * catches Kosa8ConnectionError keeps catching it.
 */
export class Kosa8TimeoutError extends Kosa8ConnectionError {}

/** The daemon answered with an HTTP error. */
export class Kosa8ApiError extends Kosa8Error {}

/** 400: the request was malformed or a value was refused (an egress policy, say). */
export class Kosa8BadRequestError extends Kosa8ApiError {}

/** 401: a bearer token (remote worker) or agent token was missing or refused. */
export class Kosa8AuthError extends Kosa8ApiError {}

/** 403: refused by policy (org policy, registry allow-list, labels, ...). */
export class Kosa8PolicyError extends Kosa8ApiError {}

/**
 * 403 with a signed-approval refusal: the org policy wants people other than
 * the caller to approve this exact action. Get the approval id from a human
 * and repeat the call with `{ approval: id }`.
 */
export class Kosa8ApprovalRequiredError extends Kosa8PolicyError {
  readonly approval: ApprovalRefusal;
  constructor(message: string, approval: ApprovalRefusal, options: Kosa8ErrorOptions = {}) {
    super(message, options);
    this.approval = approval;
  }
}

/** 404: no such sandbox, snapshot, container, ... */
export class Kosa8NotFoundError extends Kosa8ApiError {}

/** 409: a conflict, e.g. the sandbox exists but is not running, or a snapshot id is taken. */
export class Kosa8ConflictError extends Kosa8ApiError {}

/** 501: the platform cannot do this (sandboxes need macOS on Apple silicon or Linux with KVM). */
export class Kosa8UnsupportedError extends Kosa8ApiError {}

/**
 * A streamed operation (run, exec, attach) ended with an error frame rather
 * than an exit code. Output produced before the error is kept.
 */
export class Kosa8StreamError extends Kosa8Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, out: { stdout: string; stderr: string }, options: Kosa8ErrorOptions = {}) {
    super(message, options);
    this.stdout = out.stdout;
    this.stderr = out.stderr;
  }
}

function bodyString(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * kosa8 Cloud refused new work until it is paid for (402). `code` says why:
 * payment_required, spending_cap_reached, price_not_accepted, ...
 */
export class Kosa8PaymentRequiredError extends Kosa8ApiError {
  /** Where the person adds a payment method or credit; null when the answer had none. */
  get upgradeUrl(): string | null {
    return bodyString(this.body, 'upgrade_url');
  }

  /** A sentence an AI agent should relay to its person word for word; null when absent. */
  get agentMessage(): string | null {
    return bodyString(this.body, 'agent_message');
  }
}

/** Too many requests or a quota reached (429). */
export class Kosa8RateLimitError extends Kosa8ApiError {}

/**
 * 423 org_frozen: the organization is frozen in the kosa8 Cloud Security
 * Center. An owner or admin must unfreeze it before new work runs.
 */
export class Kosa8OrgFrozenError extends Kosa8ApiError {}

/**
 * A buffered kosa8 Cloud exec ran past the API's limit (90 s).
 * Raised for HTTP 504, for code exec_timeout, and for a 502 host_failed on
 * /exec that says it timed out. Run long jobs in the background instead
 * (`nohup cmd > /workspace/out.log 2>&1 &`) and poll for the result.
 */
export class Kosa8ExecTimeoutError extends Kosa8ApiError {}

/** A client-side checkpoint operation failed (no checkpoint, bad name, ...). */
export class Kosa8CheckpointError extends Kosa8Error {}

function isRefusal(v: unknown): v is ApprovalRefusal {
  return typeof v === 'object' && v !== null && typeof (v as { why?: unknown }).why === 'string';
}

/**
 * Build the typed error for an HTTP error answer. The message is the daemon's
 * own, with its remediation in parentheses, the way the kosa8 CLI and MCP
 * server print it.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  ctx: { method?: string; path?: string; code?: string; body?: unknown; retryAfter?: number; requestId?: string } = {},
): Kosa8ApiError {
  let daemonMessage: string | undefined;
  let remediation: string | undefined;
  let approval: unknown;
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string' && b.error !== '') daemonMessage = b.error;
    else if (typeof b.message === 'string' && b.message !== '') daemonMessage = b.message;
    if (typeof b.remediation === 'string' && b.remediation !== '') remediation = b.remediation;
    approval = b.approval;
  } else if (typeof body === 'string' && body.trim() !== '') {
    daemonMessage = body.trim();
  }
  const base = daemonMessage ?? `request failed with HTTP ${status}`;
  const message = remediation ? `${base} (${remediation})` : base;
  const opts: Kosa8ErrorOptions = { status, daemonMessage, remediation, body, ...ctx };
  if (status === 403 && isRefusal(approval)) {
    return new Kosa8ApprovalRequiredError(message, approval, opts);
  }
  switch (status) {
    case 400:
      return new Kosa8BadRequestError(message, opts);
    case 401:
      return new Kosa8AuthError(message, opts);
    case 403:
      return new Kosa8PolicyError(message, opts);
    case 404:
      return new Kosa8NotFoundError(message, opts);
    case 402:
      return new Kosa8PaymentRequiredError(message, opts);
    case 409:
      return new Kosa8ConflictError(message, opts);
    case 423:
      return new Kosa8OrgFrozenError(message, opts);
    case 429:
      return new Kosa8RateLimitError(message, opts);
    case 501:
      return new Kosa8UnsupportedError(message, opts);
    default:
      return new Kosa8ApiError(message, opts);
  }
}
