import { defineConfig } from 'vitest/config';

/**
 * Opt-in config for the chaos layer suites (`tests/chaos/**`).
 *
 * These suites deliberately do NOT appear in `vitest.config.ts`'s `include`
 * list — they arm fault injection and exercise orchestrated recovery, so they
 * are kept out of the default `pnpm test` run. Because Vitest positional
 * arguments only *filter* the configured `include`, `vitest run tests/chaos`
 * finds nothing; widening `include` here is the supported way to run them.
 *
 *   pnpm --filter @praetor/core test:chaos:layers
 */
export default defineConfig({
  test: {
    include: ['tests/chaos/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    // Mirrors vitest.config.ts: serial files (shared SQLite WAL paths,
    // singleton registries), generous timeouts for E2E-ish flows.
    pool: 'threads',
    threads: false,
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 60000,
    // See vitest.config.ts — a global retry turns a nondeterministic failure
    // into a pass without changing the exit code. Deliberate here (chaos suites
    // are infra-sensitive), but it must stay visible as a tradeoff.
    retry: 2,
    forceExit: true,
  },
});
