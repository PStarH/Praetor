# Privacy and Data Boundaries

Commander is an alpha, self-hosted project. It is not production-ready and this
repository does not provide a hosted-service privacy or compliance guarantee.
Review this document before entering personal, confidential, regulated, or
security-sensitive data.

## What can leave the local process

- A task prompt and the selected model/provider configuration can be sent to the
  LLM provider you configure. Provider retention, logging, and processing are
  controlled by that provider's terms, not by Commander.
- `commander review --real` sends a review prompt containing local review
  guidelines and up to 15,000 characters from the selected Git diff. Diff
  content can include source code, configuration, identifiers, comments, and
  other repository-sensitive material. Inspect the diff before running it. The
  command runs fixed, read-only `git diff` subprocesses and stores cross-process
  CLI rate-limit state in the system temporary directory; it does not register
  execution tools for the provider/model. Guidelines are collected from
  Markdown list items in `AGENTS.md`, `.review.md`, `REVIEW.md`,
  `.github/review.md`, and `.commander/review.md`; at most the first 1,000
  combined characters are submitted.
- If you enable the tracing or observability profiles, traces and metrics can be
  exported to the endpoints configured by the operator (for example, Jaeger via
  OTLP). Review those destinations before enabling them.
- A web registration collects a username, email address, and password. Passwords
  should be handled by the configured authentication backend; do not reuse a
  personal password.

## What Commander can persist

Depending on the profile and storage backend, local state can include provider
configuration, API keys, prompts, responses, execution traces, memory, audit
events, results, and application logs. Common locations and volumes include
`.commander.json`, `.commander/`, `.commander_traces/`, and the Docker volumes
`commander_state`, `commander_traces`, `commander_memory`, and `commander_results`.
API keys in local configuration are still secrets and must be protected with the
same care as environment variables.

## Retention and deletion

The deployment operator controls local retention, backups, and deletion. Remove
the relevant local files or Docker volumes, and remove any copies from configured
provider, tracing, logging, or backup systems. Deleting local state does not
delete data already retained by an external provider. Validate the applicable
backend and backup procedures before a pilot; a DPA and production retention
contract are not included in this alpha repository.

## Research participation

Commander is an alpha research-preview project. If you evaluate the repository,
the web console, or the onboarding scenarios, the following boundaries apply
unless you explicitly opt into something else. Evaluation does not imply consent
to model training or dataset export.

- **Consent.** Research participation and operational telemetry are separate from
  model-training consent. Training export requires an explicit tenant-scoped
  opt-in that names the purpose, retention period, and deletion path. No training
  dataset is exported by default, and evaluation never silently enrolls a tenant.
- **What is used.** Only data you choose to enter and the local traces the
  evaluation itself produces. Action-learning records must be normalized and
  exclude prompts, raw arguments, responses, credentials, PII, customer content,
  and internal URLs. Commander does not phone home, does not upload results to a
  vendor backend, and has no telemetry by default.
- **Withdrawal and deletion.** You can stop participating at any time. Withdrawal
  stops future training export; retained records follow the agreed deletion and
  retention process. Delete local state (see "Retention and deletion") and
  separately request deletion from any external provider or backup that already
  received data. Removing local state cannot erase provider copies automatically.
- **Feedback.** Voluntary feedback you share (issues, discussions, interviews)
  is used only with your permission; redact prompts, logs, PII, and secrets
  before submitting (see "Public submissions").

## Public submissions

Do not put real prompts, PII, credentials, API keys, access tokens, customer data,
or unredacted traces in GitHub issues, discussions, pull requests, or screenshots.
Redact logs and configuration before filing a normal bug. Report suspected
security vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

Questions about this boundary can be opened as a [GitHub issue](https://github.com/PStarH/Commander/issues) on this repository.

## Shadow Pilot Phase A

The optional Phase A Shadow Pilot is a dedicated customer-cloud historical
evaluation of `kubernetes.deployment.rollback`. Its authoritative evidence store
is customer-operated PostgreSQL; it does not use local, Redis, or SQLite
persistence fallbacks. See the [customer data boundary](docs/pilot/shadow/data-boundary.md)
before preparing a declared sample.

The customer controls retention (1–30 days), export recipients, withdrawal, and
backup handling. Campaign withdrawal deletes retained payload from the dedicated
Shadow schema while leaving a minimal tombstone and hashed deletion audit; it
cannot remove already exported reports or customer backups. Legal/DPA review is
external and remains the customer’s responsibility.
