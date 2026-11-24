import { describe, expect, it } from 'vitest';
import {
  Kosa8AuthError,
  Kosa8Cloud,
  Kosa8ConflictError,
  Kosa8ConnectionError,
  Kosa8Error,
  Kosa8PaymentRequiredError,
  Kosa8RateLimitError,
  Kosa8TimeoutError,
  Kosa8UnsupportedError,
} from '../src/index.js';

const KEY = 'k8c_live_testkey';

/** A fetch that answers one status, JSON body and headers. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })) as unknown as typeof fetch;
}

async function fail(f: typeof fetch, call: (c: Kosa8Cloud) => Promise<unknown> = (c) => c.sandboxes.create()): Promise<any> {
  const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f, retry: false });
  return call(cloud).then(
    () => {
      throw new Error('expected an error');
    },
    (e: unknown) => e,
  );
}

describe('actionable cloud errors', () => {
  it('503 no_capacity: message, code, status, Retry-After, retryable and the cf-ray request id', async () => {
    const e = await fail(
      answer(
        503,
        {
          error: 'no_capacity', message: 'no capacity: fork fewer or retry in 2 s', retryable: true, retry_after_s: 10,
          failure_class: 'infra',
        },
        { 'Retry-After': '7', 'cf-ray': 'a5e77ddee9ef8120-BOS' },
      ),
    );
    expect(e).toBeInstanceOf(Kosa8Error);
    expect(e.code).toBe('no_capacity');
    expect(e.status).toBe(503);
    expect(e.retryAfter).toBe(7); // the header wins over the body
    expect(e.retryAfterS).toBe(7);
    expect(e.retryable).toBe(true);
    expect(e.failureClass).toBe('infra');
    expect(e.requestId).toBe('a5e77ddee9ef8120-BOS');
    expect(e.daemonMessage).toBe('no capacity: fork fewer or retry in 2 s');
    expect(e.message).toBe(
      'no capacity: fork fewer or retry in 2 s [HTTP 503 no_capacity; retry in 7 s; request a5e77ddee9ef8120-BOS]',
    );
  });

  it('X-Request-Id is preferred over cf-ray', async () => {
    const e = await fail(answer(404, { error: 'not_found', message: 'no such sandbox' }, { 'X-Request-Id': 'req_1', 'cf-ray': 'ray' }),
      (c) => c.sandboxes.get('sbx_x'));
    expect(e.requestId).toBe('req_1');
    expect(e.message).toBe('no such sandbox [HTTP 404 not_found; request req_1]');
  });

  it('409 template_building: retry_after_s from the body, eta_s kept in body', async () => {
    const e = await fail(
      answer(409, {
        error: 'template_building', message: 'the environment is being built; ready in about 40 s', eta_s: 40,
        retry_after_s: 10, failure_class: 'quota', retryable: true,
      }),
    );
    expect(e).toBeInstanceOf(Kosa8ConflictError);
    expect(e.code).toBe('template_building');
    expect(e.retryAfterS).toBe(10);
    expect(e.retryable).toBe(true);
    expect(e.body.eta_s).toBe(40);
    expect(e.message).toContain('ready in about 40 s [HTTP 409 template_building; retry in 10 s]');
  });

  it('402: upgrade url in the message unless the sentence already has it', async () => {
    const e = await fail(
      answer(402, {
        error: 'payment_required', message: 'add a payment method to run sandboxes',
        upgrade_url: 'https://app.kosa8.com/app#billing', agent_message: 'Tell your person to add a card.',
      }),
    );
    expect(e).toBeInstanceOf(Kosa8PaymentRequiredError);
    expect(e.retryable).toBe(false);
    expect(e.upgradeUrl).toBe('https://app.kosa8.com/app#billing');
    expect(e.message).toBe(
      'add a payment method to run sandboxes [HTTP 402 payment_required; upgrade: https://app.kosa8.com/app#billing]',
    );
    const inline = await fail(
      answer(402, { error: 'plan_required', message: 'choose a plan at https://app.kosa8.com/app#billing', upgrade_url: 'https://app.kosa8.com/app#billing' }),
    );
    expect(inline.message).toBe('choose a plan at https://app.kosa8.com/app#billing [HTTP 402 plan_required]');
  });

  it('401 says how to fix the key', async () => {
    const e = await fail(answer(401, { error: 'unauthorized', message: 'API key is unknown, revoked or expired' }));
    expect(e).toBeInstanceOf(Kosa8AuthError);
    expect(e.message).toBe(
      'API key is unknown, revoked or expired (check KOSA8_API_KEY; make a new key at https://app.kosa8.com/app#keys) [HTTP 401 unauthorized]',
    );
  });

  it('501 not_available is not retryable', async () => {
    const e = await fail(answer(501, { error: 'not_available', message: 'background commands are not available on this host yet' }),
      (c) => c.sandboxes.get('sbx_1'));
    expect(e).toBeInstanceOf(Kosa8UnsupportedError);
    expect(e.retryable).toBe(false);
    expect(e.retryAfterS).toBeUndefined();
    expect(e.message).toBe('background commands are not available on this host yet [HTTP 501 not_available]');
  });

  it('429 quota with an HTTP-date Retry-After', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const e = await fail(answer(429, { error: 'rate_limited', message: 'slow down' }, { 'Retry-After': at }));
    expect(e.retryAfterS).toBeGreaterThanOrEqual(28);
    expect(e.retryAfterS).toBeLessThanOrEqual(31);
    expect(e.retryable).toBe(true);
  });

  it('a missing or malformed key says where to get one', () => {
    expect(() => new Kosa8Cloud({ env: {} })).toThrow(/set KOSA8_API_KEY or pass \{ apiKey \}; make one at https:\/\/app\.kosa8\.com\/app#keys/);
    expect(() => new Kosa8Cloud({ apiKey: 'sk-nope', env: {} })).toThrow(/check KOSA8_API_KEY or copy the whole key from https:\/\/app\.kosa8\.com\/app#keys/);
  });

  it('a connection failure says what to check', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const e = await fail(f);
    expect(e).toBeInstanceOf(Kosa8ConnectionError);
    expect(e.message).toMatch(/could not reach kosa8 Cloud at https:\/\/api\.kosa8\.com: fetch failed; check the network connection and KOSA8_CLOUD_URL/);
    expect(e.retryable).toBe(true);
  });

  it('a timeout says to retry or raise timeoutMs', async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f, retry: false, timeoutMs: 20 });
    const e: any = await cloud.sandboxes.get('sbx_1').catch((x) => x);
    expect(e).toBeInstanceOf(Kosa8TimeoutError);
    expect(e.message).toMatch(/did not answer GET \/v1\/sandboxes\/sbx_1 within 20 ms; retry, or raise timeoutMs/);
  });

  it('402 plan_limit exposes the contract fields: limit, used, plan, next_plan, options, pack_url, upgrade_url, agent_message', async () => {
    const e = await fail(answer(402, {
      error: 'plan_limit', message: 'Your plan allows 5 running sandboxes', limit_name: 'running', limit: 5, used: 5,
      plan: 'starter', next_plan: 'team', pack_url: 'https://app.kosa8.com/app#packs', upgrade_url: 'https://app.kosa8.com/app#billing',
      agent_message: 'Tell your person: the plan allows 5 running sandboxes.', failure_class: 'quota', retryable: false,
      options: [{ kind: 'pack', addon: 'running_5', monthly_usd: 10 }, { kind: 'upgrade', plan: 'team', monthly_usd: 40 }],
    }));
    expect(e).toBeInstanceOf(Kosa8PaymentRequiredError);
    expect(e.code).toBe('plan_limit');
    expect(e.limitName).toBe('running');
    expect(e.limit).toBe(5);
    expect(e.used).toBe(5);
    expect(e.plan).toBe('starter');
    expect(e.nextPlan).toBe('team');
    expect(e.packUrl).toBe('https://app.kosa8.com/app#packs');
    expect(e.upgradeUrl).toBe('https://app.kosa8.com/app#billing');
    expect(e.agentMessage).toMatch(/^Tell your person/);
    expect(e.options.map((o: { kind: string }) => o.kind)).toEqual(['pack', 'upgrade']);
    expect(e.retryable).toBe(false);
    expect(e.failureClass).toBe('quota');
  });

  it('429 quota_exceeded exposes agent_message and request_url and is not retried', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({
        error: 'quota_exceeded', message: 'You have 20 running sandboxes, the limit', agent_message: 'Ask for a higher limit.',
        request_url: 'https://api.kosa8.com/v1/limits/request',
      }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f, retry: { attempts: 3, baseMs: 0 } });
    const e: any = await cloud.sandboxes.create().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Kosa8RateLimitError);
    expect(e.agentMessage).toBe('Ask for a higher limit.');
    expect(e.requestUrl).toBe('https://api.kosa8.com/v1/limits/request');
    expect(e.limit).toBeNull();
    expect(e.options).toEqual([]);
    expect(e.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it('402 spend_cap and starter_limit are quota, not retried', async () => {
    for (const code of ['spend_cap', 'starter_limit', 'new_account_limit']) {
      const e = await fail(answer(402, { error: code, message: 'no' }));
      expect(e.failureClass).toBe('quota');
      expect(e.retryable).toBe(false);
    }
  });
});
