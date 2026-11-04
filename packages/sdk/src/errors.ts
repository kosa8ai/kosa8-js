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

/** kosa8 Cloud refused new work until a payment method is on file (402). */
export class Kosa8PaymentRequiredError extends Kosa8ApiError {}

/** Too many requests or a quota reached (429). */
export class Kosa8RateLimitError extends Kosa8ApiError {}

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
  ctx: { method?: string; path?: string; code?: string } = {},
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
    case 429:
      return new Kosa8RateLimitError(message, opts);
    case 501:
      return new Kosa8UnsupportedError(message, opts);
    default:
      return new Kosa8ApiError(message, opts);
  }
}
