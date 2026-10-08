import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const EXPECTED_TYPECHECK = 'tsc -p tsconfig.json --noEmit';
const CHILD_COMMAND = 'pnpm --filter @praetor/api run typecheck';

interface ApiTypecheckGatePorts {
  readApiManifest(): string;
  runTypecheck(): { status: number | null; stdout: string; stderr: string };
  write(value: string): void;
}

export function runApiTypecheckGate(ports: ApiTypecheckGatePorts): void {
  const manifest = JSON.parse(ports.readApiManifest()) as { scripts?: { typecheck?: unknown } };
  if (manifest.scripts?.typecheck !== EXPECTED_TYPECHECK) {
    throw new Error('API_TYPECHECK_SCRIPT_INVALID');
  }

  const result = ports.runTypecheck();
  if (result.stdout) ports.write(result.stdout);
  if (result.stderr) ports.write(result.stderr);
  ports.write(
    `COMMANDER_GATE_CHILD api-typecheck/v1 command="${CHILD_COMMAND}" exit=${result.status ?? 'null'}\n`,
  );
  if (result.status !== 0) {
    throw new Error('API_TYPECHECK_CHILD_FAILED');
  }
  ports.write('COMMANDER_GATE_EXECUTED api-typecheck/v1\n');
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  runApiTypecheckGate({
    readApiManifest: () => readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'),
    runTypecheck: () => {
      const result = spawnSync('pnpm', ['--filter', '@praetor/api', 'run', 'typecheck'], {
        cwd: root,
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    write: (value) => process.stdout.write(value),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
