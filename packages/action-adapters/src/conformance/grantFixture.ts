import type { CapabilityTokenIssuer } from '@praetor/effect-broker';

type ConformanceIssueInput = Parameters<CapabilityTokenIssuer['issue']>[0];

export const conformanceGrantIssueFields = Object.freeze({
  policySnapshotId: 'policy',
  workloadId: 'worker-1',
  nonce: 'nonce-conformance-chaos',
} as const satisfies Pick<ConformanceIssueInput, 'policySnapshotId' | 'workloadId' | 'nonce'>);

type ConformanceIssueOverrides = Omit<
  ConformanceIssueInput,
  keyof typeof conformanceGrantIssueFields
>;

export function buildConformanceIssueInput(): typeof conformanceGrantIssueFields;
export function buildConformanceIssueInput(
  overrides: ConformanceIssueOverrides,
): ConformanceIssueInput;
export function buildConformanceIssueInput(
  overrides?: ConformanceIssueOverrides,
): typeof conformanceGrantIssueFields | ConformanceIssueInput {
  // Always a fresh object: handing out the module-level fixture by reference let
  // one caller mutate every later caller's "expected" values, so a self-proving
  // test could drift its expectation along with the implementation.
  if (!overrides) return { ...conformanceGrantIssueFields };
  return { ...conformanceGrantIssueFields, ...overrides };
}
