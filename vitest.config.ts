import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'fixtures/**/*.test.ts'],
    // Keep the unit suite fast and deterministic: exclude the e2e tree and any
    // test that spawns a real MCP server (those run under vitest.e2e.config.ts).
    exclude: [
      'src/e2e/**',
      'src/server/http-crawl-seed.test.ts',
      'fixtures/**/node_modules/**',
    ],
    environment: 'node',
    // ts-morph-backed extraction tests are CPU-heavy; the default 5s per-test
    // timeout flakes when vitest's parallel workers contend under load (and in CI).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
