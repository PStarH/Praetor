/**
 * Browser-safe silent-failure reporter.
 *
 * The server-side canonical implementation lives in `@praetor/core`.
 * That version depends on Node-only modules (async_hooks, blessed logging,
 * playwright-backed tools, etc.) and cannot be bundled for the web GUI.
 * This thin browser twin preserves the same call signature and logs the
 * recovered error in development builds so failures are observable without
 * breaking the "silent recovery" contract in production.
 */
export function reportSilentFailure(error: unknown, context: string): void {
  const isDev = (import.meta.env as Record<string, unknown>).DEV === true;
  if (isDev) {
    // eslint-disable-next-line no-console
    console.warn(`[silent failure] ${context}`, error);
  }
}
