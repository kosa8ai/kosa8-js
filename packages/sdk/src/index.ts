export { Kosa8Client, SandboxHandle } from './client.js';
export type {
  CallOptions,
  Kosa8ClientOptions,
  CreateSandboxOptions,
  RunOptions,
  ExecOptions,
  ForkOptions,
  ExploreOptions,
  CheckpointOptions,
  CheckpointResult,
  RewindOptions,
  RewindResult,
  RestoreOptions,
} from './client.js';
export {
  Transport,
  resolveEndpoint,
  defaultSocketPath,
  APPROVAL_HEADER,
  ACTOR_HEADER,
  AGENT_TOKEN_HEADER,
} from './transport.js';
export type { Actor, TransportOptions, RequestOptions } from './transport.js';
export {
  CheckpointBook,
  FileCheckpointStore,
  MemoryCheckpointStore,
  MAX_CHECKPOINTS_PER_SANDBOX,
  validateSandboxName,
} from './checkpoints.js';
export type { CheckpointStore } from './checkpoints.js';
export {
  Kosa8Error,
  Kosa8ConnectionError,
  Kosa8ApiError,
  Kosa8BadRequestError,
  Kosa8AuthError,
  Kosa8PolicyError,
  Kosa8ApprovalRequiredError,
  Kosa8NotFoundError,
  Kosa8ConflictError,
  Kosa8UnsupportedError,
  Kosa8StreamError,
  Kosa8CheckpointError,
  errorFromResponse,
} from './errors.js';
export type { ApprovalRefusal, ApprovalRequirement, ApprovalAction, ApprovalRule } from './errors.js';
export type * from './types.js';
