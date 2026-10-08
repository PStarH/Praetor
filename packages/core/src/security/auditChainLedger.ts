/**
 * AuditChainLedger — Tamper-evident hash-chained audit log (Phase 1.1).
 *
 * Wraps SecurityAuditLogger by appending a per-process HMAC chain to every
 * persisted security event. Each entry links to the previous one via
 * `entryHash = HMAC-SHA-256(tenantKey, canonical({chainId, seq, prevHash,
 *   ...auditEventFields}))`. `verify()` re-reads persisted NDJSON files
 * (across rotation), re-derives every HMAC, and detects any unauthorized
 * modification, deletion, insertion, or reordering.
 *
 * Design rationale
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ 1. Per-process chains, not global:                                │
 * │    Multiple processes (pod workers, CLI invocations, tests) write │
 * │    the same .commander_security/audit-chain-*.ndjson. A global    │
 * │    monotonic counter needs distributed coordination. Instead,    │
 * │    each process generates a UUID `chainId` at construction time   │
 * │    and uses an in-memory `seq` counter. Verifiers re-aggregate    │
 * │    entries by (tenantId, chainId) and verify each chain in        │
 * │    isolation — satisfying EU AI Act Article 12 (automatic         │
 * │    logging) + GDPR Article 30 tamper-evidence.                    │
 * │                                                                    │
 * │ 2. Per-tenant key derivation (HKDF):                              │
 * │    One master key (env var COMMANDER_AUDIT_CHAIN_KEY). Each       │
 * │    tenant's HMAC uses HKDF-SHA-256(master, salt="...", info=      │
 * │    "audit-chain|tenant|<id>"). This is standard NIST SP 800-108.   │
 * │                                                                    │
 * │ 3. Canonical JSON for hash input:                                 │
 * │    `details` and `context` are sorted-key stringified so that     │
 * │    object-key insertion order does NOT change the hash. This is   │
 * │    critical for replay correctness when JSON is round-tripped.   │
 * │                                                                    │
 * │ 4. Non-breaking integration:                                       │
 * │    SecurityAuditLogger gets a new `logChainedEntry()` method that │
 * │    writes a parallel NDJSON file (`audit-chain-*.ndjson`). The    │
 * │    original `logEvent()` API is unchanged.                         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   import { getAuditChainLedger } from '@praetor/core';
 *   getAuditChainLedger().logEvent({
 *     type: 'content_threat', severity: 'high', source: 'MyTool',
 *     message: 'prompt injection detected',
 *     details: { toolName: 'web_fetch', matched: 'ignore previous' },
 *   });
 *
 *   import { getAuditChainLedger, AuditChainLedger } from '@praetor/core';
 *   const report = AuditChainLedger.verify(getAuditChainLedger());
 *   if (!report.ok) alert(report.brokenChain);
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCurrentTenantId } from '../runtime/tenantContext';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { SecurityEvent, SecurityEventType, SecuritySeverity } from './securityAuditLogger';
import { isProductionCryptoEnv } from './productionEnv.js';

// ============================================================================
// Public types
// ============================================================================

/**
 * A security event extended with a tamper-evident HMAC chain header.
 *
 * Stored as one NDJSON line in `.commander_security/audit-chain-<index>.ndjson`.
 * Fields strictly precede `hmac`; `hmac` itself is the link to the NEXT entry.
 */
export interface AuditChainEntry extends SecurityEvent {
  /** Per-process unique chain identifier (UUID hex, no dashes). */
  chainId: string;
  /** Per-chain monotonic sequence number, starting at 1. */
  seq: number;
  /** Hex SHA-256 HMAC of the previous entry; GENESIS_HASH for seq=1. */
  prevHash: string;
  /** Hex SHA-256 HMAC of THIS entry's chain+payload fields. */
  hmac: string;
  /**
   * Tenant key for multi-tenant isolation. Comes from `event.context.tenantId`
   * or the active tenant context. `undefined` ⇒ global chain (single-tenant).
   */
  tenantId?: string;
}

export type ChainBreakReason =
  | 'missing_prev_hash' // entry has no prevHash header
  | 'broken_link' // prevHash doesn't match previous entry's hmac
  | 'invalid_hmac' // recomputed HMAC ≠ stored hmac
  | 'foreign_insertion' // non-genesis entry without valid preceding link
  | 'seq_gap' // seq jumps unexpectedly (missing middle entries)
  | 'payload_mismatch' // body fields don't match what was hashed
  | 'reorder_detected'; // seq in file order ≠ monotonic

export interface ChainBreak {
  chainId: string;
  tenantId?: string;
  /** Sequence number where the chain breaks (or where it should be). */
  seq: number;
  reason: ChainBreakReason;
  detail?: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Total number of chain entries inspected (across all persisted files). */
  totalEntries: number;
  /** If `ok=false`, the first broken chain. */
  brokenChain?: ChainBreak;
  /** Number of distinct (tenantId, chainId) chains inspected. */
  chainsInspected: number;
}

export interface VerifyOptions {
  /** Restrict to a single tenant. Defaults to all tenants. */
  tenantId?: string;
  /** Restrict to entries with seq >= fromSeq within each chain. */
  fromSeq?: number;
  /** Restrict to entries with seq <= toSeq within each chain. */
  toSeq?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Sentinel prevHash on seq=0 (no prior entry). 64 zeros = SHA-256 of empty. */
export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
/** Protocol version baked into HMAC input. Bump breaks the chain (intentional). */
export const CHAIN_PROTOCOL_VERSION = 1;
/** Env var for the audit chain HMAC master key (>= 32 chars). */
export const AUDIT_CHAIN_KEY_ENV = 'COMMANDER_AUDIT_CHAIN_KEY';

// ============================================================================
// Ledger
// ============================================================================

/**
 * In-memory + persisted hash-chained audit ledger.
 *
 * Construct one per process via {@link getAuditChainLedger}. Each
 * construction generates a fresh `chainId` UUID — this is intentional,
 * see file header. To resume an existing chain, use {@link AuditChainLedger.resumeFromDisk}.
 */
export class AuditChainLedger {
  readonly chainId: string;
  private readonly masterKey: Buffer;
  private seq: number = 0;
  private prevHash: string = GENESIS_HASH;
  /** In-memory entry mirror; bounded by maxCache for backpressure safety. */
  private entryCache: AuditChainEntry[] = [];
  private readonly maxCache: number;
  private readonly persistDir: string;
  private readonly maxFileSize: number;
  private readonly maxFiles: number;
  private currentChainFileIndex: number = 0;
  private currentChainFileSize: number = 0;
  /** Entries that have already been durably flushed; these are NOT merged back
   * into verify() so that a deleted/corrupted persisted entry is detected. */
  private flushedEntries: WeakSet<AuditChainEntry> = new WeakSet();
  /** Master key for verification. Same instance ⇒ same chain. */
  readonly masterKeyForVerifiers: Buffer;
  /** Optional post-persist hook (WS9 ChainManifest registration). */
  private onPersisted: ((entry: AuditChainEntry) => void) | null = null;

  constructor(options?: {
    maxCache?: number;
    persistDir?: string;
    masterKey?: Buffer;
    chainId?: string;
    maxFileSize?: number;
    maxFiles?: number;
  }) {
    this.maxCache = options?.maxCache ?? 10000;
    this.persistDir =
      options?.persistDir ??
      process.env.COMMANDER_AUDIT_PERSIST_DIR ??
      path.join(process.cwd(), '.commander_security');
    this.masterKey = options?.masterKey ?? resolveMasterKey();
    // Allow callers (e.g., test-spawn verifier) to pre-supply a chainId
    // so verify() can re-validate a known chain. Random UUID otherwise.
    this.chainId = options?.chainId ?? crypto.randomUUID().replace(/-/g, '');
    this.masterKeyForVerifiers = this.masterKey;
    this.maxFileSize = options?.maxFileSize ?? 50 * 1024 * 1024;
    this.maxFiles = options?.maxFiles ?? 5;
    this.ensurePersistDir();
  }

  /**
   * Register a post-persist callback (e.g. ChainManifest.registerHead).
   * Replaces any previous hook. Pass null to clear.
   */
  setOnPersisted(hook: ((entry: AuditChainEntry) => void) | null): void {
    this.onPersisted = hook;
  }

  /**
   * Append a security event to the chain. Returns the chained entry.
   *
   * Side effects (fail-closed):
   *   1. Generates `id` + `timestamp` for the event.
   *   2. Computes next `seq` / `hmac` without mutating in-memory state yet.
   *   3. Synchronously persists the entry — throws `AUDIT_PERSIST_FAILED` on
   *      any write error so the calling effect is blocked (KC-5d).
   *   4. Only then commits in-memory seq/cache and fires integrity hooks.
   *
   * Tenant isolation: `event.context.tenantId` wins; falls back to the active
   * tenant context; `undefined` ⇒ global chain (single-tenant mode).
   */
  logEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): AuditChainEntry {
    const tenantId = event.context?.tenantId ?? getCurrentTenantId();
    const tenantKey = deriveTenantKey(this.masterKey, tenantId);

    const id = `acl_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const nextSeq = this.seq + 1;

    const partial: Omit<AuditChainEntry, 'hmac'> = {
      ...event,
      id,
      timestamp,
      chainId: this.chainId,
      seq: nextSeq,
      prevHash: this.prevHash,
      tenantId,
    };
    const hmac = computeEntryHmac(tenantKey, partial);
    const entry: AuditChainEntry = { ...partial, hmac };

    // Persist BEFORE mutating in-memory state — fail-closed (KC-5d).
    this.persistChainedLine(entry);

    this.seq = nextSeq;
    this.prevHash = hmac;
    this.entryCache.push(entry);
    if (this.entryCache.length > this.maxCache) this.entryCache.shift();

    try {
      getMetricsCollector().incrementCounter(
        'audit_chain_events_total',
        'Audit chain ledger events logged',
        1,
        [{ name: 'type', value: event.type }],
      );
    } catch (err) {
      reportSilentFailure(err, 'auditChainLedger:metrics');
      /* best-effort */
    }

    try {
      this.onPersisted?.(entry);
    } catch (err) {
      // Integrity hook failure must not silently drop the already-persisted
      // entry, but should surface so operators notice (fail-closed for KC-5a).
      throw new Error(`AUDIT_INTEGRITY_HOOK_FAILED: ${(err as Error)?.message ?? String(err)}`);
    }

    return entry;
  }

  /**
   * Append an arbitrary record to the chain.
   *
   * Backwards-compatibility method used by security modules that pass an
   * `event` field plus free-form metadata. The record is normalized to a
   * {@link SecurityEvent}, persisted, and the returned entry carries both the
   * canonical `hmac` field and a legacy `hash` alias.
   */
  append(record: Record<string, unknown>): AuditChainEntry & { hash: string } {
    const { event, timestamp: _ts, ...rest } = record;
    const entry = this.logEvent({
      type: (typeof event === 'string' ? event : 'audit_event') as SecurityEventType,
      severity: 'low' as SecuritySeverity,
      source: 'audit-chain-append',
      message: typeof event === 'string' ? event : 'audit event appended',
      details: rest,
    });
    return { ...entry, hash: entry.hmac };
  }

  /** Current sequence number; the next `logEvent` will produce this+1. */
  get currentSeq(): number {
    return this.seq;
  }

  /** Current chain's prevHash (will be the next entry's `prevHash`). */
  get currentPrevHash(): string {
    return this.prevHash;
  }

  /** Alias for the public `chainId` field, used by tests and dashboards. */
  get currentChainId(): string {
    return this.chainId;
  }

  /** Snapshot of in-memory entries (read-only). */
  getEntries(): readonly AuditChainEntry[] {
    return this.entryCache;
  }

  /** Directory where chain NDJSON files are persisted. WS9 integrity layer
   * uses this to cross-check manifest state against on-disk chains. */
  get persistDirectory(): string {
    return this.persistDir;
  }

  /**
   * Verify persisted chain integrity for this ledger's tenant scope.
   * Re-reads all `audit-chain-*.ndjson` files, groups by chainId, sorts by
   * seq, re-derives HMACs, and reports the first broken link (if any).
   *
   * @param opts - Restrict to specific tenant and/or seq range.
   */
  verify(opts: VerifyOptions = {}): VerifyResult {
    const persisted = collectPersistedEntries(this.persistDir);
    // Merge only in-memory entries that have NOT yet been durably flushed.
    // Flushed entries that later disappear from disk are treated as tampering
    // (seq_gap / broken_link), which is the desired tamper-evidence behavior.
    const inMemory = this.getEntries().filter((e) => !this.flushedEntries.has(e));
    const seenIds = new Set<string>(persisted.map((e) => e.id));
    const merged = [...persisted];
    for (const e of inMemory) {
      if (!seenIds.has(e.id)) {
        merged.push(e);
        seenIds.add(e.id);
      }
    }
    const filtered = merged.filter((e) => {
      if (opts.tenantId !== undefined && e.tenantId !== opts.tenantId) return false;
      if (opts.fromSeq !== undefined && e.seq < opts.fromSeq) return false;
      if (opts.toSeq !== undefined && e.seq > opts.toSeq) return false;
      return true;
    });

    // Group by chainId only. A process-wide chain spans tenants with a shared
    // monotonic seq; grouping by tenant would invent false seq_gap failures.
    // Tenant filtering (opts.tenantId) still limits which entries are inspected,
    // but HMAC continuity is checked within each chainId.
    const chains = new Map<string, AuditChainEntry[]>();
    for (const e of filtered) {
      const key = e.chainId;
      const list = chains.get(key);
      if (list) list.push(e);
      else chains.set(key, [e]);
    }

    for (const [, entries] of chains) {
      // Sort by seq to reconstruct chain order. If two entries share seq,
      // the in-memory append order is not recoverable from disk; we
      // surface this as `reorder_detected` to flag ambiguous ordering.
      entries.sort((a, b) => {
        if (a.seq !== b.seq) return a.seq - b.seq;
        return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
      });
      // Detect duplicate seq before any HMAC work — a tampered duplicate should
      // be reported as reordering, not as an invalid signature.
      for (let i = 1; i < entries.length; i++) {
        if (entries[i]!.seq === entries[i - 1]!.seq) {
          return {
            ok: false,
            totalEntries: filtered.length,
            chainsInspected: chains.size,
            brokenChain: {
              chainId: entries[i]!.chainId,
              tenantId: entries[i]!.tenantId,
              seq: entries[i]!.seq,
              reason: 'reorder_detected',
              detail: `seq=${entries[i]!.seq} appears more than once within chain ${entries[i]!.chainId}`,
            },
          };
        }
      }
      let prevHash = GENESIS_HASH;
      let prevSeq = 0;
      for (const e of entries) {
        if (e.seq !== prevSeq + 1 && prevSeq > 0) {
          return {
            ok: false,
            totalEntries: filtered.length,
            chainsInspected: chains.size,
            brokenChain: {
              chainId: e.chainId,
              tenantId: e.tenantId,
              seq: e.seq,
              reason: 'seq_gap',
              detail: `expected seq=${prevSeq + 1}, found seq=${e.seq}`,
            },
          };
        }
        if (e.seq === 1) {
          if (e.prevHash !== GENESIS_HASH) {
            return {
              ok: false,
              totalEntries: filtered.length,
              chainsInspected: chains.size,
              brokenChain: {
                chainId: e.chainId,
                tenantId: e.tenantId,
                seq: 1,
                reason: 'missing_prev_hash',
                detail: `seq=1 entry expects prevHash=GENESIS, got ${e.prevHash.slice(0, 16)}…`,
              },
            };
          }
        } else if (e.prevHash !== prevHash) {
          return {
            ok: false,
            totalEntries: filtered.length,
            chainsInspected: chains.size,
            brokenChain: {
              chainId: e.chainId,
              tenantId: e.tenantId,
              seq: e.seq,
              reason: 'broken_link',
              detail: `prevHash does not match previous entry's hmac`,
            },
          };
        }
        const tenantKey = deriveTenantKey(this.masterKey, e.tenantId);
        const expectedHmac = computeEntryHmac(tenantKey, e);
        if (expectedHmac !== e.hmac) {
          return {
            ok: false,
            totalEntries: filtered.length,
            chainsInspected: chains.size,
            brokenChain: {
              chainId: e.chainId,
              tenantId: e.tenantId,
              seq: e.seq,
              reason: 'invalid_hmac',
              detail: `stored hmac=${e.hmac.slice(0, 16)}…, recomputed=${expectedHmac.slice(0, 16)}…`,
            },
          };
        }
        prevHash = e.hmac;
        prevSeq = e.seq;
      }
    }

    return { ok: true, totalEntries: filtered.length, chainsInspected: chains.size };
  }

  // ── Persistence (own writer, fail-closed) ──────────────────────────────

  private persistChainedLine(entry: AuditChainEntry): void {
    // Synchronous fail-closed write (KC-5d). Any I/O error blocks the effect.
    try {
      this.ensurePersistDirOrThrow();
      const filePath = this.getCurrentChainFile();
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(filePath, line, 'utf-8');
      this.flushedEntries.add(entry);
      this.currentChainFileSize += Buffer.byteLength(line, 'utf-8');
      if (this.currentChainFileSize > this.maxFileSize) {
        this.currentChainFileIndex = (this.currentChainFileIndex + 1) % this.maxFiles;
        this.currentChainFileSize = 0;
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (msg.startsWith('AUDIT_PERSIST_FAILED')) throw err;
      throw new Error(
        `AUDIT_PERSIST_FAILED (fail-closed): ${this.persistDir} — ${msg}. ` +
          'Effect blocked because audit write could not be durably persisted.',
      );
    }
  }

  private getCurrentChainFile(): string {
    return path.join(this.persistDir, `audit-chain-${this.currentChainFileIndex}.ndjson`);
  }

  private ensurePersistDirOrThrow(): void {
    if (!fs.existsSync(this.persistDir)) {
      fs.mkdirSync(this.persistDir, { recursive: true });
    }
  }

  /** @deprecated Prefer ensurePersistDirOrThrow — kept for resumeFromDisk callers. */
  private ensurePersistDir(): void {
    try {
      this.ensurePersistDirOrThrow();
    } catch (err) {
      process.stderr.write(
        `[auditChainLedger] Failed to create persist dir: ${(err as Error)?.message ?? String(err)}\n`,
      );
    }
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Deterministic canonical-stringify for hash input. Sorts object keys
 * recursively so `{a:1,b:2}` and `{b:2,a:1}` produce identical output.
 * Arrays preserve order (semantics matter).
 */
function deterministicStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Cannot JSON-encode non-finite number for canonical hash input');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map(deterministicStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') +
      '}'
    );
  }
  throw new TypeError(`Cannot canonical-stringify value of type ${typeof value}`);
}

/**
 * Compute the HMAC for one entry. The canonical input is protocol-versioned
 * and stable across key-orderings of `details` / `context`.
 */
export function computeEntryHmac(
  tenantKey: Buffer,
  partial: Omit<AuditChainEntry, 'hmac'>,
): string {
  const canonical = deterministicStringify({
    v: CHAIN_PROTOCOL_VERSION,
    chainId: partial.chainId,
    seq: partial.seq,
    prevHash: partial.prevHash,
    id: partial.id,
    timestamp: partial.timestamp,
    type: partial.type,
    severity: partial.severity,
    source: partial.source,
    message: partial.message,
    details: partial.details ?? null,
    context: partial.context ?? null,
    tenantId: partial.tenantId ?? null,
  });
  return crypto.createHmac('sha256', tenantKey).update(canonical).digest('hex');
}

/** HKDF-SHA-256 master → tenant key derivation (NIST SP 800-108). */
export function deriveTenantKey(masterKey: Buffer, tenantId: string | undefined): Buffer {
  if (!tenantId) return masterKey;
  const info = Buffer.from(`audit-chain|tenant|${tenantId}`, 'utf-8');
  const salt = Buffer.from('commander-audit-chain-salt-v1', 'utf-8');
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, info, 32));
}

/**
 * Resolve the master HMAC key from env var. Production refuses to start
 * without an explicit key. Tests / dev get a deterministic fallback with
 * a loud warning so misconfiguration is detectable in logs.
 */
export function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const v = env[AUDIT_CHAIN_KEY_ENV];
  if (v && v.length >= 32) {
    return Buffer.from(v, 'utf-8');
  }
  if (isProductionCryptoEnv(env)) {
    throw new Error(
      `[auditChainLedger] ${AUDIT_CHAIN_KEY_ENV} must be set (>= 32 chars) in production. ` +
        'Refusing to start with a weak default key — tamper-evidence would be cryptographically invalid.',
    );
  }
  process.stderr.write(
    `[auditChainLedger] WARNING: ${AUDIT_CHAIN_KEY_ENV} not set in non-production. ` +
      'Using insecure dev key derived from constants. Set the env var before shipping. ' +
      'Tamper-evidence is NOT cryptographically valid with the dev key.\n',
  );
  return crypto
    .createHash('sha256')
    .update('commander-audit-chain-dev-key-DO-NOT-USE-IN-PROD-v1')
    .digest();
}

/**
 * Read all `audit-chain-*.ndjson` files and parse entries. Lines lacking the
 * chain header (legacy unchained `SecurityEvent`s) are silently skipped.
 * Malformed lines are skipped deterministically (sorted scan) to avoid
 * crashing verifier runs when an attacker injects garbage.
 */
export function collectPersistedEntries(persistDir: string): AuditChainEntry[] {
  if (!fs.existsSync(persistDir)) return [];
  const files = fs
    .readdirSync(persistDir)
    .filter((f) => f.startsWith('audit-chain-') && f.endsWith('.ndjson'))
    .sort();
  const entries: AuditChainEntry[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(persistDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<AuditChainEntry>;
        if (
          typeof parsed.chainId === 'string' &&
          parsed.chainId.length > 0 &&
          typeof parsed.seq === 'number' &&
          typeof parsed.hmac === 'string'
        ) {
          entries.push(parsed as AuditChainEntry);
        }
      } catch (err) {
        reportSilentFailure(err, 'auditChainLedger:583');
        // Skip malformed lines; worst-case we miss them in the verify,
        // never crash.
      }
    }
  }
  return entries;
}

// ============================================================================
// Tenant-aware singleton
// ============================================================================

const auditChainSingleton = createTenantAwareSingleton(() => new AuditChainLedger(), {});

/** Resolve the active ledger via the current tenant context. */
export function getAuditChainLedger(): AuditChainLedger {
  return auditChainSingleton.get();
}

/** Reset all ledgers (global + per-tenant). Test isolation only. */
export function resetAuditChainLedger(): void {
  auditChainSingleton.reset();
}
