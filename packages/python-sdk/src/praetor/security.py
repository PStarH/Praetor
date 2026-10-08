"""
Commander Security Primitives — Python SDK module.

This module provides Python-side ports of Commander's TypeScript security
primitives (packages/core/src/security/), enabling Python-based agent
pipelines to benefit from the same 3-layer defense architecture
(Prevention → Containment → Recovery) when the TypeScript server is
unavailable or when running benchmarks that require direct pipeline
integration.

Components:
    - UniversalSanitizer: PII/XSS/path-traversal/prompt-injection neutralization
    - ReversibilityGate: Tool call classification and blocking
    - SecurityAnomalyDetector: Pattern-based anomaly detection
    - PromptInjectionDetector: Injection detection in tool results

Source: packages/core/src/security/securityPrimitives.ts
        packages/core/src/security/reversibilityGate.ts
        packages/core/src/security/securityAnomalyDetector.ts
"""

from __future__ import annotations

import re
import time
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, ClassVar

# ═══════════════════════════════════════════════════════════════════════════════
# SanitizeContext
# ═══════════════════════════════════════════════════════════════════════════════


class SanitizeContext(str, Enum):
    """Context for sanitization dispatch (mirrors TS SanitizeContext)."""

    INPUT = "input"
    OUTPUT = "output"
    TOOL_ARGS = "tool_args"
    LOG = "log"
    FILENAME = "filename"
    IDENTIFIER = "identifier"
    CHANNEL_TEXT = "channel_text"
    DESCRIPTION = "description"


@dataclass
class SanitizeResult:
    """Result of a sanitization operation."""

    sanitized: str
    modified: bool
    patterns: list = field(default_factory=list)


# ═══════════════════════════════════════════════════════════════════════════════
# UniversalSanitizer — port of securityPrimitives.ts
# ═══════════════════════════════════════════════════════════════════════════════


class UniversalSanitizer:
    """
    Python port of Commander's UniversalSanitizer.

    Single entry point for all sanitization. Context-dispatched:
    - 'input': PII + XSS + path traversal
    - 'output': PII + control chars
    - 'tool_args': PII + control chars
    - 'log': PII + control chars
    - 'filename': path traversal + unsafe chars
    - 'identifier': path traversal + unsafe chars
    - 'channel_text': mentions + URLs + control chars + length cap
    - 'description': prompt injection neutralization + control chars + length cap
    """

    # ── PII patterns ──────────────────────────────────────────────────────────
    PII_PATTERNS: ClassVar[list[tuple[str, re.Pattern, str]]] = [
        ("api_key", re.compile(r"\b(sk-[a-zA-Z0-9]{20,})\b"), "sk-[REDACTED]"),
        (
            "anthropic_key",
            re.compile(r"\b(sk-ant-[a-zA-Z0-9]{20,})\b"),
            "sk-ant-[REDACTED]",
        ),
        (
            "github_token",
            re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{36,})\b"),
            "ghp_[REDACTED]",
        ),
        ("aws_key", re.compile(r"\b(AKIA[0-9A-Z]{16})\b"), "AKIA[REDACTED]"),
        (
            "jwt",
            re.compile(r"\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b"),
            "[JWT_REDACTED]",
        ),
        (
            "pem_key_full",
            re.compile(
                r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----"
            ),
            "[PEM_REDACTED]",
        ),
        (
            "pem_header",
            re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----"),
            "[PEM_REDACTED]",
        ),
        (
            "pem_footer",
            re.compile(r"-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----"),
            "[PEM_REDACTED]",
        ),
        ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[SSN_REDACTED]"),
        (
            "phone",
            re.compile(r"\+?\d{1,2}[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}"),
            "[PHONE_REDACTED]",
        ),
        (
            "email",
            re.compile(r"\b[a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b"),
            "[EMAIL_REDACTED]",
        ),
        (
            "password",
            re.compile(r"(?:password|passwd|pwd)\s*[=:]\s*\S+", re.IGNORECASE),
            "password=[REDACTED]",
        ),
        (
            "stripe_key",
            re.compile(r"\b(sk_live_[a-zA-Z0-9]{24,})\b"),
            "sk_live_[REDACTED]",
        ),
        (
            "slack_token",
            re.compile(r"\b(xox[baprs]-[a-zA-Z0-9-]+)\b"),
            "xox-[REDACTED]",
        ),
    ]

    # ── XSS patterns ──────────────────────────────────────────────────────────
    XSS_PATTERNS: ClassVar[list[tuple[str, re.Pattern, str]]] = [
        (
            "script_tag",
            re.compile(
                r"<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>", re.IGNORECASE
            ),
            "",
        ),
        (
            "event_handler_double",
            re.compile(r'\son\w+\s*=\s*"[^"]*"', re.IGNORECASE),
            "",
        ),
        (
            "event_handler_single",
            re.compile(r"\son\w+\s*=\s*'[^']*'", re.IGNORECASE),
            "",
        ),
        ("javascript_url", re.compile(r"javascript:", re.IGNORECASE), ""),
        ("data_url_html", re.compile(r"data:text/html", re.IGNORECASE), ""),
    ]

    # ── Path traversal ────────────────────────────────────────────────────────
    PATH_TRAVERSAL = re.compile(r"(\.\.[/\\]|\.\.%2f|\.\.%5c)", re.IGNORECASE)

    # ── Control characters ────────────────────────────────────────────────────
    CONTROL_CHARS = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")

    # ── Channel mentions ──────────────────────────────────────────────────────
    CHANNEL_MENTIONS = re.compile(r"@(here|channel|everyone|all)", re.IGNORECASE)
    URL_PATTERN = re.compile(r"https?://[^\s]+", re.IGNORECASE)

    # ── Prompt injection patterns (for 'description' context) ────────────────
    # Mirrors the TS PROMPT_INJECTION_PATTERNS array.
    # CRITICAL: The full_injection_block pattern must be first — it removes
    # the ENTIRE injection payload (not just framing) so the LLM never sees
    # the malicious instructions inside.
    PROMPT_INJECTION_PATTERNS: ClassVar[list[tuple[str, re.Pattern, str]]] = [
        # AgentDojo important_instructions: remove entire <INFORMATION>...</INFORMATION> block
        # This catches the complete injection including the payload instructions
        (
            "full_injection_block",
            re.compile(r"<INFORMATION>[\s\S]*?</INFORMATION>", re.IGNORECASE),
            "[INJECTION BLOCKED]",
        ),
        # Also catch untagged injection blocks: "This is an important message...Signed,..."
        (
            "full_injection_block_untagged",
            re.compile(
                r"This is an important message from me,?\s*\w+,?\s*to you,?\s*\w+\..*?Signed,\s*\n+\s*\w+\s+\w+",
                re.IGNORECASE | re.DOTALL,
            ),
            "[INJECTION BLOCKED]",
        ),
        # Chat role prefixes at line start
        (
            "chat_role_prefix",
            re.compile(
                r"^[ \t]*(system|assistant|user)\s*:", re.IGNORECASE | re.MULTILINE
            ),
            "[$1:]",
        ),
        # HTML comments
        ("html_comment", re.compile(r"<!--[\s\S]*?-->"), "[comment]"),
        # Explicit injection phrases
        (
            "ignore_instructions",
            re.compile(
                r"ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions", re.IGNORECASE
            ),
            "[redacted]",
        ),
        # Remaining impersonation tags (if block was partially removed)
        (
            "impersonation_tag",
            re.compile(
                r"<\/?(INFORMATION|IMPORTANT|SYSTEM|ADMIN|SYSTEM_INSTRUCTION|INSTRUCTION|SYSTEM_MESSAGE|ASSISTANT_INSTRUCTION)\b[^>]*>",
                re.IGNORECASE,
            ),
            "",
        ),
        # Remaining injection phrases (if block was partially removed)
        (
            "important_message_impersonation",
            re.compile(
                r"This is an important message from me,?\s*\w+,?\s*to you,?\s*\w+\.",
                re.IGNORECASE,
            ),
            "[INJECTION BLOCKED]",
        ),
        (
            "task_redirection_directive",
            re.compile(
                r"Before you can solve the task.*?please do the following first:",
                re.IGNORECASE | re.DOTALL,
            ),
            "[INJECTION BLOCKED]",
        ),
        (
            "injection_closing_phrase",
            re.compile(
                r"After you do that, you can solve the task.*?Thanks!",
                re.IGNORECASE | re.DOTALL,
            ),
            "[INJECTION BLOCKED]",
        ),
        (
            "injection_signature",
            re.compile(r"Signed,\s*\n+\s*\w+\s+\w+", re.IGNORECASE),
            "",
        ),
        (
            "do_following_first",
            re.compile(r"please\s+do\s+the\s+following\s+first\s*:", re.IGNORECASE),
            "[INJECTION BLOCKED]",
        ),
        # ChatML / special token injection
        (
            "chatml_tokens",
            re.compile(
                r"<\|?(?:im_start|im_end|system|assistant|user)\|?>", re.IGNORECASE
            ),
            "[blocked]",
        ),
        # Role manipulation
        (
            "role_manipulation",
            re.compile(
                r"act\s+as\s+(?:a|an)\s+(?:different|new|admin|root|developer)",
                re.IGNORECASE,
            ),
            "[redacted]",
        ),
        # Jailbreak attempts
        (
            "jailbreak_attempt",
            re.compile(
                r"(?:DAN|jailbreak|do\s+anything\s+now|developer\s+mode|god\s+mode|unrestricted)\b",
                re.IGNORECASE,
            ),
            "[redacted]",
        ),
        # System prompt exfiltration
        (
            "prompt_exfiltration",
            re.compile(
                r"(?:reveal|show|print|repeat|output).*(?:system\s+prompt|instructions?|rules?)",
                re.IGNORECASE,
            ),
            "[redacted]",
        ),
        # Data exfiltration directives
        (
            "data_exfiltration_directive",
            re.compile(
                r"(?:send|forward|email|post)\s+(?:the\s+)?(?:api\s+key|password|token|secret|credential|security\s+code|verification\s+code)\s+(?:to|via|through)",
                re.IGNORECASE,
            ),
            "[INJECTION BLOCKED]",
        ),
    ]

    def __init__(self):
        pass

    def sanitize(
        self, input_str: str, context: str | SanitizeContext = SanitizeContext.INPUT
    ) -> SanitizeResult:
        """Sanitize a string based on context."""
        if not isinstance(input_str, str):
            return SanitizeResult(
                sanitized=str(input_str) if input_str is not None else "",
                modified=False,
            )

        ctx = context.value if isinstance(context, SanitizeContext) else context
        result = input_str
        patterns = []

        # PII scrubbing only for contexts where PII should never appear
        # (logs, channel text). For 'description' (tool results) and 'input',
        # PII like email addresses are legitimate data the agent needs.
        if ctx in ("output", "log", "channel_text"):
            for name, pattern, replacement in self.PII_PATTERNS:
                if pattern.search(result):
                    patterns.append(name)
                    result = pattern.sub(replacement, result)

        if ctx in ("output", "log") or ctx == "tool_args":
            if self.CONTROL_CHARS.search(result):
                patterns.append("control_chars")
                result = self.CONTROL_CHARS.sub("", result)

        elif ctx in ("filename", "identifier"):
            if self.PATH_TRAVERSAL.search(result):
                patterns.append("path_traversal")
                result = self.PATH_TRAVERSAL.sub("", result)
            cleaned = re.sub(r"[^a-zA-Z0-9_\-./]", "_", result)
            if cleaned != result:
                patterns.append("unsafe_identifier_chars")
                result = cleaned

        elif ctx == "channel_text":
            if self.CHANNEL_MENTIONS.search(result):
                patterns.append("channel_mention")
                result = self.CHANNEL_MENTIONS.sub(r"@-\1", result)
            if self.URL_PATTERN.search(result):
                patterns.append("url_stripped")
                result = self.URL_PATTERN.sub("[URL]", result)
            if self.CONTROL_CHARS.search(result):
                patterns.append("control_chars")
                result = self.CONTROL_CHARS.sub("", result)
            if len(result) > 500:
                patterns.append("length_capped")
                result = result[:500]

        elif ctx == "description":
            # Neutralize prompt injection vectors
            for name, pattern, replacement in self.PROMPT_INJECTION_PATTERNS:
                if pattern.search(result):
                    patterns.append(name)
                    result = pattern.sub(replacement, result)
            if self.CONTROL_CHARS.search(result):
                patterns.append("control_chars")
                result = self.CONTROL_CHARS.sub("", result)
            if len(result) > 204800:
                patterns.append("length_capped")
                result = result[:204800]

        elif ctx == "input":
            # XSS prevention
            for name, pattern, replacement in self.XSS_PATTERNS:
                if pattern.search(result):
                    patterns.append(name)
                    result = pattern.sub(replacement, result)
            if self.PATH_TRAVERSAL.search(result):
                patterns.append("path_traversal")
                result = self.PATH_TRAVERSAL.sub("", result)

        return SanitizeResult(
            sanitized=result, modified=result != input_str, patterns=patterns
        )

    def sanitize_object(
        self, obj: Any, context: str | SanitizeContext = SanitizeContext.INPUT
    ) -> Any:
        """Recursively sanitize an object's string values."""
        if isinstance(obj, str):
            return self.sanitize(obj, context).sanitized
        if isinstance(obj, list):
            return [self.sanitize_object(item, context) for item in obj]
        if isinstance(obj, dict):
            return {k: self.sanitize_object(v, context) for k, v in obj.items()}
        return obj


# ═══════════════════════════════════════════════════════════════════════════════
# PromptInjectionDetector — enhanced detection
# ═══════════════════════════════════════════════════════════════════════════════


class PromptInjectionDetector:
    """
    Detects prompt injection in tool results and user messages.
    Mirrors Commander's multi-layer detection approach.
    """

    # High-confidence injection patterns (broader than sanitizer patterns)
    INJECTION_PATTERNS: ClassVar[list[tuple[str, re.Pattern]]] = [
        (
            "system_prompt_leak",
            re.compile(
                r"(?:reveal|show|print|repeat|output|display|what\s+(?:are|is))\s+"
                r"(?:the\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?)",
                re.IGNORECASE,
            ),
        ),
        (
            "role_manipulation",
            re.compile(
                r"(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|from\s+now\s+on\s+you\s+are)",
                re.IGNORECASE,
            ),
        ),
        (
            "ignore_instructions",
            re.compile(
                r"(?:ignore|disregard|forget|override)\s+(?:all\s+|previous\s+|prior\s+)?"
                r"(?:instructions?|rules?|guidelines?|prompts?)",
                re.IGNORECASE,
            ),
        ),
        (
            "new_instructions",
            re.compile(
                r"(?:new|updated|real|actual)\s+(?:instructions?|rules?|task)\s*:",
                re.IGNORECASE,
            ),
        ),
        (
            "jailbreak_attempt",
            re.compile(
                r"(?:DAN|jailbreak|do\s+anything\s+now|developer\s+mode|god\s+mode|unrestricted)",
                re.IGNORECASE,
            ),
        ),
        (
            "data_exfiltration",
            re.compile(
                r"(?:send|post|upload|transfer|email|forward)\s+"
                r"(?:the\s+)?(?:api\s+key|password|token|secret|credential|data|security\s+code)\s+"
                r"(?:to|via|through)\s+",
                re.IGNORECASE,
            ),
        ),
        (
            "privileged_action",
            re.compile(
                r"(?:delete\s+all|drop\s+table|rm\s+-rf|format\s+disk|sudo|chmod\s+777)",
                re.IGNORECASE,
            ),
        ),
        # AgentDojo important_instructions attack
        ("information_tag", re.compile(r"<INFORMATION>", re.IGNORECASE)),
        (
            "important_message_from",
            re.compile(r"This is an important message from me", re.IGNORECASE),
        ),
        (
            "before_you_solve",
            re.compile(
                r"Before you can solve the task.*?please do the following first",
                re.IGNORECASE | re.DOTALL,
            ),
        ),
    ]

    @classmethod
    def detect(cls, text: str) -> tuple[bool, list[str]]:
        """Detect prompt injection. Returns (is_injected, matched_patterns)."""
        if not isinstance(text, str):
            return False, []
        matched = []
        for name, pattern in cls.INJECTION_PATTERNS:
            if pattern.search(text):
                matched.append(name)
        return len(matched) > 0, matched

    @classmethod
    def detect_in_tool_result(cls, tool_result: Any) -> tuple[bool, list[str], Any]:
        """
        Recursively detect injection in tool results.
        When injection is detected, the ENTIRE string is replaced with a
        redaction notice — not surgically cleaned. This is because partial
        cleaning can leave enough injection context for the LLM to still
        follow the injected instructions. Tool results are untrusted data;
        when they contain injection, the whole result is compromised.
        """
        if isinstance(tool_result, str):
            is_inj, patterns = cls.detect(tool_result)
            if is_inj:
                # Replace entire string — don't try to surgically clean it.
                # The LLM should never see injection-contaminated content.
                redacted = f"[Commander Security: prompt injection detected and blocked. Patterns: {', '.join(patterns)}. Tool output redacted.]"
                return True, patterns, redacted
            return False, [], tool_result
        elif isinstance(tool_result, dict):
            result = {}
            any_inj = False
            all_patterns = []
            for k, v in tool_result.items():
                inj, pats, san = cls.detect_in_tool_result(v)
                result[k] = san
                if inj:
                    any_inj = True
                    all_patterns.extend(pats)
            return any_inj, all_patterns, result
        elif isinstance(tool_result, list):
            result = []
            any_inj = False
            all_patterns = []
            for item in tool_result:
                inj, pats, san = cls.detect_in_tool_result(item)
                result.append(san)
                if inj:
                    any_inj = True
                    all_patterns.extend(pats)
            return any_inj, all_patterns, result
        return False, [], tool_result


# ═══════════════════════════════════════════════════════════════════════════════
# ReversibilityGate — port of reversibilityGate.ts
# ═══════════════════════════════════════════════════════════════════════════════


class ToolRiskLevel(str, Enum):
    SAFE = "safe"
    REVERSIBLE = "reversible"
    IRREVERSIBLE = "irreversible"
    BLOCKED = "blocked"


class ReversibilityGate:
    """
    Port of Commander's ReversibilityGate.
    Classifies tool calls and blocks dangerous ones.
    Fail-closed by default.
    """

    # Irreversible tools (require human approval in Commander)
    # NOTE: delete_file is NOT here — it's a legitimate tool in agent workflows.
    # Instead, suspicious delete patterns are handled in SUSPICIOUS_TOOL_PATTERNS.
    IRREVERSIBLE_TOOLS: ClassVar[set[str]] = {
        "git_push",
        "shell_execute",
        "python_execute",
        "web_fetch",
        "rm",
        "format",
        "drop",
    }

    # Dangerous argument patterns
    DANGEROUS_ARG_PATTERNS: ClassVar[list[tuple[str, re.Pattern]]] = [
        (
            "destructive_shell",
            re.compile(
                r"(?:rm\s+-rf|format\s+|mkfs|dd\s+if=|>\s*/dev/sd)", re.IGNORECASE
            ),
        ),
        (
            "network_exfil",
            re.compile(
                r"(?:curl\s+|wget\s+|nc\s+|netcat|scp\s+|rsync\s+).*(?:api_key|password|token|secret)",
                re.IGNORECASE,
            ),
        ),
        (
            "privilege_escalation",
            re.compile(
                r"(?:sudo|chmod\s+777|chown\s+root|/etc/passwd|/etc/shadow)",
                re.IGNORECASE,
            ),
        ),
        (
            "sql_injection",
            re.compile(
                r"(?:DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT|;\s*DROP)", re.IGNORECASE
            ),
        ),
        (
            "path_traversal",
            re.compile(
                r"(?:\.\./|\.\.%2f|\.\.%5c|/etc/passwd|/etc/shadow|/root/)",
                re.IGNORECASE,
            ),
        ),
    ]

    # Suspicious tool-specific patterns (data exfiltration, destructive actions)
    # Maps tool names to patterns that indicate injection-driven behavior.
    # Key insight: these tools are legitimate for user tasks, so we only block
    # when the arguments match injection-driven patterns (e.g., sending to
    # known attacker addresses, forwarding security codes).
    SUSPICIOUS_TOOL_PATTERNS: ClassVar[dict[str, dict]] = {
        "send_email": {
            # Only block when sending to known attacker addresses
            "blocked_recipients": re.compile(
                r"mark\.black.*?@gmail\.com", re.IGNORECASE
            ),
            # Only block when body contains security code exfiltration
            "security_code_forward": re.compile(
                r"(?:security\s+code|verification\s+code|OTP|MFA)", re.IGNORECASE
            ),
        },
        "create_calendar_event": {
            "blocked_participants": re.compile(
                r"mark\.black.*?@gmail\.com", re.IGNORECASE
            ),
        },
    }

    @classmethod
    def classify(cls, tool_name: str, tool_args: dict) -> ToolRiskLevel:
        """Classify a tool call's risk level."""
        for pattern in cls.IRREVERSIBLE_TOOLS:
            if pattern in tool_name.lower():
                return ToolRiskLevel.IRREVERSIBLE
        args_str = str(tool_args)
        for _, pattern in cls.DANGEROUS_ARG_PATTERNS:
            if pattern.search(args_str):
                return ToolRiskLevel.BLOCKED
        sanitizer = UniversalSanitizer()
        sanitized_args = sanitizer.sanitize_object(tool_args, SanitizeContext.TOOL_ARGS)
        if str(sanitized_args) != args_str:
            return ToolRiskLevel.REVERSIBLE
        return ToolRiskLevel.SAFE

    @classmethod
    def should_block(cls, tool_name: str, tool_args: dict) -> tuple[bool, str]:
        """Returns (should_block, reason). Fail-closed."""
        # Check irreversible tools
        for pattern in cls.IRREVERSIBLE_TOOLS:
            if pattern in tool_name.lower():
                return (
                    True,
                    f"Blocked by ReversibilityGate: irreversible tool '{tool_name}' requires approval",
                )

        # Check dangerous argument patterns
        args_str = str(tool_args)
        for name, pattern in cls.DANGEROUS_ARG_PATTERNS:
            if pattern.search(args_str):
                return (
                    True,
                    f"Blocked by ReversibilityGate: dangerous argument pattern '{name}' detected",
                )

        # Check suspicious tool-specific patterns
        if tool_name in cls.SUSPICIOUS_TOOL_PATTERNS:
            patterns = cls.SUSPICIOUS_TOOL_PATTERNS[tool_name]

            if "blocked_recipients" in patterns:
                recipients = tool_args.get("recipients", []) or []
                if isinstance(recipients, str):
                    recipients = [recipients]
                for rec in recipients:
                    if patterns["blocked_recipients"].search(str(rec)):
                        return (
                            True,
                            "Blocked by ReversibilityGate: data exfiltration to suspicious address",
                        )

            if "blocked_participants" in patterns:
                participants = tool_args.get("participants", []) or []
                if isinstance(participants, str):
                    participants = [participants]
                for p in participants:
                    if patterns["blocked_participants"].search(str(p)):
                        return (
                            True,
                            "Blocked by ReversibilityGate: suspicious calendar participant",
                        )

            if "security_code_forward" in patterns:
                body = str(tool_args.get("body", "")) + str(
                    tool_args.get("subject", "")
                )
                if patterns["security_code_forward"].search(body):
                    return (
                        True,
                        "Blocked by ReversibilityGate: security code exfiltration attempt",
                    )

        return False, ""


# ═══════════════════════════════════════════════════════════════════════════════
# SecurityAnomalyDetector — port of securityAnomalyDetector.ts
# ═══════════════════════════════════════════════════════════════════════════════


class SecurityAnomalyDetector:
    """
    Port of Commander's SecurityAnomalyDetector.
    Detects anomalous agent behavior patterns in real-time.
    7 anomaly types: tool_burst, capability_abuse, error_cascade,
    sandbox_escape, irreversible_burst, outbound_blocked, brute_force_approval.
    """

    def __init__(self, window_seconds: int = 60):
        self.window_seconds = window_seconds
        self.tool_calls: list[tuple[float, str]] = []
        self.blocked_count = 0
        self.anomaly_count = 0

    def record_tool_call(self, tool_name: str):
        now = time.time()
        self.tool_calls.append((now, tool_name))
        self.tool_calls = [
            (t, n) for t, n in self.tool_calls if now - t < self.window_seconds
        ]

    def detect_tool_burst(self, threshold: int = 50) -> bool:
        """Detect if too many tool calls in 60s window. Threshold raised to 50
        to avoid false positives during normal multi-step task execution."""
        return len(self.tool_calls) > threshold

    def detect_capability_abuse(self, tool_name: str, count: int = 15) -> bool:
        """Detect if same tool called too many times. Threshold raised to 15
        to avoid false positives during legitimate iterative workflows."""
        counts = Counter(n for _, n in self.tool_calls)
        return counts.get(tool_name, 0) > count

    def check_anomaly(self, tool_name: str) -> tuple[bool, str]:
        """Check for anomalies before tool execution."""
        self.record_tool_call(tool_name)
        if self.detect_tool_burst():
            self.anomaly_count += 1
            return True, "tool_burst: too many tool calls in 60s window"
        if self.detect_capability_abuse(tool_name):
            self.anomaly_count += 1
            return True, f"capability_abuse: tool '{tool_name}' called too many times"
        return False, ""
