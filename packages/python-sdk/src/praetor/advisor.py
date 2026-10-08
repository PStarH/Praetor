"""
Commander Trajectory Advisor — runtime loop-detection and recovery.

This module provides framework-level reliability improvements for LLM agents
by detecting repetitive tool-call patterns and injecting recovery hints.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AdvisorHint:
    """A hint produced by the advisor when it detects a problem."""

    message: str
    pattern: str
    severity: str = "warning"  # "warning" or "critical"


@dataclass
class TrajectoryAdvisor:
    """
    Detects when an agent is stuck in a reasoning or tool-call loop and
    produces a hint that can be injected into the conversation to help it
    escape.

    Two loop modes are supported:
    - exact: the exact same (name, arguments) tuple repeats `repeat_threshold` times
    - same_tool: the same tool name repeats `same_tool_threshold` times, even
      with different arguments (e.g. repeated searches)
    """

    repeat_threshold: int = 3
    same_tool_threshold: int = 4
    exact_loops: int = field(default=0, init=False)
    same_tool_loops: int = field(default=0, init=False)
    hints_injected: int = field(default=0, init=False)

    def _tool_key(self, tool_call: dict[str, Any]) -> tuple[str, str]:
        name = (
            tool_call.get("name", "")
            if isinstance(tool_call, dict)
            else getattr(tool_call, "name", "")
        )
        args = (
            tool_call.get("arguments", {})
            if isinstance(tool_call, dict)
            else getattr(tool_call, "arguments", {})
        )
        return (name, json.dumps(args, sort_keys=True, default=str))

    def check(self, tool_call_history: list[dict[str, Any]]) -> AdvisorHint | None:
        """Return a hint if a loop is detected, else None."""
        if len(tool_call_history) < self.repeat_threshold:
            return None

        # 1. Exact repeat loop
        last_n = tool_call_history[-self.repeat_threshold :]
        first_key = self._tool_key(last_n[0])
        all_same = all(self._tool_key(c) == first_key for c in last_n)
        if all_same:
            self.exact_loops += 1
            self.hints_injected += 1
            return AdvisorHint(
                pattern="exact_repeat",
                severity="critical",
                message=(
                    "[Commander Advisor] You have made the exact same tool call "
                    f"{self.repeat_threshold} times in a row. Stop repeating it. "
                    "Either ask the user a clarifying question, or take a different "
                    "action that moves the task forward."
                ),
            )

        # 2. Same-tool loop (different arguments)
        if len(tool_call_history) >= self.same_tool_threshold:
            last_same = tool_call_history[-self.same_tool_threshold :]
            names = [self._tool_key(c)[0] for c in last_same]
            if names and all(n == names[0] and n for n in names):
                self.same_tool_loops += 1
                self.hints_injected += 1
                return AdvisorHint(
                    pattern="same_tool_repeat",
                    severity="warning",
                    message=(
                        f"[Commander Advisor] You have called '{names[0]}' "
                        f"{self.same_tool_threshold} times in a row with different arguments. "
                        "If the information you need is still missing, ask the user directly "
                        "instead of making more similar calls."
                    ),
                )

        return None

    def summary(self) -> dict[str, Any]:
        return {
            "exact_loops": self.exact_loops,
            "same_tool_loops": self.same_tool_loops,
            "hints_injected": self.hints_injected,
        }
