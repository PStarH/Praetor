"""
Commander Tool-Call Governance — runtime prevention layer.

Wraps agent tool execution so that every tool call is checked against
Commander's ReversibilityGate before it reaches the environment. Blocked
calls are converted into error ToolMessages, giving the agent a chance to
recover instead of performing an irreversible or dangerous action.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .security import ReversibilityGate


class ToolCallGovernance:
    """
    Runtime governance wrapper for an agent's tool-call executor.

    Usage:
        governance = ToolCallGovernance()
        wrapped = governance.wrap(orchestrator._execute_tool_calls)
        orchestrator._execute_tool_calls = wrapped
    """

    def __init__(self):
        self.blocked_calls: list[dict[str, Any]] = []

    def wrap(
        self, execute_fn: Callable[[list[Any]], list[Any]]
    ) -> Callable[[list[Any]], list[Any]]:
        """Wrap an _execute_tool_calls-like function."""

        def _governed_execute(tool_calls: list[Any]) -> list[Any]:
            allowed = []
            blocked_messages = []
            for tc in tool_calls:
                name = tc.name if hasattr(tc, "name") else str(tc)
                args = tc.arguments if hasattr(tc, "arguments") else {}
                should_block, reason = ReversibilityGate.should_block(name, args or {})
                if should_block:
                    self.blocked_calls.append(
                        {"name": name, "args": args, "reason": reason}
                    )
                    # Create a synthetic tool-error result. The caller expects a list
                    # of ToolMessage-like objects. We use the same object type as the
                    # original executor returns, but with error content.
                    blocked_messages.append(self._make_error_message(tc, reason))
                else:
                    allowed.append(tc)

            results = execute_fn(allowed) if allowed else []
            return results + blocked_messages

        return _governed_execute

    def _make_error_message(self, tool_call: Any, reason: str) -> Any:
        """Build a ToolMessage-like error object without importing tau2 types."""

        # Attempt to reuse the environment's response type by calling get_response
        # with a fake tool call, but most environments expect real tools.
        # Simpler: return a plain object with the attributes tau2 expects.
        class _BlockedToolResult:
            def __init__(self, tool_call_id: Any, name: str, error: str):
                self.role = "tool"
                self.tool_call_id = tool_call_id
                self.name = name
                self.content = f"[BLOCKED by Commander] {error}"
                self.error = error

        tc_id = getattr(tool_call, "id", "blocked")
        tc_name = getattr(tool_call, "name", "unknown")
        return _BlockedToolResult(tc_id, tc_name, reason)

    def summary(self) -> dict[str, Any]:
        return {
            "blocked_calls": len(self.blocked_calls),
            "details": self.blocked_calls,
        }
