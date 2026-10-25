import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each file builds its own databases in a temporary folder; postgres tests share one server.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
