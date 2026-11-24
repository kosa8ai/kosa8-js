import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cloud: 'src/cloud-entry.ts', 'compat/e2b': 'src/compat/e2b.ts', 'compat/daytona': 'src/compat/daytona.ts', 'compat/modal': 'src/compat/modal.ts', 'compat/vercel': 'src/compat/vercel.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  platform: 'node',
});
