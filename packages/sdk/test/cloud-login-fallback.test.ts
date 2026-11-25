import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Kosa8Cloud,
  Kosa8Error,
  Kosa8PaymentRequiredError,
  Kosa8PlanLimitError,
  Kosa8RateLimitError,
} from '../src/index.js';

function homeWith(creds: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'kosa8-home-'));
  mkdirSync(join(d, '.kosa8'));
  if (creds !== undefined) {
    writeFileSync(join(d, '.kosa8', 'cloud.json'), typeof creds === 'string' ? creds : JSON.stringify(creds));
  }
  return d;
}

describe('kosa8 login fallback', () => {
  it('uses ~/.kosa8/cloud.json when KOSA8_API_KEY is unset', () => {
    const HOME = homeWith({ key: 'k8c_live_fromlogin', api_url: 'http://localhost:8787', org_id: 'org_1' });
    const c = new Kosa8Cloud({ env: { HOME } });
    expect(c.baseUrl).toBe('http://localhost:8787');
    expect((c as unknown as { apiKey: string }).apiKey).toBe('k8c_live_fromlogin');
  });

  it('the env key wins, and then the saved address is not used', () => {
    const HOME = homeWith({ key: 'k8c_live_fromlogin', api_url: 'http://localhost:8787' });
    const c = new Kosa8Cloud({ env: { HOME, KOSA8_API_KEY: 'k8c_live_env' } });
    expect((c as unknown as { apiKey: string }).apiKey).toBe('k8c_live_env');
    expect(c.baseUrl).toBe('https://api.kosa8.com');
  });

  it('KOSA8_CLOUD_URL wins over the saved address', () => {
    const HOME = homeWith({ key: 'k8c_live_fromlogin', api_url: 'http://localhost:8787' });
    expect(new Kosa8Cloud({ env: { HOME, KOSA8_CLOUD_URL: 'http://localhost:9999' } }).baseUrl).toBe('http://localhost:9999');
  });

  it('no file, a bad file, or no HOME: the error names kosa8 login', () => {
    for (const creds of [undefined, 'not json', { org_id: 'x' }]) {
      expect(() => new Kosa8Cloud({ env: { HOME: homeWith(creds) } })).toThrow(/kosa8 login/);
    }
    expect(() => new Kosa8Cloud({ env: {} })).toThrow(Kosa8Error);
  });

  it('an explicit empty apiKey does not read the file', () => {
    const HOME = homeWith({ key: 'k8c_live_fromlogin' });
    expect(() => new Kosa8Cloud({ apiKey: '', env: { HOME } })).toThrow(Kosa8Error);
  });
});

function answer(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}

async function fail(status: number, body: unknown): Promise<unknown> {
  const c = new Kosa8Cloud({ apiKey: 'k8c_live_x', env: {}, fetch: answer(status, body), retry: false });
  return c.sandboxes.create().then(
    () => {
      throw new Error('expected an error');
    },
    (e) => e,
  );
}

describe('starter_limit is a payment error whatever the status', () => {
  it('429 starter_limit', async () => {
    const e = await fail(429, { error: 'starter_limit', message: 'Starter runs 2 sandboxes at once' });
    expect(e).toBeInstanceOf(Kosa8PaymentRequiredError);
    expect(e).toBeInstanceOf(Kosa8PlanLimitError);
    expect(e).toBeInstanceOf(Kosa8RateLimitError);
    expect((e as Kosa8PaymentRequiredError).retryable).toBe(false);
  });

  it('a plain 429 stays a rate limit only', async () => {
    const e = await fail(429, { error: 'rate_limited', message: 'slow down' });
    expect(e).toBeInstanceOf(Kosa8RateLimitError);
    expect(e).not.toBeInstanceOf(Kosa8PaymentRequiredError);
  });
});
