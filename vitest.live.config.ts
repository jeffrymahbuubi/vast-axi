import { defineConfig } from 'vitest/config';

// Live smoke test only (costs money). Run with: VAST_AXI_LIVE=1 pnpm test:live
// Without VAST_AXI_LIVE=1 the suite loads and skips itself.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
