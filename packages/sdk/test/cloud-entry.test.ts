import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import * as cloud from '../src/cloud-entry.js';

describe('@kosa8/sdk/cloud', () => {
  it('bundles for a browser: no Node built-ins anywhere in its graph', async () => {
    const r = await build({
      entryPoints: [new URL('../src/cloud-entry.ts', import.meta.url).pathname],
      bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent',
    });
    expect(r.errors).toEqual([]);
    const js = r.outputFiles[0]!.text;
    expect(js).not.toMatch(/from\s+["'](node:)?(fs|http|https|os|path|net|stream|child_process)["']/);
  }, 30_000);

  it('the root re-exports every cloud name, plus the daemon client', () => {
    for (const k of Object.keys(cloud)) expect(root).toHaveProperty(k);
    expect(root).toHaveProperty('Kosa8Client');
    expect(cloud).not.toHaveProperty('Kosa8Client');
    expect(typeof cloud.Kosa8Cloud).toBe('function');
    expect(typeof cloud.rl.withRun).toBe('function');
  });
});
