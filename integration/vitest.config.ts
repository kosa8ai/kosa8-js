import { defineConfig } from 'vitest/config';

// Runs against a real kosa8 daemon (default socket, or KOSA8_HOST).
export default defineConfig({
  test: {
    include: ['integration/**/*.integration.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
