# Security Policy

## Supported Versions

| Version | Supported             |
| ------- | --------------------- |
| 0.x     | ✅ Active development |

## Reporting a Vulnerability

We take the security of Praetor seriously. If you believe you have found a
security vulnerability, please report it to us as described below.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately through
[GitHub Security Advisories](https://github.com/PStarH/Praetor/security/advisories/new).

You should receive a response within 48 hours. If for some reason you do not,
open a follow-up advisory so we can see the original report.

To help us better understand the nature and scope of the issue, please include
as much of the following information as possible:

- Type of issue (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

## Preferred Languages

We prefer all communications to be in English.

## Policy

We follow the principle of [Responsible Disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure):

1. Report vulnerabilities privately (see above).
2. We will acknowledge receipt within 48 hours.
3. We will investigate and provide an estimated timeline for a fix.
4. Once the fix is released, we will publicly acknowledge your responsible disclosure
   (unless you prefer to remain anonymous).

## Security Practices

Commander implements the following security measures:

- **Bearer token authentication** on all API endpoints (configurable)
- **Per-IP rate limiting** with configurable thresholds
- **Configurable CORS** for cross-origin requests
- **Localhost-only binding** by default for the HTTP server
- **Input validation** on all API endpoints
- **Structured logging** with no sensitive data in log output
- **Dependency scanning** via npm audit in CI pipeline
- **Tenant-aware request scoping** (AsyncLocalStorage) and optional per-tenant storage/rate limits on the **Enterprise Gateway path (alpha)**. Not production-proven multi-tenant isolation; see `ENTERPRISE_READINESS.md`.
- **Circuit breakers** to prevent cascade failures
- **Prompt injection detection** across multiple languages
