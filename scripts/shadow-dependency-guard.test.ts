import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateShadowDependencyClosure } from './shadow-dependency-guard.js';

describe('Shadow Phase A dependency guard', () => {
  it('enforces the explicit allowlist across direct and transitive production dependencies', () => {
    const intended = {
      '@praetor/shadow-plane': {
        dependencies: {
          '@praetor/contracts': 'workspace:*',
          '@praetor/postgres-runtime': 'workspace:*',
          'json-canonicalize': '3.0.0',
          pg: '^8.15.0',
        },
      },
      '@praetor/contracts': { dependencies: {} },
      '@praetor/postgres-runtime': { dependencies: { pg: '^8.15.0' } },
      'json-canonicalize': { dependencies: {} },
      pg: { dependencies: {} },
    };
    assert.deepEqual(validateShadowDependencyClosure(intended), []);

    for (const forbidden of [
      '@praetor/core',
      '@praetor/worker-plane',
      '@praetor/action-adapters',
      '@praetor/effect-broker',
      '@praetor/provider-openai',
      'axios',
    ]) {
      const direct = structuredClone(intended);
      direct['@praetor/shadow-plane']!.dependencies![forbidden] = '1.0.0';
      assert.ok(validateShadowDependencyClosure(direct).some((issue) => issue.includes(forbidden)));

      const transitive = structuredClone(intended);
      transitive['@praetor/contracts']!.dependencies![forbidden] = '1.0.0';
      assert.ok(
        validateShadowDependencyClosure(transitive).some((issue) => issue.includes(forbidden)),
      );
    }
  });

  it('rejects uninspected leaves and forbidden optional and peer dependency edges', () => {
    assert.ok(
      validateShadowDependencyClosure({
        '@praetor/shadow-plane': { dependencies: { pg: '8' } },
      }).some((issue) => issue.includes('missing package manifest')),
    );
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.ok(
        validateShadowDependencyClosure({
          '@praetor/shadow-plane': { dependencies: { pg: '8' } },
          pg: { [field]: { axios: '1' } },
          axios: {},
        }).some((issue) => issue.includes('pg -> axios')),
      );
    }

    assert.ok(
      validateShadowDependencyClosure({
        '@praetor/shadow-plane': { dependencies: { pg: '8' } },
        pg: {
          peerDependencies: { '@praetor/worker-plane': '1' },
          peerDependenciesMeta: { '@praetor/worker-plane': { optional: true } },
        },
        '@praetor/worker-plane': {},
      }).some((issue) => issue.includes('pg -> @praetor/worker-plane')),
      'an installed optional peer is part of the inspected production closure',
    );

    assert.ok(
      validateShadowDependencyClosure({
        '@praetor/shadow-plane': {
          dependencies: {
            '@praetor/contracts': '1',
            '@praetor/postgres-runtime': '1',
          },
          resolvedDependencies: {
            '@praetor/contracts': 'contracts-node',
            '@praetor/postgres-runtime': 'postgres-node',
          },
        },
        'contracts-node': {
          dependencies: { pg: '8' },
          resolvedDependencies: { pg: 'pg-v1' },
        },
        'postgres-node': {
          dependencies: { pg: '8' },
          resolvedDependencies: { pg: 'pg-v2' },
        },
        'pg-v1': {},
        'pg-v2': { dependencies: { axios: '1' }, resolvedDependencies: { axios: 'axios-node' } },
        'axios-node': {},
      }).some((issue) => issue.includes('@praetor/postgres-runtime -> pg -> axios')),
      'distinct installed versions must retain distinct dependency closures',
    );
  });
});
