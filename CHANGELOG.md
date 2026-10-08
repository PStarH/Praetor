# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CHANGELOG.md, CODE_OF_CONDUCT.md, SECURITY.md for project governance
- Dependabot configuration for automated dependency updates
- Pull request template for consistent PR descriptions
- npm audit and test coverage checks in CI pipeline
- Architecture V2 packages: `@praetor/contracts`, `@praetor/kernel`, `@praetor/worker-plane`, `@praetor/effect-broker`, and `@praetor/adapter-ops`
- `docs/getting-started.md` quick-start guide

### Changed

- All publishable packages now declare `main`, `module`, `types`, `exports`, `files`, `publishConfig`, and `prepublishOnly`
- `@praetor/sdk` and `@praetor/plugin-sdk` versioned to `0.2.0` to align with the rest of the monorepo
- `@praetor/contracts` versioned to `0.2.0` to stay consistent with sibling V2 packages

### Security

- CD pipeline now generates random API key on first deploy instead of using example default
- Post-deploy smoke tests validate health, status, and OpenAPI endpoints

### Added (v0.2.1-pre)

- **SQLite persistence**: `SqliteWarRoomStore` with WAL mode, 9 indexes, transaction safety
  - Enable with `WARROOM_STORAGE=sqlite` environment variable
  - `createWarRoomStore()` factory for transparent storage switching
- **Prettier + EditorConfig**: Code formatting enforced in CI
- **Staging environment**: CD pipeline deploys to staging before production
- **260+ new unit tests** across 15 test files covering:
  - Sandbox: `execPolicy`, `lane`
  - Ultimate: `deliberation`
  - Memory: `userModel`, `jsonStore`, `curator`
  - Plugin: `pluginManager`
  - Orchestration: `taskPool`
  - Runtime: `capabilityMatcher`, `executionTrace`, `messageBus`, `provenance`
  - API: `securityMiddleware`, `governanceCheckpoint`, `episodicMemoryStore`

### Changed

- ESLint `no-explicit-any` promoted from warn to error (with legacy file exemptions)
- Coverage thresholds raised: statements 40→60%, functions 55→70%, lines 40→60%
- API orchestrator now delegates to core `deliberate()` instead of inline keyword matching
- Removed `Math.random()` from delegation planning for deterministic behavior
- Shutdown handler now logs persist errors instead of silent catch

### Fixed

- Empty catch block in API shutdown handler
- TypeScript type errors in `orchestrator.ts` (runContext, invocationProfile)


## [0.2.0] — 2026-05-19

### Added

- Agent War Room dashboard GUI (`commander gui` command)
- OpenAPI 3.0 specification served at `/openapi.json`
- Readiness probe (`/ready`) for Kubernetes-style deployment checks
- OpenMetrics/Prometheus-compatible metrics format at `/metrics`
- Tenant-aware request context and selected backend controls (Enterprise Gateway remains alpha; storage isolation is opt-in)
- Circuit breaker for provider failures (threshold → open → half-open → recovery)
- Dead letter queue for unrecoverable errors
- Compensation registry for mutation tool rollback
- Graceful shutdown support in HTTP server
- Dependabot configuration for automated dependency updates

### Changed

- HTTP server binds to localhost by default (security hardening)
- All empty catch blocks replaced with structured logging
- All `console.*` calls replaced with structured logger (zero in production code)
- `as any` usage reduced from 21 to 16 in production code
- Package.json prepared for npm publish (main, types, exports, files, publishConfig)
- CI expanded to 3 jobs: quality, docker, web-gui
- Dockerfile: 6-stage multi-architecture build with health checks

### Fixed

- agentRuntime.ts corruption from earlier catch-block edits (373 lines restored)
- httpServer.ts type errors (3 `string | undefined` → `string` fallbacks)
- `getDefaultProvider` return type (`any` → `LLMProvider`)
- Dynamic `require()` replaced with top-level ESM imports
- Silent catch blocks in skills, codeFixer, JSON.parse, LSP rejection handlers
- GAIA evidence audit trail documenting an invalidated 10-task run; a valid full 165-task rerun remains pending

### Removed

- **GAIA benchmark content** — A previous numeric result was invalidated by a
  scoring bug (empty `expected` field marked responses as correct). Scoring is
  fixed, but a valid full re-run is still pending; no score is a current claim.

## [0.1.0] — 2026-05-18

### Added

- Historical benchmark harnesses for GAIA, PinchBench, BFCL, and MT-Bench were
  added; their old numeric outputs are archival only and are not retained as
  current performance claims.
- Unified benchmark runner with YAML config
- CLI: `commander run`, `plan`, `watch`, `status`, `config`, `doctor`, `workers`
- Adaptive temperature controller and codeFixer for syntax repair
- Numeric plausibility check + task-aware confidence thresholds in UnifiedVerification
- Pre-LLM tool provisioning (auto-detect calculation/web search needs)
- MiMo text-format tool call parsing (`<tool_call><function=name>`)
- VerificationLoop with zero-token verifiers (syntax/schema/tool-result) + cache + budget
- 8 providers: OpenAI, Anthropic, Google, DeepSeek, GLM, MiMo, Xiaomi, OpenRouter
- 8 topologies: SINGLE, SEQUENTIAL, PARALLEL, HIERARCHICAL, HYBRID, DEBATE, ENSEMBLE, EVALUATOR-OPT
- ROMA-style task decomposition through atomizer
- Docker multi-stage build (6 stages) and docker-compose deployment
- Nginx configuration for web GUI SPA with API reverse proxy
- MetaLearner with Thompson Sampling and Reflexion
- HTTP API server for runtime management and task execution
- Span-based execution tracing with persistent storage
- Concurrent tool execution and AgentTool with result budgeting
- Commander Arena: 5-agent parallel battle (historical harness result; no current performance claim)
- TaskPool: parallel multi-agent execution engine

### Changed

- Benchmark baseline artifacts now declare their evidence level; live verification remains environment-dependent
- module audit marking `@experimental` components

### Fixed

- Silent catch blocks in authentication provider, HTTP server
- JSON.parse crash in edge cases
- unhandled LSP rejection
- tool call parsing in Xiaomi provider
- multi-turn tool loop for MiMo reasoning models

## [0.0.2] — 2026-05-15

### Added

- Browser search and fetch using stealth Playwright (DuckDuckGo/Brave)
- Public benchmark comparison report
- Transparent performance comparison methodology
- CI workflow setup

### Fixed

- Multi-turn tool loop for MiMo reasoning models
- Skill system integration from OpenClaw/Hermes

## [0.0.1] — 2026-05-14

### Added

- Initial multi-agent orchestration system
- AgentRuntime with LLM → tools → verification → retry loop
- 6 providers (OpenAI, Anthropic, Google, DeepSeek, GLM, Xiaomi)
- MessageBus pub/sub for inter-agent + system events
- Tool system with 15+ built-in tools
- State checkpointer with crash-safe snapshots
- contentScanner for safety checks
- Multi-tenant isolation (NullTenantProvider, SimpleTenantProvider)
- Three-layer memory (working, episodic, long-term)
- Plugin system with hook-based lifecycle
- Hallucination detector with signal-based detection
- Reflection engine for post-execution self-evaluation
- CLI framework with basic command support
- 233+ tests across module, integration, E2E, and chaos tests
- MIT License

[Unreleased]: https://github.com/PStarH/Commander/compare/master...HEAD
