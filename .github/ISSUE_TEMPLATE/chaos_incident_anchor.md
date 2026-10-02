---
name: Propose Chaos Incident Anchor
about: Propose a real-world production incident or fault scenario for the Chaos 255 benchmark
title: '[Chaos Anchor]: '
labels: benchmark, chaos, enhancement
assignees: ''
---

## Incident Anchor Overview

A concise summary of the real-world failure mode or production incident you want Commander to simulate.

## Source Inspiration / Reference

- Incident Postmortem / Outage Link: [e.g. Netflix, AWS, Cloudflare, Airbnb postmortem URL]
- CVE or Bug Report: [e.g. CVE-202X-XXXX, GitHub issue URL]
- Or Personal Production Experience: [Describe the production disaster without sensitive data]

## Fault Hierarchy Layer

- [ ] L1: LLM Provider Fault (e.g., 504 timeout, 429 rate limit, malformed JSON streaming, token truncation)
- [ ] L2: Tool Boundary Fault (e.g., HTTP 5xx, disk full, auth token expiry, socket hang, schema drift)
- [ ] L3: System & Runtime Fault (e.g., K8s OOMKilled, SIGKILL, DB pool drop, monotone lease expiry)
- [ ] L4: Multi-Tenant & Concurrency Fault (e.g., noisy neighbor, split-brain, cross-tenant leak)

## Failure Sequence & Reproduction

1. Step 1: Agent calls tool `...`
2. Step 2: Injected fault occurs `...`
3. Step 3: Raw / un-governed agent exhibits failure `[e.g., sends duplicate mutations, hangs indefinitely, exfiltrates data]`

## Expected Governed Defense

What should the Commander control plane do to survive and self-heal?
- [ ] Circuit Breaker transition (`CLOSED` → `OPEN` → `HALF-OPEN`)
- [ ] Preflight Idempotency Probe (query remote state before retry)
- [ ] SAGA reverse compensation execution
- [ ] DLQ capture with failure taxonomy tagging
- [ ] Ed25519 Capability rejection

## Proposed Assertions

List the deterministic assertions that should pass:
- `assertion_1: remote_mutation_count == 1`
- `assertion_2: recovery_time_ms < 5000`
- `assertion_3: data_isolation_maintained == true`
