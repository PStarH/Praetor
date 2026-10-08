/**
 * Precondition gate for `apps/api/tests/*.test.ts`.
 *
 * That directory is a live-server integration suite owned by
 * `apps/api/scripts/run-integration-tests.ts`: the runner builds the API,
 * starts it, waits for `/health`, and only then exports `TEST_API_URL` to the
 * test files. Running a file directly without a server used to fall back to
 * `http://localhost:4000` and emit ~178 connection-refused assertion failures,
 * which hid the real precondition instead of stating it.
 *
 * Each file in the suite calls `requireLiveServer()` at load time, so an
 * unconfigured run fails fast with this one stable message rather than a wall
 * of downstream failures — and it is a hard failure, never a silent skip.
 */
export const LIVE_SERVER_PRECONDITION =
  'TEST_API_URL is not set: apps/api/tests/*.test.ts is a live-server integration suite and must be run through apps/api/scripts/run-integration-tests.ts (pnpm --filter @praetor/api test:integration), which builds and starts the API and exports TEST_API_URL.';

export function requireLiveServer() {
  const baseUrl = process.env.TEST_API_URL;
  if (!baseUrl) {
    throw new Error(LIVE_SERVER_PRECONDITION);
  }
  return baseUrl;
}
