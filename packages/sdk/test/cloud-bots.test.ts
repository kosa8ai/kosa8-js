import { describe, expect, it } from 'vitest';
import {
  Kosa8ApiError,
  Kosa8Cloud,
  Kosa8ConflictError,
  Kosa8HumanApprovalRequiredError,
  Kosa8PolicyError,
  MAX_BOT_SENTENCE,
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

const bot = { id: 'bot_1', name: 'Spend guard', template: 'spend-guard@1', state: 'draft', sponsor: 'a@b.co', source: 'template', version: 1, last_run: null, created_at: 1, updated_at: 1 };
const run = { id: 'brun_1', bot_id: 'bot_1', version: 1, dry_run: true, state: 'succeeded', trigger: { event: 'manual', subject: null, summary: '' }, steps: [], cost_usd: 0, created_at: 1 };
const approval = { id: 'appr_1', run_id: 'brun_1', bot_id: 'bot_1', bot_name: 'x', step_key: 's1', action: 'sandbox.delete', tier: 'T3', args: {}, state: 'pending', expires_at: 2, decision: null, created_at: 1 };
const spec = { triggers: [{ event: 'sandbox.idle', for_s: 1200 }], actions: [{ action: 'sandbox.sleep', args: { snapshot: true } }] };

function answer(s: Seen): [number, unknown] {
  const p = s.url.pathname;
  if (p === '/v1/bots' && s.method === 'GET') return [200, { bots: [bot], paused_all: false, paused_all_at: null, pending_approvals: 2 }];
  if (p === '/v1/bot-templates') return [200, { templates: [{ id: 'spend-guard' }] }];
  if (p.startsWith('/v1/bot-templates/')) return [200, { template: { id: 'spend-guard' } }];
  if (p === '/v1/bots/plan') return [200, { plan: { summary: 's' }, spec }];
  if (p === '/v1/bots/compile') return [200, { spec, plan: { summary: 's' }, source: 'rules', notes: [] }];
  if (p === '/v1/bots/pause-all' || p === '/v1/bots/resume-all') return [200, { paused_all: p.endsWith('pause-all'), at: 5 }];
  if (p.startsWith('/v1/approvals/')) return [200, p.endsWith('/decide') ? { approval, run } : { approval }];
  if (p === '/v1/approvals') return [200, { approvals: [approval] }];
  if (p.startsWith('/v1/bot-runs/')) return [200, { run }];
  if (p.endsWith('/runs')) return s.method === 'GET' ? [200, { runs: [run] }] : [201, { run }];
  if (s.method === 'DELETE') return [200, { deleted: true }];
  return [s.method === 'POST' && p === '/v1/bots' ? 201 : 200, { bot }];
}

describe('cloud.bots', () => {
  it('calls every contract path with the right method and body', async () => {
    const { cloud, seen } = cloudWith(answer);
    const l = await cloud.bots.list();
    expect(l.bots[0]!.id).toBe('bot_1');
    expect(l.pending_approvals).toBe(2);
    expect(l.paused_all).toBe(false);
    expect((await cloud.bots.templates())[0]!.id).toBe('spend-guard');
    expect((await cloud.bots.template('spend-guard')).id).toBe('spend-guard');
    expect((await cloud.bots.plan({ template: 'spend-guard', replay: true })).spec).toEqual(spec);
    await cloud.bots.plan({ spec, name: 'idle' });
    expect((await cloud.bots.compile('sleep idle dev sandboxes after 20 minutes')).source).toBe('rules');
    expect((await cloud.bots.create({ template: 'spend-guard', name: 'g', sponsor: 'a@b.co', budgetUsd: 5, scope: { labels: { env: 'dev' } }, notify: { mode: 'digest' } })).state).toBe('draft');
    await cloud.bots.create({ spec });
    await cloud.bots.get('bot_1');
    await cloud.bots.update('bot_1', { name: 'n', budgetUsd: 3 });
    await cloud.bots.delete('bot_1');
    await cloud.bots.enable('bot_1');
    await cloud.bots.disable('bot_1');
    expect((await cloud.bots.run('bot_1')).dry_run).toBe(true);
    await cloud.bots.run('bot_1', { dryRun: false });
    expect((await cloud.bots.runs('bot_1', { limit: 5 }))[0]!.id).toBe('brun_1');
    await cloud.bots.getRun('brun_1');
    await cloud.bots.cancelRun('brun_1');
    await cloud.bots.undoStep('brun_1', 's1');
    expect((await cloud.bots.pauseAll()).paused_all).toBe(true);
    expect((await cloud.bots.resumeAll()).paused_all).toBe(false);
    expect(seen.map((s) => [`${s.method} ${s.url.pathname}${s.url.search}`, s.body])).toEqual([
      ['GET /v1/bots', undefined],
      ['GET /v1/bot-templates', undefined],
      ['GET /v1/bot-templates/spend-guard', undefined],
      ['POST /v1/bots/plan', { template: 'spend-guard', replay: true }],
      ['POST /v1/bots/plan', { spec, name: 'idle' }],
      ['POST /v1/bots/compile', { text: 'sleep idle dev sandboxes after 20 minutes' }],
      ['POST /v1/bots', { template: 'spend-guard', name: 'g', sponsor: 'a@b.co', budget_usd: 5, scope: { labels: { env: 'dev' } }, notify: { mode: 'digest' } }],
      ['POST /v1/bots', { spec }],
      ['GET /v1/bots/bot_1', undefined],
      ['PATCH /v1/bots/bot_1', { name: 'n', budget_usd: 3 }],
      ['DELETE /v1/bots/bot_1', undefined],
      ['POST /v1/bots/bot_1/enable', {}],
      ['POST /v1/bots/bot_1/disable', {}],
      ['POST /v1/bots/bot_1/runs', { dry_run: true }],
      ['POST /v1/bots/bot_1/runs', { dry_run: false }],
      ['GET /v1/bots/bot_1/runs?limit=5', undefined],
      ['GET /v1/bot-runs/brun_1', undefined],
      ['POST /v1/bot-runs/brun_1/cancel', {}],
      ['POST /v1/bot-runs/brun_1/steps/s1/undo', {}],
      ['POST /v1/bots/pause-all', {}],
      ['POST /v1/bots/resume-all', {}],
    ]);
  });

  it('create and plan take exactly one of template or spec, before any request', async () => {
    const { cloud, seen } = cloudWith(answer);
    await expect(cloud.bots.create({} as never)).rejects.toThrow(/exactly one of template or spec/);
    await expect(cloud.bots.create({ template: 'spend-guard', spec } as never)).rejects.toThrow(/exactly one/);
    expect(() => cloud.bots.plan({ template: 'x', spec } as never)).toThrow(/exactly one/);
    expect(seen).toHaveLength(0);
  });

  it('compile checks the sentence length locally', async () => {
    const { cloud, seen } = cloudWith(answer);
    expect(() => cloud.bots.compile('x'.repeat(MAX_BOT_SENTENCE + 1))).toThrow(/at most 500/);
    expect(() => cloud.bots.compile('  ')).toThrow(/needs a sentence/);
    await cloud.bots.compile('x'.repeat(MAX_BOT_SENTENCE));
    expect(seen).toHaveLength(1);
  });

  it('escapes ids in paths', async () => {
    const { cloud, seen } = cloudWith(answer);
    await cloud.bots.get('bot_1/../x');
    await cloud.bots.undoStep('brun 1', 'a/b');
    await cloud.approvals.get('appr_1?x=1');
    expect(seen.map((s) => s.url.pathname)).toEqual([
      '/v1/bots/bot_1%2F..%2Fx',
      '/v1/bot-runs/brun%201/steps/a%2Fb/undo',
      '/v1/approvals/appr_1%3Fx%3D1',
    ]);
  });
});

describe('cloud.approvals', () => {
  it('list (pending by default), get, approve and reject', async () => {
    const { cloud, seen } = cloudWith(answer);
    expect((await cloud.approvals.list())[0]!.id).toBe('appr_1');
    await cloud.approvals.list({ state: 'all', limit: 10 });
    expect((await cloud.approvals.get('appr_1')).tier).toBe('T3');
    const r = await cloud.approvals.approve('appr_1', { reason: 'ok', editedArgs: { host: 'a.com' } });
    expect(r.run.id).toBe('brun_1');
    await cloud.approvals.approve('appr_1');
    await cloud.approvals.reject('appr_1', { reason: 'no' });
    expect(seen.map((s) => [`${s.method} ${s.url.pathname}${s.url.search}`, s.body])).toEqual([
      ['GET /v1/approvals?state=pending', undefined],
      ['GET /v1/approvals?state=all&limit=10', undefined],
      ['GET /v1/approvals/appr_1', undefined],
      ['POST /v1/approvals/appr_1/decide', { decision: 'approve', reason: 'ok', edited_args: { host: 'a.com' } }],
      ['POST /v1/approvals/appr_1/decide', { decision: 'approve' }],
      ['POST /v1/approvals/appr_1/decide', { decision: 'reject', reason: 'no' }],
    ]);
  });
});

describe('human_required', () => {
  const refuse = () =>
    cloudWith(() => [403, { error: 'human_required', message: 'a person must approve this: open app.kosa8.com/app#autopilot or Slack' }]).cloud;

  it.each([
    ['approve', (c: Kosa8Cloud) => c.approvals.approve('appr_1')],
    ['reject', (c: Kosa8Cloud) => c.approvals.reject('appr_1')],
    ['enable', (c: Kosa8Cloud) => c.bots.enable('bot_1')],
    ['resumeAll', (c: Kosa8Cloud) => c.bots.resumeAll()],
  ])('%s throws Kosa8HumanApprovalRequiredError', async (_name, call) => {
    const e = await call(refuse()).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(Kosa8HumanApprovalRequiredError);
    expect(e).toBeInstanceOf(Kosa8PolicyError);
    expect(e).toBeInstanceOf(Kosa8ApiError);
    const h = e as Kosa8HumanApprovalRequiredError;
    expect(h.status).toBe(403);
    expect(h.code).toBe('human_required');
    expect(h.message).toMatch(/a person must approve/);
  });

  it('another 403 or a 409 decided stays its usual class', async () => {
    const other = await cloudWith(() => [403, { error: 'forbidden', message: 'no' }]).cloud.bots.enable('bot_1').then(() => null, (x: unknown) => x);
    expect(other).toBeInstanceOf(Kosa8PolicyError);
    expect(other).not.toBeInstanceOf(Kosa8HumanApprovalRequiredError);
    const decided = await cloudWith(() => [409, { error: 'decided', message: 'already decided' }]).cloud.approvals.approve('appr_1').then(() => null, (x: unknown) => x);
    expect(decided).toBeInstanceOf(Kosa8ConflictError);
  });
});
