// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * GitHub repos: the org connects the kosa8 GitHub App once, then a sandbox or
 * a run starts from a repo (`repo` on create and run) and sends changes back
 * (`box.push()`, `box.pullRequest()`). kosa8 mints a GitHub token for one
 * repo, for one operation, that expires within an hour; it never enters the
 * sandbox, is never returned and every use is audited.
 */

import { Kosa8Error } from './errors.js';

type Json = Record<string, unknown>;

/** @internal What the GitHub calls need from `Kosa8Cloud`. */
export interface GitHubRequester {
  request<T = Json>(method: string, path: string, body?: unknown): Promise<T>;
}

/** owner/name, as GitHub allows them. */
export const REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * A repo to start from: `"owner/name"`, `"owner/name@ref"` (a branch, tag or
 * commit), or `{ name, ref?, path?, depth? }`. It is cloned into `path`
 * (default `/workspace/<name>`); a run's command runs there.
 */
export type CloudRepoSpec =
  | string
  | {
      /** owner/name. */
      name: string;
      /** A branch, tag or commit sha. Default: the repo's default branch. */
      ref?: string;
      /** Where to clone it. Default /workspace/<name>. */
      path?: string;
      /** Clone depth. Default 1. */
      depth?: number;
    };

/** The repo a sandbox was started from (`sandbox.repo` / `box.repo()`). */
export interface CloudSandboxRepo {
  full_name: string;
  ref?: string | null;
  sha?: string | null;
  path: string;
  /** cloned, pending (a cold boot: it clones once the sandbox is ready) or failed. */
  status: 'cloned' | 'pending' | 'failed' | (string & {});
  error?: string | null;
  /** `box.repo()` only: what changed since the clone. */
  changes?: { files_changed?: number; insertions?: number; deletions?: number; [k: string]: unknown };
  [k: string]: unknown;
}

/** One installation of the kosa8 GitHub App linked to the org. */
export interface CloudGitHubInstallation {
  installation_id: number;
  account_login: string;
  account_type: 'User' | 'Organization' | (string & {});
  repository_selection: 'all' | 'selected' | (string & {});
  repo_count?: number;
  /** Where on GitHub to pick repos or approve new permissions. */
  manage_url: string;
  /** Permissions the installation lacks (contents:write, pull_requests:write, metadata:read); [] when none. */
  missing_permissions: string[];
  [k: string]: unknown;
}

/** `cloud.github.status()`: is GitHub connected, and where to connect it. */
export interface CloudGitHubStatus {
  configured: boolean;
  connected: boolean;
  /** Whether this key may connect or disconnect GitHub (an admin's). */
  can_manage: boolean;
  /** Where to install the kosa8 GitHub App (admins only); null otherwise. */
  install_url: string | null;
  installations: CloudGitHubInstallation[];
  [k: string]: unknown;
}

/** A repo the org's installations can see. */
export interface CloudGitHubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description?: string | null;
  pushed_at?: string | null;
  html_url: string;
  installation_id: number;
  language?: string | null;
  [k: string]: unknown;
}

/** One page of `cloud.github.reposPage()`. */
export interface CloudGitHubRepoPage {
  repos: CloudGitHubRepo[];
  /** The next page number; null on the last page. */
  next_page: number | null;
}

/** A repo's branches (the first 100). */
export interface CloudGitHubBranches {
  default_branch: string;
  branches: Array<{ name: string; sha: string; protected: boolean }>;
}

/** `box.push()` options. */
export interface CloudPushOptions {
  /** Default kosa8/<sandbox-short-id>. */
  branch?: string;
  /** The commit message. Default "Changes from kosa8 sandbox <id>". */
  message?: string;
  /** The checkout in the sandbox. Default the one it was started from. */
  path?: string;
}

/** What `box.push()` pushed. */
export interface CloudPushResult {
  branch: string;
  sha: string;
  compare_url: string;
  files_changed: number;
  [k: string]: unknown;
}

/** `box.pullRequest()` options. */
export interface CloudPullRequestOptions {
  title?: string;
  body?: string;
  /** The branch to merge into. Default the repo's default branch. */
  base?: string;
  /** The branch to push. Default kosa8/<sandbox-short-id>. */
  branch?: string;
  /** Default true. */
  draft?: boolean;
}

/** The pull request `box.pullRequest()` opened. */
export interface CloudPullRequest {
  number: number;
  url: string;
  branch: string;
  sha: string;
  [k: string]: unknown;
}

function checkRepoName(name: unknown): string {
  if (typeof name !== 'string' || !REPO_NAME_RE.test(name)) {
    throw new Kosa8Error(`repo must be owner/name (optionally @ref), got ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * The `repo` field of a create or run, checked: a string stays a string
 * ("owner/name" or "owner/name@ref"), an object is sent as `{ name, ref?, path?, depth? }`.
 */
export function repoBody(spec: CloudRepoSpec): string | Json {
  if (typeof spec === 'string') {
    const at = spec.indexOf('@');
    checkRepoName(at < 0 ? spec : spec.slice(0, at));
    if (at >= 0 && at === spec.length - 1) throw new Kosa8Error(`repo ${spec} has an empty ref after @`);
    return spec;
  }
  if (typeof spec !== 'object' || spec === null) throw new Kosa8Error('repo must be "owner/name[@ref]" or { name, ref?, path?, depth? }');
  const out: Json = { name: checkRepoName(spec.name) };
  if (spec.ref !== undefined) out.ref = spec.ref;
  if (spec.path !== undefined) out.path = spec.path;
  if (spec.depth !== undefined) {
    if (!Number.isInteger(spec.depth) || spec.depth < 1) throw new Kosa8Error(`repo depth must be a whole number from 1, got ${spec.depth}`);
    out.depth = spec.depth;
  }
  return out;
}

function repoPath(repo: string): string {
  const [owner, name] = checkRepoName(repo).split('/') as [string, string];
  return `/v1/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/**
 * `cloud.github`: the org's connected GitHub. Connecting and disconnecting
 * is done once by an admin (app.kosa8.com Settings, or `kosa8 github connect`);
 * listing repos needs only the normal sandbox scope.
 */
export class CloudGitHub {
  constructor(private readonly cloud: GitHubRequester) {}

  /** Whether GitHub is connected, the installations, and (admins) where to install the app. */
  status(): Promise<CloudGitHubStatus> {
    return this.cloud.request<CloudGitHubStatus>('GET', '/v1/github');
  }

  /** Repos the org's installations can see, most recently pushed first; `query` filters by substring. */
  async repos(query?: string | { query?: string; page?: number }): Promise<CloudGitHubRepo[]> {
    return (await this.reposPage(query)).repos;
  }

  /** One page of `repos`, with `next_page`. */
  async reposPage(query?: string | { query?: string; page?: number }): Promise<CloudGitHubRepoPage> {
    const o = typeof query === 'string' ? { query } : (query ?? {});
    const q = new URLSearchParams();
    if (o.query) q.set('q', o.query);
    if (o.page !== undefined) q.set('page', String(o.page));
    const s = q.toString();
    const r = await this.cloud.request<Partial<CloudGitHubRepoPage>>('GET', `/v1/github/repos${s ? `?${s}` : ''}`);
    return { repos: r.repos ?? [], next_page: r.next_page ?? null };
  }

  /** A repo's branches (owner/name), the first 100, and its default branch. */
  branches(repo: string): Promise<CloudGitHubBranches> {
    return this.cloud.request<CloudGitHubBranches>('GET', `${repoPath(repo)}/branches`);
  }
}

/** @internal `box.repo()`. */
export async function sandboxRepo(cloud: GitHubRequester, id: string): Promise<CloudSandboxRepo> {
  const r = await cloud.request<{ repo?: CloudSandboxRepo } & Json>('GET', `/v1/sandboxes/${encodeURIComponent(id)}/repo`);
  return (r.repo ?? r) as CloudSandboxRepo;
}

/** @internal `box.push()`. */
export function pushBody(opts: CloudPushOptions): Json {
  const b: Json = {};
  if (opts.branch !== undefined) b.branch = opts.branch;
  if (opts.message !== undefined) b.message = opts.message;
  if (opts.path !== undefined) b.path = opts.path;
  return b;
}

/** @internal `box.pullRequest()`. */
export function pullRequestBody(opts: CloudPullRequestOptions): Json {
  const b: Json = {};
  for (const k of ['title', 'body', 'base', 'branch', 'draft'] as const) if (opts[k] !== undefined) b[k] = opts[k];
  return b;
}
