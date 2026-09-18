import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The LaTeX integration tests compile real PDFs, which is slow but is the
    // only way to verify the one-page guarantee.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Sweeps the throwaway directories the helpers handed out. See setup.ts.
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        // A thin argv parser and a listen() call; exercised through the CLI and
        // e2e runs rather than unit tests.
        'src/cli.ts',
        'src/server/index.ts',
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
