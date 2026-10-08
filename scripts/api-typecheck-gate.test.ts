import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runApiTypecheckGate } from './api-typecheck-gate.js';

const expectedManifest = JSON.stringify({
  scripts: { typecheck: 'tsc -p tsconfig.json --noEmit' },
});

describe('API typecheck gate', () => {
  it('rejects a missing or changed API typecheck script before invoking pnpm', () => {
    let invoked = false;
    assert.throws(
      () =>
        runApiTypecheckGate({
          readApiManifest: () => JSON.stringify({ scripts: {} }),
          runTypecheck: () => {
            invoked = true;
            return { status: 0, stdout: '', stderr: '' };
          },
          write: () => undefined,
        }),
      /API_TYPECHECK_SCRIPT_INVALID/,
    );
    assert.equal(invoked, false);
  });

  it('rejects pnpm no-script and no-project failures without printing the marker', () => {
    const output: string[] = [];
    assert.throws(
      () =>
        runApiTypecheckGate({
          readApiManifest: () => expectedManifest,
          runTypecheck: () => ({
            status: 1,
            stdout: '',
            stderr: 'ERR_PNPM_NO_SCRIPT_OR_SERVER No projects matched the filters',
          }),
          write: (value) => output.push(value),
        }),
      /API_TYPECHECK_CHILD_FAILED/,
    );
    assert.equal(
      output.some((value) => value.includes('COMMANDER_GATE_EXECUTED')),
      false,
    );
  });

  it('prints the execution marker only after the exact child command succeeds', () => {
    const output: string[] = [];
    runApiTypecheckGate({
      readApiManifest: () => expectedManifest,
      runTypecheck: () => ({ status: 0, stdout: 'typecheck ok\n', stderr: '' }),
      write: (value) => output.push(value),
    });
    assert.deepEqual(output, [
      'typecheck ok\n',
      'COMMANDER_GATE_CHILD api-typecheck/v1 command="pnpm --filter @praetor/api run typecheck" exit=0\n',
      'COMMANDER_GATE_EXECUTED api-typecheck/v1\n',
    ]);
  });
});
