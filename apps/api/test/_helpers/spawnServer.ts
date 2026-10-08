import { reportSilentFailure } from '@praetor/core';
import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as crypto from 'node:crypto';

interface ServerContext {
  baseUrl: string;
  serverProcess: ChildProcess;
  tmpDir: string;
  port: number;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr.port !== 'number') {
        srv.close();
        reject(new Error('Failed to allocate a free port'));
        return;
      }
      const { port: freePort } = addr;
      srv.close((err) => (err ? reject(err) : resolve(freePort)));
    });
    srv.on('error', reject);
  });
}

const STARTUP_TIMEOUT_MS = 10000;
const HEALTH_POLL_MS = 150;
const SPAWN_RETRY_ATTEMPTS = 4;
const STOP_CLOSE_TIMEOUT_MS = 2000;
const STDERR_HEAD_CHARS = 1500;
const STDERR_TAIL_CHARS = 1500;
const STDERR_USE_FULL_THRESHOLD_CHARS = STDERR_HEAD_CHARS + STDERR_TAIL_CHARS;
const SYNC_ERR_MESSAGE_MAX_CHARS = 500;

async function startServer(apiDir: string): Promise<ServerContext> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= SPAWN_RETRY_ATTEMPTS; attempt++) {
    const tmpDir = path.join(
      os.tmpdir(),
      `commander-test-${crypto.randomBytes(8).toString('hex')}-a${attempt}`,
    );
    fs.mkdirSync(path.join(tmpDir, '.commander_traces'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.commander', 'sagas'), { recursive: true });

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    let serverProcess: ChildProcess;
    try {
      serverProcess = spawn(process.execPath, [path.join(apiDir, 'dist', 'index.js')], {
        cwd: tmpDir,
        env: {
          ...process.env,
          PORT: String(port),
          JWT_SECRET:
            process.env.JWT_SECRET || 'spawned-api-test-jwt-secret-at-least-32-characters',
          ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'spawned-api-test-admin-password',
          AUTH_DISABLED: 'true',
          COMMANDER_ALLOW_ANON: '1',
          // Anon bypass needs a tenant ALS id (MemoryStoreFacade fails closed otherwise).
          COMMANDER_DEFAULT_TENANT_ID: process.env.COMMANDER_DEFAULT_TENANT_ID || 'test-tenant',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (syncErr: any) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        reportSilentFailure(err, 'spawnServer:66');
        /* best-effort */
      }
      if (syncErr.code === 'ENOENT' || syncErr.code === 'EACCES') {
        throw new Error(
          `spawn failure: cannot launch server binary (code=${syncErr.code}): ${truncateSyncErrMessage(syncErr.message)}`,
        );
      }
      lastError = `synchronous spawn failure: ${syncErr.message}`;
      continue;
    }

    let stderrBuf = '';
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
    });
    serverProcess.stdout?.on('data', () => {});

    const exited = new Promise<{ reason: string }>((resolve) => {
      serverProcess.once('exit', (code, signal) =>
        resolve({ reason: `exit code=${code} signal=${signal}` }),
      );
      serverProcess.once('error', (err) =>
        resolve({ reason: `child error event: ${err.message}` }),
      );
    });

    let healthyOrExit: any;
    try {
      healthyOrExit = await Promise.race([waitHealthy(baseUrl), exited]);
    } catch (pollErr) {
      healthyOrExit = pollErr;
    }

    if (healthyOrExit === 'healthy') {
      return { baseUrl, serverProcess, tmpDir, port };
    }

    const reason =
      healthyOrExit && healthyOrExit.reason
        ? healthyOrExit.reason
        : healthyOrExit instanceof Error
          ? healthyOrExit.message
          : String(healthyOrExit);
    const stderrSnippet = formatStderrSnippet(stderrBuf);
    lastError = stderrSnippet ? `${reason}\n-- child stderr --\n${stderrSnippet}` : reason;

    if (!serverProcess.killed) {
      try {
        serverProcess.kill('SIGKILL');
      } catch (err) {
        reportSilentFailure(err, 'spawnServer:117');
        /* best-effort */
      }
    }
    await new Promise<void>((resolve) => serverProcess.once('close', resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      reportSilentFailure(err, 'spawnServer:125');
      /* best-effort */
    }
  }
  throw new Error(`API server did not start after ${SPAWN_RETRY_ATTEMPTS} attempts: ${lastError}`);
}

function formatStderrSnippet(buf: string): string {
  const trimmed = buf.trim();
  if (!trimmed) return '';
  if (trimmed.length <= STDERR_USE_FULL_THRESHOLD_CHARS) return trimmed;
  const elided = trimmed.length - STDERR_USE_FULL_THRESHOLD_CHARS;
  return `${trimmed.slice(0, STDERR_HEAD_CHARS)}\n... [${elided} chars elided] ...\n${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}

function truncateSyncErrMessage(msg: string): string {
  if (typeof msg !== 'string' || msg.length <= SYNC_ERR_MESSAGE_MAX_CHARS) return msg;
  return `${msg.slice(0, SYNC_ERR_MESSAGE_MAX_CHARS)}... [${msg.length - SYNC_ERR_MESSAGE_MAX_CHARS} chars elided]`;
}

async function waitHealthy(baseUrl: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return 'healthy';
    } catch (err) {
      reportSilentFailure(err, 'spawnServer:152');
      /* not yet listening */
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`health timeout after ${STARTUP_TIMEOUT_MS}ms`);
}

async function stopServer(context: ServerContext | null): Promise<void> {
  if (context && context.serverProcess) {
    const child = context.serverProcess;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (viaTimer: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (viaTimer) {
          console.error(
            `[spawnServer] stopServer: child 'close' event did not fire within ${STOP_CLOSE_TIMEOUT_MS}ms, forcing cleanup (port=${context.port ?? 'unknown'} pid=${child.pid ?? 'unknown'})`,
          );
        }
        resolve();
      };
      child.once('close', () => finish(false));
      const timer = setTimeout(() => finish(true), STOP_CLOSE_TIMEOUT_MS);
      timer.unref();
      if (!child.killed && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch (err) {
          reportSilentFailure(err, 'spawnServer:183');
          finish(false);
        }
      } else {
        finish(false);
      }
    });
  }
  if (context && context.tmpDir) {
    try {
      fs.rmSync(context.tmpDir, { recursive: true, force: true });
    } catch (err) {
      reportSilentFailure(err, 'spawnServer:195');
      /* best-effort */
    }
  }
}

export { startServer, stopServer, ServerContext };
