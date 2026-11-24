import { describe, expect, it } from 'vitest';
import {
  Kosa8Cloud,
  Kosa8ConflictError,
  Kosa8GitHubNotConnectedError,
  Kosa8GitHubPermissionsError,
  Kosa8GitHubUnavailableError,
  Kosa8NoChangesError,
  Kosa8NotFoundError,
  Kosa8RepoNotFoundError,
} from '../src/index.js';

const KEY = 'k8c_live_testkey';

interface Seen { url: URL; method: string; body: unknown }

function cloudWith(answer: (s: Seen) => [number, unknown]) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s: Seen = { url: new URL(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    const [status, out] = answer(s);
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { cloud: new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f, retry: false }), seen };
}

const running = (extra: Record<string, unknown> = {}) => ({
  id: 'sb_abc', state: 'running', template: 'base', cpus: 2, mem_mb: 4096, source: 'pool', region: 'us-ash1', own_host: false,
  created_at: 1, started_at: 1, stopped_at: null, deleted_at: null, last_error: null, running_s: 0, asleep_s: 0, cost_usd: 0, ...extra,
});

describe('cloud.github', () => {
  it('status, repos (query and page) and branches call the contract paths', async () => {
    const { cloud, seen } = cloudWith((s) => {
      if (s.url.pathname === '/v1/github') return [200, { configured: true, connected: true, can_manage: false, install_url: null, installations: [] }];
      if (s.url.pathname === '/v1/github/repos') return [200, { repos: [{ full_name: 'acme/api', private: true, default_branch: 'main', html_url: 'https://github.com/acme/api', installation_id: 7 }], next_page: 2 }];
      return [200, { default_branch: 'main', branches: [{ name: 'main', sha: 'abc', protected: true }] }];
    });
    expect((await cloud.github.status()).connected).toBe(true);
    const repos = await cloud.github.repos('api');
    expect(repos[0]!.full_name).toBe('acme/api');
    const page = await cloud.github.reposPage({ query: 'x', page: 2 });
    expect(page.next_page).toBe(2);
    const br = await cloud.github.branches('acme/api');
    expect(br.branches[0]!.protected).toBe(true);
    expect(seen.map((s) => `${s.method} ${s.url.pathname}${s.url.search}`)).toEqual([
      'GET /v1/github',
      'GET /v1/github/repos?q=api',
      'GET /v1/github/repos?q=x&page=2',
      'GET /v1/github/repos/acme/api/branches',
    ]);
  });

  it('refuses a repo name that is not owner/name before any request', async () => {
    const { cloud, seen } = cloudWith(() => [200, {}]);
    expect(() => cloud.github.branches('acme')).toThrow(/owner\/name/);
    await expect(cloud.sandboxes.create({ repo: 'not a repo' })).rejects.toThrow(/owner\/name/);
    await expect(cloud.sandboxes.create({ repo: 'acme/api@' })).rejects.toThrow(/empty ref/);
    await expect(cloud.run({ command: 'ls', repo: { name: 'acme/api', depth: 0 } })).rejects.toThrow(/depth/);
    expect(seen).toHaveLength(0);
  });
});

describe('repo on create and run', () => {
  it('sends repo as given: a string stays a string, an object in the API spelling', async () => {
    const repo = { full_name: 'acme/api', ref: 'main', sha: 'abc', path: '/workspace/api', status: 'cloned' };
    const { cloud, seen } = cloudWith((s) => (s.url.pathname === '/v1/run' ? [200, { run: { id: 'sr_1', status: 'ok', exit: 0, repo } }] : [200, { sandbox: running({ repo }) }]));
    const box = await cloud.sandboxes.create({ repo: 'acme/api@main' });
    expect(box.info.repo!.status).toBe('cloned');
    expect((seen[0]!.body as Record<string, unknown>).repo).toBe('acme/api@main');
    await cloud.sandboxes.create({ repo: { name: 'acme/api', ref: 'v1.2', path: '/workspace/x', depth: 5 } });
    expect((seen[1]!.body as Record<string, unknown>).repo).toEqual({ name: 'acme/api', ref: 'v1.2', path: '/workspace/x', depth: 5 });
    const r = await cloud.run({ command: 'npm test', repo: 'acme/api' });
    expect(r.repo!.full_name).toBe('acme/api');
    expect(seen[2]!.body).toEqual({ command: 'npm test', repo: 'acme/api' });
  });
});

describe('box.repo, box.push, box.pullRequest', () => {
  it('call the sandbox paths with only the options given', async () => {
    const { cloud, seen } = cloudWith((s) => {
      if (s.url.pathname.endsWith('/repo')) return [200, { repo: { full_name: 'acme/api', path: '/workspace/api', status: 'cloned', changes: { files_changed: 2 } } }];
      if (s.url.pathname.endsWith('/github/push')) return [200, { branch: 'kosa8/abc', sha: 'def', compare_url: 'https://github.com/acme/api/compare/kosa8/abc', files_changed: 2 }];
      if (s.url.pathname.endsWith('/github/pull-request')) return [200, { number: 12, url: 'https://github.com/acme/api/pull/12', branch: 'fix', sha: 'def' }];
      return [200, { sandbox: running() }];
    });
    const box = await cloud.sandboxes.get('sb_abc');
    expect((await box.repo()).changes!.files_changed).toBe(2);
    expect(box.info.repo!.full_name).toBe('acme/api');
    expect((await box.push()).branch).toBe('kosa8/abc');
    expect((await box.push({ branch: 'fix', message: 'm' })).sha).toBe('def');
    const pr = await box.pullRequest({ title: 'Fix', base: 'main', draft: false });
    expect(pr.number).toBe(12);
    const calls = seen.slice(1).map((s) => [`${s.method} ${s.url.pathname}`, s.body]);
    expect(calls).toEqual([
      ['GET /v1/sandboxes/sb_abc/repo', undefined],
      ['POST /v1/sandboxes/sb_abc/github/push', {}],
      ['POST /v1/sandboxes/sb_abc/github/push', { branch: 'fix', message: 'm' }],
      ['POST /v1/sandboxes/sb_abc/github/pull-request', { title: 'Fix', base: 'main', draft: false }],
    ]);
  });
});

describe('GitHub errors', () => {
  const box = async (status: number, body: unknown) => {
    const { cloud } = cloudWith((s) => (s.method === 'GET' ? [200, { sandbox: running() }] : [status, body]));
    const b = await cloud.sandboxes.get('sb_abc');
    return b.pullRequest().then(() => null, (e: unknown) => e);
  };

  it('github_not_connected carries connectUrl and is still a conflict', async () => {
    const e = await box(409, { error: 'github_not_connected', message: 'Connect GitHub first.', connect_url: 'https://app.kosa8.com/app#settings/github' });
    expect(e).toBeInstanceOf(Kosa8GitHubNotConnectedError);
    expect(e).toBeInstanceOf(Kosa8ConflictError);
    expect((e as Kosa8GitHubNotConnectedError).connectUrl).toBe('https://app.kosa8.com/app#settings/github');
  });

  it('github_permissions carries missing and settingsUrl', async () => {
    const e = (await box(409, { error: 'github_permissions', message: 'Approve.', missing: ['pull_requests:write'], settings_url: 'https://github.com/settings/installations/7' })) as Kosa8GitHubPermissionsError;
    expect(e).toBeInstanceOf(Kosa8GitHubPermissionsError);
    expect(e.missingPermissions).toEqual(['pull_requests:write']);
    expect(e.settingsUrl).toBe('https://github.com/settings/installations/7');
  });

  it('no_changes, repo_not_found and github_unavailable have their own classes', async () => {
    expect(await box(409, { error: 'no_changes', message: 'Nothing changed.' })).toBeInstanceOf(Kosa8NoChangesError);
    const nf = await box(404, { error: 'repo_not_found', message: 'No such repo.' });
    expect(nf).toBeInstanceOf(Kosa8RepoNotFoundError);
    expect(nf).toBeInstanceOf(Kosa8NotFoundError);
    const un = (await box(502, { error: 'github_unavailable', message: 'GitHub is busy.', retry_after_s: 30 })) as Kosa8GitHubUnavailableError;
    expect(un).toBeInstanceOf(Kosa8GitHubUnavailableError);
    expect(un.retryAfter).toBe(30);
  });
});
