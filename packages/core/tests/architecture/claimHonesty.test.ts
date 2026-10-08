/**
 * Claim honesty: marketing/docstrings must not overstate durability.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

describe('claim honesty', () => {
  it('apps/api EpisodicMemoryStore stays deleted after the zombie removal', () => {
    const path = join(ROOT, 'apps/api/src/episodicMemoryStore.ts');
    assert.equal(
      existsSync(path),
      false,
      'apps/api EpisodicMemoryStore was deleted as a health-only zombie; do not reintroduce',
    );
  });

  it('EventSourcingEngine header does not claim unconditional WAL durability', () => {
    const path = join(ROOT, 'packages/core/src/runtime/eventSourcingEngine.ts');
    assert.ok(existsSync(path));
    const head = readFileSync(path, 'utf8').slice(0, 1200);
    assert.match(head, /optional file WAL|in-memory only/i);
    assert.doesNotMatch(
      head,
      /Event Sourcing Engine — WAL persistence with hash-chain integrity/,
      'unconditional WAL claim was fixed 2026-07-15',
    );
    const body = readFileSync(path, 'utf8');
    assert.match(body, /isDurable\(\): boolean/, 'must expose isDurable() for callers');
  });

  it('the architecture maps do not claim packages/operations is the timer/outbox plane', () => {
    // ARCHITECTURE.md was deliberately removed in `8ab4fc42` ("docs: remove
    // obsolete architecture overview"), so hardcoding it made this gate fail on
    // a missing file rather than on a false claim. Read whichever architecture
    // documentation the repository actually ships, and fail if there is none —
    // the ownership claims below must live *somewhere*, not nowhere.
    const candidates = ['PRINCIPLES.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md'];
    const archDir = join(ROOT, 'docs/architecture');
    if (existsSync(archDir)) {
      for (const name of readdirSync(archDir)) {
        if (name.endsWith('.md')) candidates.push(`docs/architecture/${name}`);
      }
    }
    const present = candidates.filter((rel) => existsSync(join(ROOT, rel)));
    assert.ok(
      present.length > 0,
      `no architecture documentation found among: ${candidates.join(', ')}`,
    );
    const maps = present.map((rel) => readFileSync(join(ROOT, rel), 'utf8')).join('\n');

    // Applied to the whole map set rather than to one hardcoded file: the false
    // claim is forbidden wherever it appears.
    assert.doesNotMatch(
      maps,
      /packages\/operations`\s*\|\s*Outbox\/timer mains/i,
      'the maps must not describe ABSENT operations as outbox/timer',
    );
    assert.match(
      maps,
      /kernel-ops|packages\/kernel\/src\/ops/i,
      'maps must name kernel-ops for reclaim/timer/outbox',
    );
    assert.match(maps, /compensation/i, 'maps must name compensation ownership');
    assert.match(
      maps,
      /ban(?:s|ned)?[\s*`]*@commander\/operations|ban(?:s|ned)?[\s*`]*resurrect/i,
      'maps must state arch-guard bans resurrecting @praetor/operations',
    );
    assert.doesNotMatch(
      maps,
      /reintroduce\s+`?@commander\/operations`?\s+as/i,
      'must not invite resurrecting @praetor/operations under another name',
    );
    // After L4-B land (#105), adapter-ops is the live PARTIAL deploy unit for
    // compensation/reconcile drain — not a deferred follow-up, not a fifth plane.
    assert.match(
      maps,
      /adapter-ops[\s\S]{0,200}(PARTIAL|compensation|reconcile)/i,
      'adapter-ops must be documented as PARTIAL deploy unit for compensation/reconcile',
    );
    assert.doesNotMatch(
      maps,
      /adapter-ops[\s\S]{0,80}L4-B follow-up only|L4-B follow-up only[\s\S]{0,80}adapter-ops/i,
      'must not still claim adapter-ops is follow-up-only after L4-B land',
    );
  });

  it('no production kernel-ops main wires consumeCompensationBatch (library-only gap)', () => {
    const mainPath = join(ROOT, 'packages/kernel/src/ops/main.ts');
    assert.ok(existsSync(mainPath));
    const main = readFileSync(mainPath, 'utf8');
    assert.doesNotMatch(
      main,
      /consumeCompensationBatch/,
      'kernel-ops main must not silently claim compensation drain; library remains for a dedicated owner',
    );
    const consumer = join(ROOT, 'packages/kernel/src/ops/compensationConsumer.ts');
    assert.ok(existsSync(consumer), 'compensation consumer library should still exist');
  });

  it('apps/api StateMachine persist/checkpoint uses atomicWriteFileSync (REL-3)', () => {
    const path = join(ROOT, 'apps/api/src/stateMachine.ts');
    assert.ok(existsSync(path));
    const body = readFileSync(path, 'utf8');
    assert.match(body, /atomicWriteFileSync/, 'must import/use atomicWriteFileSync');
    assert.match(body, /readJsonFileSafe/, 'must use readJsonFileSafe for load paths');
    assert.doesNotMatch(
      body,
      /fs\.writeFileSync\s*\(/,
      'non-atomic fs.writeFileSync was fixed 2026-07-20; do not reintroduce',
    );
  });

  it('security-sensitive Gateway JSON stores use atomicWrite + readJsonFileSafe (REL-3/REL-4)', () => {
    const arrayStores = [
      'apps/api/src/webhookEndpoints.ts',
      'apps/api/src/workflowEndpoints.ts',
      'apps/api/src/actionRationale.ts',
    ];
    const objectStores = [
      'apps/api/src/settingsStore.ts',
      'apps/api/src/oidcAuthEndpoints.ts',
      'apps/api/src/approvalConfigEndpoints.ts',
      'apps/api/src/onboardingEndpoints.ts',
    ];
    /**
     * Migrated to PostgreSQL — these no longer persist JSON at all, so the
     * atomic-file-write requirement does not apply. They are still audited, but
     * with the *shape-independent* invariant below: a store may hold durable
     * state either in PostgreSQL or in a JSON file, and whichever it uses must
     * not be able to tear. Asserting `atomicWriteFileSync` on a Postgres
     * repository was a false failure (it made the whole gate red from
     * 2026-09-16 onward); asserting nothing would let the file be gutted.
     */
    const postgresStores = [
      'apps/api/src/userStore.ts',
      'apps/api/src/apiKeyStore.ts',
      'apps/api/src/refreshTokenStore.ts',
    ];
    const jsonStores = [...arrayStores, ...objectStores];
    const files = [...jsonStores, ...postgresStores];

    for (const rel of files) {
      const p = join(ROOT, rel);
      assert.ok(existsSync(p), `${rel} must exist`);
      const body = readFileSync(p, 'utf8');

      // Shape-independent: whatever a store uses for durable state, it must not
      // write it non-atomically.
      assert.doesNotMatch(
        body,
        /fs\.writeFileSync\s*\(/,
        `${rel} must not use non-atomic fs.writeFileSync`,
      );
    }

    for (const rel of jsonStores) {
      const body = readFileSync(join(ROOT, rel), 'utf8');
      assert.match(body, /atomicWriteFileSync/, `${rel} must use atomicWriteFileSync`);
      assert.match(
        body,
        /readJsonFileSafe/,
        `${rel} must use readJsonFileSafe (corrupt-load must not silent-[] then wipe)`,
      );
    }

    for (const rel of postgresStores) {
      const body = readFileSync(join(ROOT, rel), 'utf8');
      // Anti-rot: prove the file really is Postgres-backed rather than merely
      // emptied. Without this, deleting the persistence code would also make
      // the atomic-write requirement disappear and the gate would stay green.
      assert.match(
        body,
        /SqlPool|createVerifiedPostgresPool|createAuthPool/,
        `${rel} is exempt from the JSON-store rule only while it is PostgreSQL-backed`,
      );
      // If JSON file persistence ever comes back, it must come back atomically —
      // and this assertion fails so the file is moved into `jsonStores`.
      assert.doesNotMatch(
        body,
        /atomicWriteFileSync|readJsonFileSafe/,
        `${rel} no longer persists JSON; if that changed, move it into jsonStores`,
      );
    }
    for (const rel of arrayStores) {
      const body = readFileSync(join(ROOT, rel), 'utf8');
      assert.match(
        body,
        /readJsonFileSafe\s*<[^>]*>\s*\([^)]*Array\.isArray/,
        `${rel} must pass Array.isArray shape guard (wrong-shape must quarantine)`,
      );
    }
    for (const rel of objectStores) {
      const body = readFileSync(join(ROOT, rel), 'utf8');
      assert.match(
        body,
        /isPlainObjectJson/,
        `${rel} must use isPlainObjectJson shape guard (wrong-shape must quarantine)`,
      );
    }
    // refreshTokenStore moved to PostgreSQL (see `postgresStores` above), and its
    // JSON shape guards went with the file format: `isRefreshStoreShape` and
    // `isSignedEnvelope` no longer exist anywhere in the repository. The
    // durability property those guards protected — a jti that can be consumed by
    // exactly one caller even under concurrency — is now enforced by the
    // database, so assert that instead of the removed helper names.
    const refreshBody = readFileSync(join(ROOT, 'apps/api/src/refreshTokenStore.ts'), 'utf8');
    assert.match(
      refreshBody,
      /UPDATE[\s\S]{0,400}?RETURNING/,
      'refreshTokenStore must consume a jti with an atomic UPDATE ... RETURNING',
    );
    assert.match(
      refreshBody,
      /revoked_at IS NULL/,
      'refreshTokenStore consumption must be single-use (only an unrevoked row may be claimed)',
    );
    const helper = readFileSync(join(ROOT, 'apps/api/src/atomicWrite.ts'), 'utf8');
    assert.match(
      helper,
      /isExpectedShape/,
      'readJsonFileSafe must support shape quarantine after parse OK',
    );
  });
});
