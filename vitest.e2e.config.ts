import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/e2e/**/*.test.ts', 'src/server/http-crawl-seed.test.ts'],
    environment: 'node',
    testTimeout: 200_000,
  },
});
