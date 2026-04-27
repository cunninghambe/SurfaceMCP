import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'fixtures/**/*.test.ts'],
    exclude: ['src/e2e/**', 'fixtures/**/node_modules/**'],
    environment: 'node',
  },
});
