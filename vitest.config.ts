import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Builds dist/ once, before any worker collects a file, so the process-level CLI gates always
    // run against a current artifact instead of skipping or racing a build of their own.
    globalSetup: ['test/globalSetup.ts'],
    coverage: {
      provider: 'v8',
      // Files that are never imported by tests are reported too, so uncovered code is visible.
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
