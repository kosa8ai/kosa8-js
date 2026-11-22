// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * kosa8 for RL training: thousands of agent rollouts that do not leak
 * sandboxes, grade in sealed copies, mask infra failures, and show up on
 * app.kosa8.com (RL runs).
 *
 * ```ts
 * import { Kosa8Cloud, rl } from '@kosa8/sdk';
 *
 * const cloud = new Kosa8Cloud();
 * await rl.withRun(cloud, { name: 'my-grpo-run' }, async (run) => {
 *   const base = await cloud.sandboxes.create({ template: 'python' });
 *   const results = await run.map(base, tasks, solve, { gradeCmd: ['python', '/grader/test.py'] });
 *   console.log(results.meanReward, results.byClass);
 * });
 * ```
 *
 * - `RlRun` (also `rl.Run`): a recorded run; `map` runs one step.
 * - `mapRollouts`: the rollout engine on its own.
 * - `lease` / `Lease`: heartbeats while you run, drain when you stop.
 */

export { RlRun, RlRun as Run, withRun, MAX_ROWS_PER_CALL, RUN_STATUSES } from './run.js';
export type { RlRunInfo, RlRunOptions, RolloutRow, RolloutFilters } from './run.js';
export { Lease, lease, DEFAULT_LEASE_S } from './lease.js';
export type { LeaseOptions } from './lease.js';
export { mapRollouts, Rollouts, rolloutRow, DEFAULT_MASK, STDOUT_TAIL } from './rollouts.js';
export type { RolloutResult, RolloutBase, MapRolloutsOptions } from './rollouts.js';
export { FAILURE_CLASSES, classifyFailure } from '../errors.js';
export { RUN_LABEL } from '../cloud.js';
