// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * `@kosa8/sdk/cloud`: kosa8 Cloud only, with no Node built-ins, so it
 * bundles for browsers, Cloudflare Workers, Deno and Bun as it is. The
 * package root (`@kosa8/sdk`) exports all of this too, plus the local
 * daemon client (`Kosa8Client`), which needs Node.
 */
export {
  Kosa8Error,
  Kosa8ConnectionError,
  Kosa8TimeoutError,
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
  Kosa8PaymentRequiredError,
  Kosa8RateLimitError,
  Kosa8PlanLimitError,
  Kosa8OrgFrozenError,
  Kosa8ExecTimeoutError,
  Kosa8GitHubNotConnectedError,
  Kosa8GitHubPermissionsError,
  Kosa8NoChangesError,
  Kosa8RepoNotFoundError,
  Kosa8GitHubUnavailableError,
  Kosa8HumanApprovalRequiredError,
  errorFromResponse,
  FAILURE_CLASSES,
  failureOf,
  classifyFailure,
} from './errors.js';
export type { ApprovalRefusal, ApprovalRequirement, ApprovalAction, ApprovalRule, FailureClass, Kosa8LimitOption } from './errors.js';
export { RetryPolicy, NO_RETRY, callWithRetry } from './retry.js';
export { CloudGitHub, REPO_NAME_RE, repoBody } from './cloud-github.js';
export type {
  CloudRepoSpec,
  CloudSandboxRepo,
  CloudGitHubStatus,
  CloudGitHubInstallation,
  CloudGitHubRepo,
  CloudGitHubRepoPage,
  CloudGitHubBranches,
  CloudPushOptions,
  CloudPushResult,
  CloudPullRequestOptions,
  CloudPullRequest,
} from './cloud-github.js';
export { CloudBots, CloudApprovals, MAX_BOT_SENTENCE } from './cloud-bots.js';
export type {
  CloudBot,
  CloudBotState,
  CloudBotList,
  CloudBotSpec,
  CloudBotTrigger,
  CloudBotAction,
  CloudBotPlan,
  CloudBotReplay,
  CloudBotTemplate,
  CloudBotRun,
  CloudBotStep,
  CloudApproval,
  CloudBotSource,
  CloudBotPlanOptions,
  CloudBotCreateOptions,
  CloudBotUpdateOptions,
} from './cloud-bots.js';
export type { RetryPolicyOptions, RetryCallOptions } from './retry.js';
export type * from './types.js';
export {
  Kosa8Cloud,
  CloudSandbox,
  CloudSandboxes,
  CloudSandboxFiles,
  CloudFunctions,
  CloudExecStream,
  EXEC_LIMIT_S,
  DEFAULT_CLOUD_URL,
  CLOUD_KEY_PREFIX,
  MIN_TTL_S,
  MAX_TTL_S,
  MAX_SLEEP_AFTER_S,
  MAX_FORK_N,
  MAX_FORK,
  MAX_BATCH,
  MIN_LEASE_S,
  MAX_LEASE_S,
  CLOUD_TOKEN_PREFIX,
  RUN_LABEL,
  newIdempotencyKey,
} from './cloud.js';
export type {
  Kosa8CloudOptions,
  CloudSandboxInfo,
  CloudCreateOptions,
  CloudUpdateOptions,
  CloudListOptions,
  CloudSandboxPage,
  CloudFileInfo,
  CloudFileReadOptions,
  CloudFileWriteOptions,
  CloudDirectAccess,
  CloudCheckpoint,
  CloudRewindResult,
  CloudPort,
  CloudTemplate,
  CloudExecOptions,
  CloudExecResult,
  CloudExecChunk,
  CloudInvokeResult,
  CloudInvocation,
  CloudFunctionSpec,
  CloudFanoutOptions,
  CloudBatchOptions,
  CloudForkOptions,
  CloudForkProgress,
  CloudFanoutFailure,
  CloudSandboxBatch,
  CloudSelector,
  CloudDrainResult,
  CloudGradeOptions,
  CloudGradeResult,
} from './cloud.js';
export { CLOUD_SIZES, END_REASONS, SMALL_CLOUD_SIZES, SDK_VERSION, USER_AGENT } from './cloud.js';
export type { CloudSize } from './cloud.js';
export {
  CloudBackgroundExec,
  CloudSnapshots,
  CloudPreviews,
  CloudSecrets,
  CloudSchedules,
  CloudCodeContexts,
  CloudPipelines,
  CloudPipelineHooks,
  pipelineRunDone,
} from './cloud-features.js';
export type {
  CloudBackgroundExecInfo,
  CloudWaitOptions,
  CloudFollowOptions,
  CloudSnapshot,
  CloudPreview,
  CloudPreviewOptions,
  CloudEgressPolicy,
  CloudEgress,
  CloudSecret,
  CloudSecretOptions,
  CloudSchedule,
  CloudScheduleOptions,
  CloudScheduleRun,
  CloudCodeResult,
  CloudCodeRun,
  CloudCodeOptions,
  CloudCodeContext,
  CloudPipelineRun,
  CloudPipelineJob,
  CloudPipelineRunOptions,
  CloudPipelineLogs,
  CloudPipelineArtifact,
  CloudPipelineHook,
  CloudPipelineHookOptions,
  CloudMetrics,
  CloudLogEntry,
  CloudTerminal,
  CloudFileLink,
} from './cloud-features.js';
export {
  CloudOrgTemplates,
  CloudBurst,
  CloudTokens,
  CloudEmbeds,
  CloudPreviewDomains,
  CloudRecordings,
} from './cloud-more.js';
export type {
  CloudOrgTemplate,
  CloudOrgTemplateBuildOptions,
  CloudOrgTemplateImportOptions,
  CloudOrgTemplateImport,
  CloudBurstStatus,
  CloudBurstActivation,
  CloudTokenScope,
  CloudCapabilityToken,
  CloudTokenOptions,
  CloudEmbed,
  CloudEmbedOptions,
  CloudDnsRecord,
  CloudPreviewDomain,
  CloudRecording,
  CloudRecordingList,
} from './cloud-more.js';
export { CloudBrowser, CloudBrowsers, CloudAi, BROWSER_PRICE_PER_HOUR_USD } from './cloud-browser.js';
export { CloudApiKeys, CloudWebhooks, CloudAudit, CloudBenchmarks, CloudRl, CloudRlAlerts } from './cloud-org.js';
export type {
  CloudApiKey,
  CloudNewApiKey,
  CloudApiKeyOptions,
  CloudWebhook,
  CloudWebhookDelivery,
  CloudAuditEvent,
  CloudAuditQuery,
  CloudAuditVerify,
  CloudBenchmark,
  CloudBenchmarkInstance,
  CloudRlAlert,
  CloudRlAlertKind,
  CloudRlAlertOptions,
} from './cloud-org.js';
export type {
  CloudBrowserInfo,
  CloudBrowserOptions,
  CloudBrowserPage,
  CloudBrowserPageOptions,
  CloudBrowserList,
  CloudAiSettings,
  CloudAiSettingsValues,
  CloudAiSettingsUpdate,
  CloudAiKey,
  CloudAiUsage,
  CloudAiUsageTotal,
} from './cloud-browser.js';
export { CloudJobs, JOB_DONE_STATES, MAX_JOB_TASKS, jobDone, jobBody, loadJobTasks, encodeJobFiles } from './jobs.js';
export type {
  CloudJob,
  CloudJobStatus,
  CloudJobCmd,
  CloudJobFile,
  CloudJobTask,
  CloudJobCmdSpec,
  CloudJobGraderSpec,
  CloudJobOptions,
  CloudJobEstimate,
  CloudJobEstimateOptions,
  CloudJobListOptions,
  CloudJobWaitOptions,
} from './jobs.js';
export { Kosa8CancelledError, Kosa8ItemTimeoutError } from './forkmap.js';
export type { ForkMapOptions, ForkResult } from './forkmap.js';
export * as rl from './rl/index.js';
export { RlRun, withRun, Lease, lease, mapRollouts, Rollouts, DEFAULT_MASK, DEFAULT_LEASE_S } from './rl/index.js';
export type { RlRunInfo, RlRunOptions, RolloutRow, RolloutFilters, LeaseOptions, RolloutResult, RolloutBase, MapRolloutsOptions } from './rl/index.js';
export { CloudRuns, MAX_RUN_TIMEOUT_S, runFileBytes } from './cloud-run.js';
export type { CloudRun, CloudRunOptions, CloudRunFile } from './cloud-run.js';
