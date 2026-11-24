import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('package.json', () => {
  it('accepts the @kosa8/sdk in this repo, so npm ci links the workspace copy', () => {
    const range: string = read('../package.json').dependencies['@kosa8/sdk'];
    const [major, minor] = (read('../../sdk/package.json').version as string).split('.');
    // 0.x caret ranges: ^0.7.0 covers 0.7.*; a newer minor needs its own alternative.
    const want = major === '0' ? `^0.${minor}.0` : `^${major}.0.0`;
    expect(range.split('||').map((s) => s.trim())).toContain(want);
  });
});
