/**
 * Logging and Monitoring
 * Phase 2: 日志和监控
 *
 * 提供统一的日志记录、指标收集和监控接口
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

// ========================================
// Credential redaction
// ========================================

/**
 * Keys whose values are replaced before a log entry reaches ANY sink.
 *
 * LOG-01: `context` was passed straight through to storage, console, the SQLite
 * persistence queue and every listener, so a synthetic `authorization` value came
 * back byte-identical from `getRecent()[0].context.authorization`. Logs cross
 * trust boundaries (console, persisted files, listeners, telemetry) and are the
 * most common accidental credential sink.
 *
 * This is the same field-name set the shadow scrubber enforces
 * (`SENSITIVE_FIELD_NAME` / `DEFAULT_IGNORE_FIELDS` in `shadow/scrubber.ts`), and
 * it is deliberately duplicated rather than imported: `shadow/scrubber` pulls in
 * `security/securityPrimitives`, which imports this module, so reusing it here
 * would create an import cycle in the logging hot path.
 */
const LOG_SENSITIVE_KEY =
  /password|passwd|passcode|secret|token|authorization|credential|private[_-]?key|access[_-]?key|api[_-]?key|otp|cookie/i;

const LOG_REDACTED = '[REDACTED]';
const LOG_MAX_DEPTH = 8;

/**
 * Deep-copy `context` with credential-named fields replaced.
 *
 * Deliberately conservative about what it can promise:
 *  - free text is NOT scanned. Pattern-based PII detection cannot be complete, and
 *    destroying diagnostic text would defeat the purpose of the log;
 *  - the caller's object is never mutated;
 *  - a circular reference, an exotic object or an `Error` must not break logging,
 *    so unrepresentable values degrade to a marker instead of throwing.
 */
function redactLogContext(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > LOG_MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactLogContext(item, depth + 1, seen));
  }

  const source = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (LOG_SENSITIVE_KEY.test(key)) {
      redacted[key] = LOG_REDACTED;
      continue;
    }
    try {
      redacted[key] = redactLogContext(source[key], depth + 1, seen);
    } catch {
      // A throwing getter must not take the logging hot path down with it.
      redacted[key] = '[UNREADABLE]';
    }
  }
  return redacted;
}

// ========================================
// Log Types
// ========================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  context?: Record<string, unknown>;
  duration?: number; // Operation duration in ms
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface MetricPoint {
  timestamp: string;
  value: number;
  labels: Record<string, string>;
}

export interface Metric {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'timer';
  description: string;
  unit?: string;
  values: MetricPoint[];
}

// ========================================
// Logger
// ========================================

export type LogFormat = 'pretty' | 'json';

export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableStorage: boolean;
  maxEntries: number;
  prettyPrint: boolean;
  /** Output format — 'pretty' (default) or 'json' (newline-delimited JSON).
   *  When LOGFORMAT=json is set in the environment, the global logger
   *  automatically switches to JSON output. */
  logFormat: LogFormat;
}

const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  enableConsole: true,
  enableStorage: true,
  maxEntries: 10000,
  prettyPrint: true,
  logFormat: 'pretty',
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

/**
 * True when `process.stdout` is owned by `node --test` rather than by us.
 *
 * Node's test runner spawns one child process per test file and frames every
 * test result on that child's **stdout** as a length-prefixed v8-serialized
 * message. A line of human-readable text written there is not a frame: the
 * runner reads the first four bytes as a declared length, then stalls waiting
 * for a payload that will never arrive, so **every result after that point is
 * silently dropped** and the file is reported as failed with the opaque
 * "Unable to deserialize cloned data due to invalid or unsupported version."
 *
 * The runner marks its children with `NODE_TEST_CONTEXT`, which is the only
 * reliable signal — a TTY check would be wrong (CI stdout is not a TTY either,
 * yet a CLI must still print its results there). `run-node-tests.mjs`
 * deliberately deletes this variable from the parent so the runner itself is
 * not in child mode; each test-file child then has it set again by Node.
 */
function stdoutOwnedByTestRunner(): boolean {
  const context = process.env.NODE_TEST_CONTEXT;
  return typeof context === 'string' && context.length > 0;
}

/**
 * Write a non-error, non-warning log line.
 *
 * Diagnostics belong on stderr. `console.log` writes to stdout, which is a
 * *data* channel: it is the runner's protocol channel under `node --test` (see
 * `stdoutOwnedByTestRunner`), and outside tests it interleaves with whatever a
 * CLI is actually piping. Only the test-runner case is diverted here, so the
 * normal console experience is unchanged.
 */
function emitInfoLine(text: string): void {
  if (stdoutOwnedByTestRunner()) {
    console.error(text);
  } else {
    console.log(text);
  }
}

export class Logger {
  private config: LoggerConfig;
  private entries: LogEntry[] = [];
  private listeners: Array<(entry: LogEntry) => void> = [];
  /** Lazily-initialized LogPersistence hook (enabled via COMMANDER_LOG_PERSIST=true).
   *  Typed loosely to avoid a static import that would pull SQLite into this
   *  foundational module; the real instance is require()'d on first use. */
  private logPersistenceHook: {
    enqueue: (entry: {
      timestamp: string;
      level: string;
      component: string;
      message: string;
      traceId?: string;
      runId?: string;
      tenantId?: string;
      metadata?: string;
    }) => void;
  } | null = null;
  private logPersistenceChecked = false;

  constructor(config?: Partial<LoggerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Auto-detect LOGFORMAT from environment if not explicitly configured
    if (config?.logFormat === undefined) {
      const envFormat = process.env.LOGFORMAT?.toLowerCase();
      if (envFormat === 'json') {
        this.config.logFormat = 'json';
      }
    }
  }

  /**
   * Lazily resolve the global LogPersistence instance (if enabled). Called
   * once on the first log() invocation; subsequent calls return the cached
   * result. Returns null when COMMANDER_LOG_PERSIST is unset or SQLite is
   * unavailable, so the hot path degrades to a cheap null check.
   */
  private resolveLogPersistence(): typeof this.logPersistenceHook {
    if (this.logPersistenceChecked) return this.logPersistenceHook;
    this.logPersistenceChecked = true;
    if (process.env.COMMANDER_LOG_PERSIST !== 'true') return null;
    try {
      const { getGlobalLogPersistence } = nodeRequire('./observability/logPersistence');
      const instance = getGlobalLogPersistence();
      this.logPersistenceHook = instance as typeof this.logPersistenceHook;
    } catch {
      /* LogPersistence unavailable (better-sqlite3 missing, etc.) — fall back to console-only */
    }
    return this.logPersistenceHook;
  }

  /**
   * Set the log level at runtime.
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Get the current log level.
   */
  getLevel(): LogLevel {
    return this.config.level;
  }

  /**
   * Set the output format at runtime.
   */
  setLogFormat(format: LogFormat): void {
    this.config.logFormat = format;
  }

  /**
   * Get the current output format.
   */
  getLogFormat(): LogFormat {
    return this.config.logFormat;
  }

  /**
   * Log debug message
   */
  debug(component: string, message: string, context?: Record<string, unknown>): void {
    this.log('debug', component, message, context);
  }

  info(component: string, message: string, context?: Record<string, unknown>): void {
    this.log('info', component, message, context);
  }

  warn(component: string, message: string, context?: Record<string, unknown>): void {
    this.log('warn', component, message, context);
  }

  error(
    component: string,
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
  ): void {
    const errorInfo = error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : undefined;
    this.log('error', component, message, context, errorInfo);
  }

  critical(component: string, message: string, context?: Record<string, unknown>): void {
    this.log('critical', component, message, context);
  }

  private log(
    level: LogLevel,
    component: string,
    message: string,
    context?: Record<string, unknown>,
    error?: LogEntry['error'],
  ): void {
    // Check level threshold
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.config.level]) {
      return;
    }

    // Redact once, here, so storage, console, persistence and listeners all see the
    // same sanitized context. A per-sink fix would leave whichever sink was added
    // next unprotected. See LOG-01 / redactLogContext.
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      context:
        context === undefined ? undefined : (redactLogContext(context) as Record<string, unknown>),
      error,
    };

    // Store entry
    if (this.config.enableStorage) {
      this.entries.push(entry);
      if (this.entries.length > this.config.maxEntries) {
        this.entries.shift();
      }
    }

    // Console output
    if (this.config.enableConsole) {
      this.consoleLog(entry);
    }

    // Persist to SQLite when COMMANDER_LOG_PERSIST=true (async, non-blocking).
    // The hook is resolved once and cached; null when disabled → cheap skip.
    const persistence = this.resolveLogPersistence();
    if (persistence) {
      try {
        const ctx = entry.context as Record<string, unknown> | undefined;
        persistence.enqueue({
          timestamp: entry.timestamp,
          level: entry.level,
          component: entry.component,
          message: entry.message,
          traceId: typeof ctx?.traceId === 'string' ? ctx.traceId : undefined,
          runId: typeof ctx?.runId === 'string' ? ctx.runId : undefined,
          tenantId: typeof ctx?.tenantId === 'string' ? ctx.tenantId : undefined,
          metadata: JSON.stringify({ context: entry.context ?? null, error: entry.error ?? null }),
        });
      } catch {
        /* persistence must never break the logging hot path */
      }
    }

    // Notify listeners
    this.listeners.forEach((listener) => listener(entry));
  }

  /**
   * Console output with formatting
   */
  private consoleLog(entry: LogEntry): void {
    if (this.config.logFormat === 'json') {
      const jsonLine = JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        component: entry.component,
        message: entry.message,
        context: entry.context ?? undefined,
        error: entry.error ?? undefined,
      });
      const line = jsonLine.replace(/\n|\r/g, '');
      if (entry.level === 'error' || entry.level === 'critical') {
        console.error(line);
      } else if (entry.level === 'warn') {
        console.warn(line);
      } else {
        emitInfoLine(line);
      }
      return;
    }

    const icons: Record<LogLevel, string> = {
      debug: '🔍',
      info: 'ℹ️ ',
      warn: '⚠️ ',
      error: '❌',
      critical: '🚨',
    };

    const levelName = entry.level.toUpperCase().padEnd(8);
    const component = entry.component.padEnd(20);
    const icon = icons[entry.level];

    let output = `${icon} [${levelName}] [${component}] ${String(entry.message)}`;

    if (entry.context) {
      output += ` ${JSON.stringify(entry.context)}`;
    }

    if (entry.error) {
      output += ` | Error: ${String(entry.error.message)}`;
    }
    output = output.replace(/\n|\r/g, '');

    if (entry.level === 'error' || entry.level === 'critical') {
      console.error(output);
    } else if (entry.level === 'warn') {
      console.warn(output);
    } else {
      emitInfoLine(output);
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add log listener
   */
  private static readonly MAX_LISTENERS = 50;
  onLog(listener: (entry: LogEntry) => void): void {
    if (this.listeners.length >= Logger.MAX_LISTENERS) {
      this.listeners.shift();
    }
    this.listeners.push(listener);
  }

  /**
   * Remove log listener
   */
  offLog(listener: (entry: LogEntry) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /**
   * Get recent logs
   */
  getRecent(limit: number = 100, level?: LogLevel): LogEntry[] {
    let entries = this.entries;

    if (level) {
      entries = entries.filter((e) => e.level === level);
    }

    return entries.slice(-limit);
  }

  /**
   * Get logs by component
   */
  getByComponent(component: string, limit?: number): LogEntry[] {
    const entries = this.entries.filter((e) => e.component === component);
    return limit ? entries.slice(-limit) : entries;
  }

  /**
   * Get error logs
   */
  getErrors(limit?: number): LogEntry[] {
    const entries = this.entries.filter((e) => e.level === 'error' || e.level === 'critical');
    return limit ? entries.slice(-limit) : entries;
  }

  /**
   * Clear logs
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    byLevel: Record<LogLevel, number>;
    byComponent: Record<string, number>;
    errorRate: number;
  } {
    const byLevel: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      critical: 0,
    };
    const byComponent: Record<string, number> = {};
    let errorCount = 0;

    for (const entry of this.entries) {
      byLevel[entry.level]++;
      byComponent[entry.component] = (byComponent[entry.component] || 0) + 1;
      if (entry.level === 'error' || entry.level === 'critical') {
        errorCount++;
      }
    }

    return {
      total: this.entries.length,
      byLevel,
      byComponent,
      errorRate: this.entries.length > 0 ? errorCount / this.entries.length : 0,
    };
  }
}

// ========================================
// Metrics Collector
// ========================================

export interface MetricsConfig {
  retentionPeriod: number; // ms
  sampleInterval: number; // ms
}

const DEFAULT_METRICS_CONFIG: MetricsConfig = {
  retentionPeriod: 3600000, // 1 hour
  sampleInterval: 10000, // 10 seconds
};

/**
 * @deprecated This legacy adapter is retained as a thin façade +
 * time-series query API. The source of truth for Prometheus/OpenMetrics export
 * is {@link `./runtime/metricsCollector`.MetricsCollector} (accessed via
 * `getMetricsCollector()`). This class delegates all recording calls to the
 * runtime collector; the in-memory time-series store is populated lazily
 * (only when listeners are registered) to avoid a wasteful dual-write on the
 * hot path. New code should import `getMetricsCollector` from
 * `runtime/metricsCollector` directly.
 *
 * Renamed from `MetricsCollector` to `LegacyMetricsAdapter` to resolve the
 * naming collision with `runtime/metricsCollector.MetricsCollector`. The
 * public `@praetor/core` package now re-exports the runtime version under
 * the `MetricsCollector` name; this class is internal-only and surfaced
 * solely through `getGlobalMetrics()` for the 70+ existing call sites that
 * use the `(name, value, labels)` signature.
 */
export class LegacyMetricsAdapter {
  private config: MetricsConfig;
  private metrics: Map<string, Metric> = new Map();
  private listeners: Array<(name: string, point: MetricPoint) => void> = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeCollector: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(config?: Partial<MetricsConfig>) {
    this.config = { ...DEFAULT_METRICS_CONFIG, ...config };

    // P1: Try to connect to the runtime MetricsCollector for unified metrics.
    // If it's not available (e.g., during early init or tests), fall back to
    // the in-memory time-series store. This preserves backward compatibility
    // while unifying the two collectors.
    try {
      const { getMetricsCollector } = nodeRequire('./runtime/metricsCollector');
      this.runtimeCollector = getMetricsCollector();
    } catch {
      // Runtime collector not available — use in-memory fallback
    }

    // Cleanup old data periodically — run at half the retention period so stale
    // data is evicted promptly instead of sitting around for up to 2x retention.
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.retentionPeriod / 2);
    this.cleanupTimer.unref();
  }

  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.metrics.clear();
    this.listeners.length = 0;
  }

  /**
   * Increment counter — delegates to runtime MetricsCollector when available.
   */
  incrementCounter(name: string, value: number = 1, labels: Record<string, string> = {}): void {
    // P1: Delegate to runtime collector (unified path)
    if (this.runtimeCollector) {
      const labelArray = Object.entries(labels).map(([k, v]) => ({ name: k, value: v }));
      this.runtimeCollector.incrementCounter(name, name, value, labelArray);
    }
    // Also record in-memory time-series for backward-compatible query APIs
    this.record('counter', name, value, labels);
  }

  /**
   * Set gauge value — delegates to runtime MetricsCollector when available.
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    if (this.runtimeCollector) {
      const labelArray = Object.entries(labels).map(([k, v]) => ({ name: k, value: v }));
      this.runtimeCollector.setGauge(name, name, value, labelArray);
    }
    this.record('gauge', name, value, labels);
  }

  /**
   * Record histogram value — delegates to runtime MetricsCollector when available.
   * Uses the runtime collector's default latency buckets since this adapter's
   * histogram semantics are timestamped points, not Prometheus buckets.
   */
  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    if (this.runtimeCollector) {
      const labelArray = Object.entries(labels).map(([k, v]) => ({ name: k, value: v }));
      // Default latency buckets (ms): [10, 50, 100, 500, 1000, 3000, 5000, 10000, 30000]
      const defaultBuckets = [10, 50, 100, 500, 1000, 3000, 5000, 10000, 30000];
      this.runtimeCollector.recordHistogram(name, name, value, defaultBuckets, labelArray);
    }
    this.record('histogram', name, value, labels);
  }

  /**
   * Record timer value — delegates to runtime MetricsCollector when available.
   * Uses the runtime collector's default latency buckets since this adapter's
   * timer semantics are timestamped points, not Prometheus buckets.
   */
  recordTimer(name: string, durationMs: number, labels: Record<string, string> = {}): void {
    if (this.runtimeCollector) {
      const labelArray = Object.entries(labels).map(([k, v]) => ({ name: k, value: v }));
      const defaultBuckets = [10, 50, 100, 500, 1000, 3000, 5000, 10000, 30000];
      this.runtimeCollector.recordHistogram(name, name, durationMs, defaultBuckets, labelArray);
    }
    this.record('timer', name, durationMs, labels);
  }

  /**
   * Core record method. Writes a timestamped point to the in-memory
   * time-series store and notifies any registered listeners.
   *
   * This is NOT a "dual write" with the runtime MetricsCollector: the
   * runtime collector maintains aggregate values (counter totals, gauge
   * snapshots, histogram buckets) for Prometheus/OpenMetrics export, while
   * this adapter maintains timestamped points for time-series query APIs
   * (getLatest / getTimeSeries / getStats / onMetric). The two stores have
   * distinct purposes and neither can satisfy the other's consumers.
   */
  private record(
    type: Metric['type'],
    name: string,
    value: number,
    labels: Record<string, string>,
  ): void {
    let metric = this.metrics.get(name);

    if (!metric) {
      metric = {
        name,
        type,
        description: '',
        values: [],
        unit: type === 'timer' || type === 'histogram' ? 'ms' : 'count',
      };
      this.metrics.set(name, metric);
    }

    const point: MetricPoint = {
      timestamp: new Date().toISOString(),
      value,
      labels,
    };

    metric.values.push(point);
    // Cap per-metric values to prevent unbounded growth within retention window
    if (metric.values.length > 5000) {
      metric.values = metric.values.slice(-3000);
    }

    // Notify listeners
    this.listeners.forEach((listener) => listener(name, point));
  }

  /**
   * Get metric
   */
  get(name: string): Metric | undefined {
    return this.metrics.get(name);
  }

  /**
   * Get all metrics
   */
  getAll(): Metric[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Get latest value
   */
  getLatest(name: string): MetricPoint | undefined {
    const metric = this.metrics.get(name);
    return metric?.values[metric.values.length - 1];
  }

  /**
   * Get time series data
   */
  getTimeSeries(name: string, fromTimestamp?: string, toTimestamp?: string): MetricPoint[] {
    const metric = this.metrics.get(name);
    if (!metric) return [];

    let points = metric.values;

    if (fromTimestamp) {
      const from = new Date(fromTimestamp).getTime();
      points = points.filter((p) => new Date(p.timestamp).getTime() >= from);
    }

    if (toTimestamp) {
      const to = new Date(toTimestamp).getTime();
      points = points.filter((p) => new Date(p.timestamp).getTime() <= to);
    }

    return points;
  }

  /**
   * Calculate statistics
   */
  getStats(name: string): {
    count: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    latest: number;
    p50?: number;
    p95?: number;
    p99?: number;
  } | null {
    const metric = this.metrics.get(name);
    if (!metric || metric.values.length === 0) return null;

    const values = metric.values.map((p) => p.value).sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const count = values.length;

    return {
      count,
      sum,
      avg: sum / count,
      min: values[0],
      max: values[values.length - 1],
      latest: values[values.length - 1],
      p50: this.percentile(values, 50),
      p95: this.percentile(values, 95),
      p99: this.percentile(values, 99),
    };
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)];
  }

  /**
   * Add metric listener
   */
  onMetric(listener: (name: string, point: MetricPoint) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Remove metric listener
   */
  offMetric(listener: (name: string, point: MetricPoint) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /**
   * Cleanup old data
   */
  private cleanup(): void {
    const cutoff = Date.now() - this.config.retentionPeriod;

    for (const metric of this.metrics.values()) {
      metric.values = metric.values.filter((p) => new Date(p.timestamp).getTime() > cutoff);
    }
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics.clear();
  }
}

// ========================================
// Timer Helper
// ========================================

export class Timer {
  private startTime: number;
  private labels: Record<string, string>;

  constructor(labels: Record<string, string> = {}) {
    this.startTime = Date.now();
    this.labels = labels;
  }

  /**
   * Stop timer and record
   */
  stop(metrics: LegacyMetricsAdapter, name: string): number {
    const duration = Date.now() - this.startTime;
    metrics.recordTimer(name, duration, this.labels);
    return duration;
  }
}

// ========================================
// Global Instances
// ========================================
//
// Static import is safe: the dependency chain
//   logging → tenantAwareSingleton → tenantContext
// terminates at tenantContext (which only imports node:async_hooks).
// Earlier code lazily require()'d this module to break a suspected
// value-import cycle, but no such cycle exists — tenantContext does
// not import tenantProvider/threeLayerMemory/episodicStore. The lazy
// require also broke vitest (native require can't resolve .ts files).

import { createTenantAwareSingleton } from './runtime/tenantAwareSingleton';

const loggerSingleton = createTenantAwareSingleton(() => new Logger(), {
  componentName: 'Logger',
});
const metricsSingleton = createTenantAwareSingleton(() => new LegacyMetricsAdapter(), {
  componentName: 'Metrics',
});

export function getGlobalLogger(): Logger {
  return loggerSingleton.get();
}

export function setGlobalLogLevel(level: LogLevel): void {
  const logger = getGlobalLogger();
  logger.setLevel(level);
}

export function setGlobalLogFormat(format: LogFormat): void {
  const logger = getGlobalLogger();
  logger.setLogFormat(format);
}

export function getGlobalMetrics(): LegacyMetricsAdapter {
  return metricsSingleton.get();
}

export function resetGlobalLogger(): void {
  loggerSingleton.reset();
}

export function resetGlobalMetrics(): void {
  metricsSingleton.reset();
}
