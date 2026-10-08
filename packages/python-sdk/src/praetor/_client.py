"""Async HTTP client for Commander."""

from __future__ import annotations

import asyncio
import json
import os
import random
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

import httpx

from ._exceptions import (
    CommanderError,
    ConnectionError,
    RateLimitError,
    map_status_to_error,
)
from ._streaming import CommanderSSEStream
from ._types import (
    ActiveRuns,
    AgentConfig,
    AgentSnapshot,
    AgentState,
    ApiKeyCreateResult,
    ApiKeyList,
    ApprovalAuditLog,
    ApprovalMode,
    ApprovalModeUpdated,
    ApprovalPatternRemoved,
    ApprovalPolicyResult,
    AppSettings,
    AuditLogs,
    AuditSourceInfo,
    AuditStats,
    AuthTokens,
    BusTopics,
    ChatHistory,
    ChatResponse,
    ChatStreamEvent,
    Checkpoint,
    CheckpointList,
    ConfidenceReport,
    ConfidenceThresholdInfo,
    ConflictDetectionResult,
    ConflictSummary,
    CostBudget,
    CostDashboardResponse,
    CostRecords,
    CostReport,
    CostSummary,
    CostTimeRange,
    DlqEntry,
    DlqReplayResult,
    DlqStats,
    DocumentList,
    EvalCompareResult,
    EvalDataset,
    EvalDatasetList,
    EvalJudgeResult,
    EvalStatus,
    EvalWilcoxonResult,
    ExecutionEvent,
    ExecutionResult,
    HealthStatus,
    KnowledgeDocument,
    KnowledgeSearchResults,
    KnowledgeStats,
    MemoryDomain,
    MemoryDomainList,
    MemoryIndexEntry,
    MemoryIndexReconcileResult,
    MemoryQueryResult,
    MemoryStats,
    MemoryWriteResult,
    Mission,
    MissionConfidenceAlerts,
    NamespacedMemoryAcl,
    NamespacedMemoryAudit,
    NamespacedMemoryItem,
    NamespacedMemorySearch,
    NamespacedMemoryWriteResult,
    OIDCAuthResult,
    OIDCConfig,
    OIDCSettingsSaved,
    OIDCSettingsUpdate,
    OutgoingWebhook,
    OutgoingWebhookCreate,
    OutgoingWebhookDeliveries,
    OutgoingWebhookList,
    OutgoingWebhookStats,
    PlanResult,
    ProjectLogEntry,
    ProjectMemoryItem,
    RagQueryResult,
    ReactiveConflictResult,
    ReplayResult,
    ReportingStatus,
    ResumeResponse,
    RollbackResponse,
    SDKReliabilityStats,
    SecurityPostureHistory,
    SecurityPostureReport,
    SecurityPostureSnapshot,
    SecurityScanResult,
    SecurityStats,
    SessionSummary,
    SystemStatus,
    Task,
    TaskHandle,
    TeamAgentList,
    TeamReassignResult,
    TeamStatus,
    TeamWorkList,
    TimelineView,
    ToolPolicy,
    TraceList,
    TraceTimelineNode,
    UnifiedApprovalConfig,
    User,
    UserList,
    WorkflowDefinition,
    WorkflowExecution,
    WorkflowList,
)

_DEFAULT_BASE_URL = "http://localhost:3001"
_DEFAULT_TIMEOUT = 300.0
_DEFAULT_MAX_RETRIES = 3

# Methods that may be retried after a ReadTimeout, where the server may already
# have applied the request. Everything else (notably POST) is retried only when
# the connection was never established.
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE"})

_agent_id_counter = 0


class Agent:
    """A configured persona within Commander.

    Mirrors the TypeScript SDK ``Agent`` class. Agents are lightweight
    client-side configuration objects; their lifecycle is managed by
    ``CommanderClient``.
    """

    def __init__(self, config: AgentConfig) -> None:
        global _agent_id_counter
        if not config.name or not config.role:
            raise ValueError("Agent requires both `name` and `role`.")
        self.id: str = config.id or f"agent_{_agent_id_counter + 1}"
        _agent_id_counter += 1
        self.config: AgentConfig = config
        self.created_at: str = datetime.now(timezone.utc).isoformat()
        self.run_count: int = 0
        self.total_tokens_used: int = 0
        self.last_run_at: str | None = None

    def snapshot(self) -> AgentSnapshot:
        """Return a serializable snapshot of this agent's state."""
        return AgentSnapshot(
            id=self.id,
            name=self.config.name,
            role=self.config.role,
            tools=self.config.tools or [],
            topology=self.config.topology,
            runCount=self.run_count,
            totalTokensUsed=self.total_tokens_used,
            createdAt=self.created_at,
            lastRunAt=self.last_run_at,
        )

    @classmethod
    def from_snapshot(cls, snapshot: AgentSnapshot) -> Agent:
        """Restore an Agent from a snapshot."""
        agent = cls(
            AgentConfig(
                id=snapshot.id,
                name=snapshot.name,
                role=snapshot.role,
                tools=snapshot.tools,
                topology=snapshot.topology,
                maxSteps=None,
            )
        )
        agent.run_count = snapshot.run_count
        agent.total_tokens_used = snapshot.total_tokens_used
        agent.last_run_at = snapshot.last_run_at
        return agent


class CommanderClient:
    """Async HTTP client for Commander.

    Usage::

        async with CommanderClient(api_key="cmd-...") as client:
            result = await client.run("analyze this repo")
            print(result.summary)
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = _DEFAULT_TIMEOUT,
        max_retries: int = _DEFAULT_MAX_RETRIES,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key or os.environ.get("PRAETOR_API_KEY") or os.environ.get("COMMANDER_API_KEY")
        self._max_retries = max_retries
        self._http = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers=self._build_headers(),
        )
        # SDK-aligned local state (mirrors TypeScript SDK surface)
        self._connected: bool = False
        self._start_time: float = 0.0
        self._run_count: int = 0
        self._active_sessions: int = 0
        self._agents: dict[str, Agent] = {}
        self._tasks: dict[str, TaskHandle] = {}
        self._task_counter: int = 0
        self._sessions: list[SessionSummary] = []
        self._event_handlers: set[Callable[[ExecutionEvent], None]] = set()
        self._running_tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def __aenter__(self) -> CommanderClient:  # noqa: PYI034 - typing.Self needs Python 3.11
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def connect(self) -> None:
        """Verify connectivity to the Commander server.

        Unlike the TypeScript SDK, the Python client is a thin HTTP wrapper;
        ``connect`` performs a lightweight readiness probe and marks the
        client as connected. It is safe to call multiple times.
        """
        if self._connected:
            return
        await self._request("GET", "/ready")
        self._start_time = asyncio.get_event_loop().time()
        self._connected = True

    async def disconnect(self) -> None:
        """Close the HTTP client and clear local SDK state."""
        await self.close()
        self._event_handlers.clear()
        self._running_tasks.clear()
        self._connected = False

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._http.aclose()

    @property
    def is_connected(self) -> bool:
        """Whether the client has been explicitly connected."""
        return self._connected

    # ------------------------------------------------------------------
    # Execution (legacy / v1)
    # ------------------------------------------------------------------

    async def run(
        self,
        prompt: str,
        *,
        session_id: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        output_schema: dict[str, Any] | None = None,
        agent_id: str | None = None,
        tools: list[str] | None = None,
    ) -> ExecutionResult:
        """Execute an agent task.

        Args:
            prompt: Task description for the agent.
            session_id: Reuse an existing runtime session.
            provider: LLM provider override.
            model: Model override.
            output_schema: Optional structured output schema.
            agent_id: Optional agent identifier for agent-based execution.
            tools: Optional tool names available to the agent.

        Returns:
            Execution result with status, summary, and token usage.
        """
        body: dict[str, Any] = {"prompt": prompt}
        if session_id is not None:
            body["sessionId"] = session_id
        if provider is not None:
            body["provider"] = provider
        if model is not None:
            body["model"] = model
        if output_schema is not None:
            body["outputSchema"] = output_schema
        if agent_id is not None:
            body["agentId"] = agent_id
        if tools is not None:
            body["tools"] = tools
        data = await self._request("POST", "/api/v1/execute", json=body)
        result = ExecutionResult(**data)
        self._record_session(prompt, result, agent_id=agent_id)
        return result

    async def plan(
        self,
        task: str,
        *,
        provider: str | None = None,
        model: str | None = None,
    ) -> PlanResult:
        """Run zero-cost deliberation (no LLM call).

        Returns complexity, topology, cost-band, and token estimates
        without executing anything.

        Args:
            task: Task description to analyze.
            provider: Optional provider hint for estimate.
            model: Optional model hint for estimate.

        Returns:
            Plan estimate with topology, complexity, budget.
        """
        body: dict[str, Any] = {"task": task}
        if provider is not None:
            body["provider"] = provider
        if model is not None:
            body["model"] = model
        data = await self._request("POST", "/api/v1/plan", json=body)
        return PlanResult(**data)

    async def stream(self, session_id: str) -> CommanderSSEStream:
        """Get an async generator of SSE events for a running session.

        Args:
            session_id: The runtime session ID (returned by ``run()``).

        Returns:
            An async iterable of ``SSEEvent`` objects.
        """
        return CommanderSSEStream(self._http, session_id, self._base_url)

    # ------------------------------------------------------------------
    # Agent Management
    # ------------------------------------------------------------------

    def create_agent(self, config: AgentConfig) -> Agent:
        """Create and register a new agent.

        Args:
            config: Agent configuration (name, role, tools, topology, ...).

        Returns:
            The created Agent instance.
        """
        agent = Agent(config)
        self._agents[agent.id] = agent
        return agent

    def get_agent(self, agent_id: str) -> Agent | None:
        """Get a registered agent by id."""
        return self._agents.get(agent_id)

    def list_agents(self) -> list[Agent]:
        """List all registered agents."""
        return list(self._agents.values())

    def remove_agent(self, agent_id: str) -> bool:
        """Remove a registered agent.

        Returns:
            True if the agent existed and was removed.
        """
        if agent_id in self._agents:
            del self._agents[agent_id]
            return True
        return False

    def get_agent_snapshots(self) -> list[AgentSnapshot]:
        """Return serializable snapshots of all registered agents."""
        return [a.snapshot() for a in self._agents.values()]

    # ------------------------------------------------------------------
    # Task Submission
    # ------------------------------------------------------------------

    def submit_task(self, agent: Agent, task: Task) -> TaskHandle:
        """Submit a task for asynchronous execution by an agent.

        Args:
            agent: The agent that will execute the task.
            task: Task definition (goal, output schema, context, ...).

        Returns:
            A TaskHandle with execution metadata.
        """
        self._task_counter += 1
        handle = TaskHandle(
            id=f"task_{self._task_counter}",
            task=task,
            status="pending",
            agentId=agent.id,
            submittedAt=datetime.now(timezone.utc).isoformat(),
            completedAt=None,
        )
        self._tasks[handle.id] = handle

        # Schedule execution without awaiting so the caller gets the handle immediately.
        bg_task = asyncio.create_task(self._execute_task(agent, handle))
        self._running_tasks.add(bg_task)
        bg_task.add_done_callback(self._running_tasks.discard)
        return handle

    async def await_task(
        self, task_id: str, timeout_ms: int = 120_000
    ) -> ExecutionResult | None:
        """Wait for a submitted task to complete.

        Args:
            task_id: Task handle id returned by ``submit_task``.
            timeout_ms: Maximum time to wait in milliseconds.

        Returns:
            The execution result, or None if the task was not found or timed out.
        """
        handle = self._tasks.get(task_id)
        if not handle:
            return None
        if handle.result is not None:
            return handle.result
        deadline = asyncio.get_event_loop().time() + (timeout_ms / 1000.0)
        while asyncio.get_event_loop().time() < deadline:
            handle = self._tasks.get(task_id)
            if handle is None:
                return None
            if handle.result is not None:
                return handle.result
            await asyncio.sleep(0.2)
        return None

    def get_task_handle(self, task_id: str) -> TaskHandle | None:
        """Get a task handle by id."""
        return self._tasks.get(task_id)

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a pending or running task.

        Returns:
            True if the task was in a cancellable state.
        """
        handle = self._tasks.get(task_id)
        if not handle or handle.status in {"completed", "failed", "cancelled"}:
            return False
        handle.status = "cancelled"
        handle.completed_at = datetime.now(timezone.utc).isoformat()
        return True

    async def _execute_task(self, agent: Agent, handle: TaskHandle) -> None:
        """Internal coroutine that executes a task and updates its handle."""
        handle.status = "running"
        agent.last_run_at = datetime.now(timezone.utc).isoformat()
        self._active_sessions += 1
        self._dispatch_event(
            ExecutionEvent(
                type="agent.started",
                timestamp=datetime.now(timezone.utc).isoformat(),
                data={"agentId": agent.id, "taskId": handle.id},
            )
        )
        try:
            result = await self.run(
                handle.task.goal,
                output_schema=handle.task.output_schema,
                agent_id=agent.id,
                tools=agent.config.tools,
            )
            handle.status = "completed"
            handle.completed_at = datetime.now(timezone.utc).isoformat()
            handle.result = result
            agent.run_count += 1
            agent.total_tokens_used += result.total_token_usage
            self._run_count += 1
            self._dispatch_event(
                ExecutionEvent(
                    type="agent.completed",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    data={
                        "agentId": agent.id,
                        "taskId": handle.id,
                        "status": result.status,
                    },
                )
            )
        except Exception as exc:  # noqa: BLE001 - agent failures must be captured, not propagated
            error = str(exc)
            handle.status = "failed"
            handle.completed_at = datetime.now(timezone.utc).isoformat()
            handle.result = ExecutionResult(
                status="FAILED",
                summary=error,
                error=error,
            )
            self._dispatch_event(
                ExecutionEvent(
                    type="agent.failed",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    data={"agentId": agent.id, "taskId": handle.id, "error": error},
                )
            )
        finally:
            self._active_sessions = max(0, self._active_sessions - 1)

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------

    def on_event(self, handler: Callable[[ExecutionEvent], None]) -> Callable[[], None]:
        """Register a handler for execution lifecycle events.

        Args:
            handler: Callback receiving an ExecutionEvent.

        Returns:
            A function that unsubscribes the handler when called.
        """
        self._event_handlers.add(handler)

        def unsubscribe() -> None:
            self._event_handlers.discard(handler)

        return unsubscribe

    def _dispatch_event(self, event: ExecutionEvent) -> None:
        """Dispatch an event to all registered handlers (best-effort)."""
        for handler in list(self._event_handlers):
            try:
                handler(event)
            except Exception:  # noqa: BLE001, S110 - one failing handler must not disrupt the others
                # One failing handler must not disrupt the others.
                pass

    # ------------------------------------------------------------------
    # Session History
    # ------------------------------------------------------------------

    def list_sessions(self) -> list[SessionSummary]:
        """List execution sessions, most recent first."""
        return sorted(
            self._sessions,
            key=lambda s: s.timestamp,
            reverse=True,
        )

    def _record_session(
        self,
        task: str,
        result: ExecutionResult,
        *,
        agent_id: str | None = None,
    ) -> None:
        """Record a session summary after a run completes."""
        status = result.status.upper() if result.status else "UNKNOWN"
        self._sessions.append(
            SessionSummary(
                runId=result.run_id or "",
                task=task[:80],
                status=status,
                agentId=agent_id or "commander-sdk",
                topology="SINGLE",
                tokenUsage=result.total_token_usage,
                durationMs=result.total_duration_ms,
                timestamp=datetime.now(timezone.utc).isoformat(),
                error=result.error,
            )
        )
        if len(self._sessions) > 1000:
            self._sessions = self._sessions[-1000:]

    # ------------------------------------------------------------------
    # System Status & Stats
    # ------------------------------------------------------------------

    async def get_stats(self) -> MemoryStats:
        """Get live memory statistics from the server.

        Returns:
            Memory statistics from the Three-Layer Memory system.
        """
        return await self.memory_stats()

    async def get_status(self) -> SystemStatus:
        """Get current system status, merging server state with local counters."""
        data = await self._request("GET", "/api/v1/status")
        status = SystemStatus(**data)
        # Merge local agent count into subscriber_counts for SDK alignment.
        if "agents" not in status.subscriber_counts:
            status.subscriber_counts["agents"] = len(self._agents)
        return status

    async def get_reliability_stats(self) -> SDKReliabilityStats:
        """Get reliability statistics from available server endpoints.

        This is a best-effort aggregation for HTTP clients. The TypeScript
        SDK can read the runtime reliability engine directly; the Python
        client derives equivalent signals from DLQ, compensation, checkpoint,
        and health endpoints.
        """
        circuit_state = "CLOSED"
        circuit_failures = 0
        pending_compensations = 0
        checkpoint_count = 0
        dlq_total_entries = 0

        try:
            dlq_stats = await self.get_dlq_stats()
            dlq_total_entries = dlq_stats.total_entries
        except Exception:  # noqa: BLE001, S110 - stats are best-effort
            pass

        try:
            compensation = await self._request("GET", "/api/v1/compensation")
            if isinstance(compensation, dict):
                pending_compensations = int(compensation.get("pending", 0) or 0)
        except Exception:  # noqa: BLE001, S110 - stats are best-effort
            pass

        try:
            checkpoints = await self.list_checkpoints()
            checkpoint_count = checkpoints.count
        except Exception:  # noqa: BLE001, S110 - stats are best-effort
            pass

        try:
            health = await self.health_detailed()
            if isinstance(health, dict):
                for component in health.get("components", []):
                    name = component.get("name", "").lower()
                    if name == "circuit_breaker" and isinstance(
                        component.get("status"), str
                    ):
                        circuit_state = component["status"].upper()
                    if name == "circuit_breaker" and "failures" in component:
                        circuit_failures = int(component["failures"])
        except Exception:  # noqa: BLE001, S110 - stats are best-effort
            pass

        return SDKReliabilityStats(
            circuitState=circuit_state,
            circuitFailures=circuit_failures,
            dlqTotalEntries=dlq_total_entries,
            pendingCompensations=pending_compensations,
            checkpointCount=checkpoint_count,
        )

    # ------------------------------------------------------------------
    # Runtime
    # ------------------------------------------------------------------

    async def runtime_execute(
        self,
        agent_id: str,
        goal: str,
        *,
        project_id: str = "default",
        mission_id: str | None = None,
        context_data: dict[str, Any] | None = None,
        available_tools: list[str] | None = None,
        token_budget: int = 8000,
    ) -> ExecutionResult:
        """Execute an agent task via the runtime API.

        Args:
            agent_id: Agent identifier.
            goal: Task description.
            project_id: Project identifier.
            mission_id: Optional mission identifier.
            context_data: Additional context key/value data.
            available_tools: Tool names available to the agent.
            token_budget: Maximum tokens for the run.

        Returns:
            Execution result.
        """
        body: dict[str, Any] = {
            "agentId": agent_id,
            "goal": goal,
            "projectId": project_id,
            "contextData": context_data or {},
            "availableTools": available_tools or [],
            "tokenBudget": token_budget,
        }
        if mission_id is not None:
            body["missionId"] = mission_id
        data = await self._request("POST", "/api/runtime/execute", json=body)
        return ExecutionResult(**data)

    async def runtime_route(
        self,
        goal: str,
        *,
        token_budget: int = 4000,
        available_tools: list[str] | None = None,
        context_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Preview the routing decision for a goal.

        Args:
            goal: Task description.
            token_budget: Token budget hint.
            available_tools: Tool names available.
            context_data: Additional context.

        Returns:
            Routing decision dictionary.
        """
        body: dict[str, Any] = {
            "goal": goal,
            "tokenBudget": token_budget,
            "availableTools": available_tools or [],
            "contextData": context_data or {},
        }
        return await self._request("POST", "/api/runtime/route", json=body)

    async def list_traces(
        self,
        *,
        agent_id: str | None = None,
        limit: int = 50,
    ) -> TraceList:
        """List execution traces.

        Args:
            agent_id: Optional agent filter.
            limit: Maximum traces to return.

        Returns:
            List of trace records.
        """
        params: dict[str, Any] = {"limit": limit}
        if agent_id is not None:
            params["agentId"] = agent_id
        data = await self._request("GET", "/api/runtime/traces", params=params)
        return TraceList(**data)

    async def get_trace(self, run_id: str) -> dict[str, Any]:
        """Get a specific execution trace.

        Args:
            run_id: Run identifier.

        Returns:
            Trace detail dictionary.
        """
        return await self._request("GET", f"/api/runtime/traces/{run_id}")

    async def trace_summary(self) -> dict[str, Any]:
        """Get trace summary statistics."""
        return await self._request("GET", "/api/runtime/traces/summary")

    async def bus_topics(self) -> BusTopics:
        """Get active message bus topics and subscriber counts."""
        data = await self._request("GET", "/api/runtime/bus/topics")
        return BusTopics(**data)

    async def learner_stats(self) -> dict[str, Any]:
        """Get meta-learner statistics and suggestions."""
        return await self._request("GET", "/api/runtime/learner/stats")

    # ------------------------------------------------------------------
    # Runtime control
    # ------------------------------------------------------------------

    async def pause_run(self, run_id: str) -> dict[str, Any]:
        """Signal a running execution to pause.

        Args:
            run_id: Run identifier.

        Returns:
            Control response dictionary.
        """
        return await self._request("POST", "/api/runtime/pause", json={"runId": run_id})

    async def resume_run(
        self,
        run_id: str,
        *,
        user_instructions: str | None = None,
    ) -> ResumeResponse:
        """Resume a paused execution.

        Args:
            run_id: Run identifier.
            user_instructions: Optional instructions to inject on resume.

        Returns:
            Resume response.
        """
        body: dict[str, Any] = {"runId": run_id}
        if user_instructions is not None:
            body["userInstructions"] = user_instructions
        data = await self._request("POST", "/api/runtime/resume", json=body)
        return ResumeResponse(**data)

    async def rollback_run(
        self,
        run_id: str,
        step_number: int,
        *,
        user_instructions: str | None = None,
    ) -> RollbackResponse:
        """Rollback a run to a specific step and re-execute.

        Args:
            run_id: Run identifier.
            step_number: Target step number.
            user_instructions: Optional correction instructions.

        Returns:
            Rollback response.
        """
        body: dict[str, Any] = {"runId": run_id, "stepNumber": step_number}
        if user_instructions is not None:
            body["userInstructions"] = user_instructions
        data = await self._request("POST", "/api/runtime/rollback", json=body)
        return RollbackResponse(**data)

    async def active_runs(self) -> ActiveRuns:
        """List currently active runs."""
        data = await self._request("GET", "/api/runtime/active")
        return ActiveRuns(**data)

    # ------------------------------------------------------------------
    # Chat
    # ------------------------------------------------------------------

    async def chat(
        self,
        message: str,
        *,
        agent_id: str | None = None,
        mission_id: str | None = None,
        project_id: str | None = None,
    ) -> ChatResponse:
        """Send a chat message to an agent.

        Args:
            message: User message.
            agent_id: Optional agent identifier.
            mission_id: Optional mission identifier.
            project_id: Optional project identifier.

        Returns:
            Chat response.
        """
        body: dict[str, Any] = {"message": message}
        if agent_id is not None:
            body["agentId"] = agent_id
        if mission_id is not None:
            body["missionId"] = mission_id
        if project_id is not None:
            body["projectId"] = project_id
        data = await self._request("POST", "/api/chat", json=body)
        return ChatResponse(**data)

    async def chat_stream(
        self,
        message: str,
        *,
        agent_id: str | None = None,
        mission_id: str | None = None,
        project_id: str | None = None,
    ) -> _ChatSSEStream:
        """Send a streaming chat message to an agent.

        Returns:
            An async iterable of ``ChatStreamEvent`` objects.
        """
        params = {"stream": "true"}
        body: dict[str, Any] = {"message": message}
        if agent_id is not None:
            body["agentId"] = agent_id
        if mission_id is not None:
            body["missionId"] = mission_id
        if project_id is not None:
            body["projectId"] = project_id
        return _ChatSSEStream(self._http, "/api/chat", params, body)

    async def chat_history(
        self,
        *,
        project_id: str | None = None,
    ) -> ChatHistory:
        """Retrieve chat history.

        Args:
            project_id: Optional project identifier.

        Returns:
            Chat history.
        """
        params: dict[str, Any] = {}
        if project_id is not None:
            params["projectId"] = project_id
        data = await self._request("GET", "/api/chat/history", params=params)
        # Server returns the list directly under a project key; normalize.
        if isinstance(data, list):
            return ChatHistory(
                project_id=project_id or "",
                messages=data,
            )
        return ChatHistory(
            project_id=data.get("projectId", project_id or ""),
            messages=data.get("messages", data),
        )

    # ------------------------------------------------------------------
    # Memory
    # ------------------------------------------------------------------

    async def memory_write(
        self,
        content: str,
        *,
        importance: float = 0.5,
        tags: list[str] | None = None,
        layer: str = "episodic",
    ) -> MemoryWriteResult:
        """Write to memory.

        Args:
            content: The content to store.
            importance: Importance score 0-1 (higher = more likely recalled).
            tags: Tags for categorical recall.
            layer: Memory layer (working, episodic, longterm).

        Returns:
            Write result with entry id or rejection info.
        """
        body: dict[str, Any] = {
            "action": "write",
            "content": content,
            "importance": importance,
            "layer": layer,
        }
        if tags is not None:
            body["tags"] = tags
        data = await self._request("POST", "/api/v1/memory", json=body)
        return MemoryWriteResult(**data)

    async def memory_query(
        self,
        *,
        keywords: list[str] | None = None,
        layer: str | None = None,
        importance_threshold: float = 0.3,
        limit: int = 10,
    ) -> MemoryQueryResult:
        """Query memory.

        Args:
            keywords: Keywords for semantic search.
            layer: Filter by memory layer.
            importance_threshold: Minimum importance (0-1).
            limit: Maximum results.

        Returns:
            Matching memory entries.
        """
        body: dict[str, Any] = {
            "action": "query",
            "importanceThreshold": importance_threshold,
            "limit": limit,
        }
        if keywords is not None:
            body["keywords"] = keywords
        if layer is not None:
            body["layer"] = layer
        data = await self._request("POST", "/api/v1/memory", json=body)
        return MemoryQueryResult(**data)

    async def memory_stats(self) -> MemoryStats:
        """Get memory statistics.

        Returns:
            Stats including total entries, per-layer counts, avg importance.
        """
        body: dict[str, Any] = {"action": "stats"}
        data = await self._request("POST", "/api/v1/memory", json=body)
        return MemoryStats(**data)

    # ------------------------------------------------------------------
    # Governance
    # ------------------------------------------------------------------

    async def create_checkpoint(
        self,
        mission_id: str,
        task_id: str,
        agent_id: str,
        task_description: str,
        *,
        agent_role: str = "agent",
        governance_mode: str = "SINGLE",
        risk_score: float = 0.0,
        risk_level: str = "LOW",
        risk_factors: list[dict[str, Any]] | None = None,
        approvers: list[str] | None = None,
        timeout: int | None = None,
    ) -> Checkpoint:
        """Create a governance checkpoint.

        Args:
            mission_id: Mission identifier.
            task_id: Task identifier.
            agent_id: Agent identifier.
            task_description: Description of the task requiring approval.
            agent_role: Role of the agent.
            governance_mode: SINGLE, MULTI, or AUTO.
            risk_score: Numeric risk score.
            risk_level: LOW, MEDIUM, HIGH, or CRITICAL.
            risk_factors: List of risk factor dictionaries.
            approvers: List of approver identifiers.
            timeout: Optional timeout in seconds.

        Returns:
            Created checkpoint.
        """
        body: dict[str, Any] = {
            "missionId": mission_id,
            "taskId": task_id,
            "agentId": agent_id,
            "agentRole": agent_role,
            "taskDescription": task_description,
            "governanceMode": governance_mode,
            "riskScore": risk_score,
            "riskLevel": risk_level,
            "riskFactors": risk_factors or [],
            "approvers": approvers or [],
        }
        if timeout is not None:
            body["timeout"] = timeout
        data = await self._request("POST", "/api/governance/checkpoints", json=body)
        return Checkpoint(**data)

    async def get_checkpoint(self, checkpoint_id: str) -> Checkpoint:
        """Get a checkpoint by id."""
        data = await self._request(
            "GET", f"/api/governance/checkpoints/{checkpoint_id}"
        )
        return Checkpoint(**data)

    async def list_checkpoints(
        self,
        *,
        mission_id: str | None = None,
        approver_id: str | None = None,
        status: str | None = None,
    ) -> CheckpointList:
        """List governance checkpoints with optional filters."""
        params: dict[str, Any] = {}
        if mission_id is not None:
            params["missionId"] = mission_id
        if approver_id is not None:
            params["approverId"] = approver_id
        if status is not None:
            params["status"] = status
        data = await self._request("GET", "/api/governance/checkpoints", params=params)
        return CheckpointList(**data)

    async def approve_checkpoint(
        self,
        checkpoint_id: str,
        reviewer_id: str,
        *,
        reason: str | None = None,
        conditions: list[dict[str, Any]] | None = None,
    ) -> Checkpoint:
        """Approve a checkpoint."""
        body: dict[str, Any] = {"reviewerId": reviewer_id}
        if reason is not None:
            body["reason"] = reason
        if conditions is not None:
            body["conditions"] = conditions
        data = await self._request(
            "POST",
            f"/api/governance/checkpoints/{checkpoint_id}/approve",
            json=body,
        )
        return Checkpoint(**data)

    async def reject_checkpoint(
        self,
        checkpoint_id: str,
        reviewer_id: str,
        reason: str,
    ) -> Checkpoint:
        """Reject a checkpoint."""
        data = await self._request(
            "POST",
            f"/api/governance/checkpoints/{checkpoint_id}/reject",
            json={"reviewerId": reviewer_id, "reason": reason},
        )
        return Checkpoint(**data)

    # ------------------------------------------------------------------
    # Cost
    # ------------------------------------------------------------------

    async def cost_summary(self) -> CostSummary:
        """Get aggregated cost summary."""
        data = await self._request("GET", "/api/cost/summary")
        return CostSummary(**data)

    async def cost_records(
        self,
        *,
        run_id: str | None = None,
        limit: int = 50,
    ) -> CostRecords:
        """Get recent LLM cost records.

        Args:
            run_id: Optional run filter.
            limit: Maximum records (max 500).

        Returns:
            Cost records.
        """
        params: dict[str, Any] = {"limit": min(limit, 500)}
        if run_id is not None:
            params["runId"] = run_id
        data = await self._request("GET", "/api/cost/records", params=params)
        return CostRecords(**data)

    async def cost_budget(self) -> CostBudget:
        """Get monthly budget status and alerts."""
        data = await self._request("GET", "/api/cost/budget")
        return CostBudget(**data)

    async def cost_dashboard(
        self, *, time_range: CostTimeRange = "7d"
    ) -> CostDashboardResponse:
        """Get comprehensive cost analytics dashboard.

        Args:
            time_range: Time window for aggregation.

        Returns:
            Dashboard with summary, per-model/tool/user breakdown, and trend.
        """
        data = await self._request(
            "GET", "/api/cost/dashboard", params={"timeRange": time_range}
        )
        return CostDashboardResponse(**data)

    # ------------------------------------------------------------------
    # Knowledge Base
    # ------------------------------------------------------------------

    async def upload_document(
        self,
        content: str,
        name: str,
        type: str,
        *,
        tags: list[str] | None = None,
    ) -> KnowledgeDocument:
        """Upload and index a document in the knowledge base.

        Args:
            content: Raw document content.
            name: Document name.
            type: Document type (e.g., markdown, text, json).
            tags: Optional tags.

        Returns:
            Created document.
        """
        body: dict[str, Any] = {
            "content": content,
            "name": name,
            "type": type,
        }
        if tags is not None:
            body["tags"] = tags
        data = await self._request("POST", "/api/knowledge/documents", json=body)
        return KnowledgeDocument(**data.get("document", data))

    async def list_documents(
        self,
        *,
        page: int = 1,
        limit: int = 20,
    ) -> DocumentList:
        """List knowledge base documents (paginated)."""
        params = {"page": page, "limit": limit}
        data = await self._request("GET", "/api/knowledge/documents", params=params)
        return DocumentList(**data)

    async def get_document(self, document_id: str) -> KnowledgeDocument:
        """Get a single knowledge document."""
        data = await self._request("GET", f"/api/knowledge/documents/{document_id}")
        return KnowledgeDocument(**data)

    async def delete_document(self, document_id: str) -> None:
        """Delete a knowledge document and its chunks."""
        await self._request("DELETE", f"/api/knowledge/documents/{document_id}")

    async def search_knowledge(
        self,
        query: str,
        *,
        top_k: int = 10,
        doc_ids: list[str] | None = None,
    ) -> KnowledgeSearchResults:
        """Semantic search over the knowledge base.

        Args:
            query: Search query.
            top_k: Number of top results.
            doc_ids: Optional document ids to restrict search.

        Returns:
            Search results.
        """
        body: dict[str, Any] = {"query": query, "topK": top_k}
        if doc_ids is not None:
            body["docIds"] = doc_ids
        data = await self._request("POST", "/api/knowledge/search", json=body)
        return KnowledgeSearchResults(**data)

    async def rag_query(
        self,
        query: str,
        *,
        top_k: int = 10,
        doc_ids: list[str] | None = None,
    ) -> RagQueryResult:
        """Run a RAG query (search + context string).

        Args:
            query: Query string.
            top_k: Number of top chunks to retrieve.
            doc_ids: Optional document ids to restrict search.

        Returns:
            RAG query result with context string.
        """
        body: dict[str, Any] = {"query": query, "topK": top_k}
        if doc_ids is not None:
            body["docIds"] = doc_ids
        data = await self._request("POST", "/api/knowledge/query", json=body)
        return RagQueryResult(**data)

    async def knowledge_stats(self) -> KnowledgeStats:
        """Get knowledge base aggregate statistics."""
        data = await self._request("GET", "/api/knowledge/stats")
        return KnowledgeStats(**data)

    # ------------------------------------------------------------------
    # Monitoring
    # ------------------------------------------------------------------

    async def health(self) -> HealthStatus:
        """Liveness probe.

        Returns:
            Health status with uptime and active session count.
        """
        data = await self._request("GET", "/health")
        return HealthStatus(**data)

    async def health_detailed(self) -> dict[str, Any]:
        """Detailed health check with component statuses.

        Returns:
            Detailed health report including circuit breaker state,
            DLQ size, checkpoint staleness, etc.
        """
        return await self._request("GET", "/health/detailed")

    async def readiness(self) -> dict[str, Any]:
        """Readiness probe."""
        return await self._request("GET", "/ready")

    async def system_status(self) -> SystemStatus:
        """System status snapshot.

        Returns:
            Active sessions, bus topics, subscriber counts.
        """
        data = await self._request("GET", "/api/v1/status")
        return SystemStatus(**data)

    async def metrics(self) -> str:
        """Export metrics in OpenMetrics text format.

        Returns:
            Prometheus-compatible metrics text.
        """
        response = await self._http.get(
            "/metrics",
            headers={"Accept": "text/plain"},
        )
        response.raise_for_status()
        return response.text

    # ------------------------------------------------------------------
    # Projects
    # ------------------------------------------------------------------

    async def list_projects(self) -> list[dict[str, Any]]:
        """List all projects."""
        data = await self._request("GET", "/projects")
        return data if isinstance(data, list) else []

    async def get_project_war_room(self, project_id: str) -> dict[str, Any]:
        """Get the war-room snapshot for a project."""
        return await self._request("GET", f"/projects/{project_id}/war-room")

    async def list_project_agents(self, project_id: str) -> list[dict[str, Any]]:
        """List agents belonging to a project."""
        data = await self._request("GET", f"/projects/{project_id}/agents")
        return data if isinstance(data, list) else []

    async def get_agent_state(self, project_id: str, agent_id: str) -> AgentState:
        """Get persisted state for a project agent."""
        data = await self._request(
            "GET", f"/projects/{project_id}/agents/{agent_id}/state"
        )
        return AgentState(**data)

    async def update_agent_state(
        self,
        project_id: str,
        agent_id: str,
        *,
        summary: str | None = None,
        preferences: str | None = None,
        tags: list[str] | None = None,
    ) -> AgentState:
        """Update persisted state for a project agent."""
        body: dict[str, Any] = {}
        if summary is not None:
            body["summary"] = summary
        if preferences is not None:
            body["preferences"] = preferences
        if tags is not None:
            body["tags"] = tags
        data = await self._request(
            "PATCH", f"/projects/{project_id}/agents/{agent_id}/state", json=body
        )
        return AgentState(**data)

    async def get_run_context(
        self,
        project_id: str,
        *,
        agent_id: str | None = None,
        mission_id: str | None = None,
        memory_limit: int | None = None,
        intent: str | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Build a run context for a project (missions, memory, roster)."""
        params: dict[str, Any] = {}
        if agent_id is not None:
            params["agentId"] = agent_id
        if mission_id is not None:
            params["missionId"] = mission_id
        if memory_limit is not None:
            params["memoryLimit"] = memory_limit
        if intent is not None:
            params["intent"] = intent
        if run_id is not None:
            params["runId"] = run_id
        return await self._request(
            "GET", f"/projects/{project_id}/run-context", params=params
        )

    async def list_project_memory(
        self, project_id: str, *, limit: int = 24
    ) -> list[ProjectMemoryItem]:
        """List project-scoped memory items."""
        data = await self._request(
            "GET", f"/projects/{project_id}/memory", params={"limit": limit}
        )
        items = data if isinstance(data, list) else []
        return [ProjectMemoryItem(**item) for item in items]

    async def search_project_memory(
        self,
        project_id: str,
        *,
        query: str | None = None,
        kind: str | None = None,
        tags: list[str] | None = None,
        limit: int | None = None,
    ) -> list[ProjectMemoryItem]:
        """Search project-scoped memory."""
        params: dict[str, Any] = {}
        if query is not None:
            params["q"] = query
        if kind is not None:
            params["kind"] = kind
        if tags is not None:
            params["tags"] = ",".join(tags)
        if limit is not None:
            params["limit"] = limit
        data = await self._request(
            "GET", f"/projects/{project_id}/memory/search", params=params
        )
        items = data if isinstance(data, list) else []
        return [ProjectMemoryItem(**item) for item in items]

    async def create_project_memory(
        self,
        project_id: str,
        title: str,
        content: str,
        *,
        kind: str = "SUMMARY",
        mission_id: str | None = None,
        agent_id: str | None = None,
        tags: list[str] | None = None,
    ) -> ProjectMemoryItem:
        """Append an item to project memory."""
        body: dict[str, Any] = {
            "title": title,
            "content": content,
            "kind": kind,
        }
        if mission_id is not None:
            body["missionId"] = mission_id
        if agent_id is not None:
            body["agentId"] = agent_id
        if tags is not None:
            body["tags"] = tags
        data = await self._request("POST", f"/projects/{project_id}/memory", json=body)
        return ProjectMemoryItem(**data)

    async def create_mission(
        self,
        project_id: str,
        title: str,
        assigned_agent_id: str,
        *,
        objective: str | None = None,
        priority: str = "MEDIUM",
        risk_level: str | None = None,
        governance_mode: str | None = None,
    ) -> Mission:
        """Create a mission inside a project."""
        body: dict[str, Any] = {
            "title": title,
            "assignedAgentId": assigned_agent_id,
            "priority": priority,
        }
        if objective is not None:
            body["objective"] = objective
        if risk_level is not None:
            body["riskLevel"] = risk_level
        if governance_mode is not None:
            body["governanceMode"] = governance_mode
        data = await self._request(
            "POST", f"/projects/{project_id}/missions", json=body
        )
        return Mission(**data)

    async def update_mission(
        self,
        mission_id: str,
        *,
        status: str | None = None,
        priority: str | None = None,
        assigned_agent_id: str | None = None,
        title: str | None = None,
        objective: str | None = None,
        risk_level: str | None = None,
        governance_mode: str | None = None,
    ) -> Mission:
        """Update a mission."""
        body: dict[str, Any] = {}
        if status is not None:
            body["status"] = status
        if priority is not None:
            body["priority"] = priority
        if assigned_agent_id is not None:
            body["assignedAgentId"] = assigned_agent_id
        if title is not None:
            body["title"] = title
        if objective is not None:
            body["objective"] = objective
        if risk_level is not None:
            body["riskLevel"] = risk_level
        if governance_mode is not None:
            body["governanceMode"] = governance_mode
        data = await self._request("PATCH", f"/missions/{mission_id}", json=body)
        return Mission(**data)

    async def approve_mission(
        self,
        mission_id: str,
        *,
        approver: str | None = None,
        comment: str | None = None,
    ) -> Mission:
        """Explicitly approve a HIGH/CRITICAL mission in MANUAL governance mode."""
        body: dict[str, Any] = {}
        if approver is not None:
            body["approver"] = approver
        if comment is not None:
            body["comment"] = comment
        data = await self._request("POST", f"/missions/{mission_id}/approve", json=body)
        return Mission(**data)

    async def create_mission_log(
        self, mission_id: str, message: str, *, level: str = "INFO"
    ) -> ProjectLogEntry:
        """Create a log entry for a mission."""
        data = await self._request(
            "POST",
            f"/missions/{mission_id}/logs",
            json={"message": message, "level": level},
        )
        return ProjectLogEntry(**data)

    async def get_project_governance_stats(self, project_id: str) -> dict[str, Any]:
        """Get governance statistics for a project."""
        return await self._request("GET", f"/projects/{project_id}/governance/stats")

    async def get_project_governance_alerts(
        self, project_id: str
    ) -> list[dict[str, Any]]:
        """Get governance alerts for a project."""
        data = await self._request("GET", f"/projects/{project_id}/governance/alerts")
        return data if isinstance(data, list) else []

    async def get_project_governance_weekly_report(self, project_id: str) -> str:
        """Get the weekly governance report as Markdown text."""
        response = await self._http.get(
            f"/projects/{project_id}/governance/weekly-report",
            headers={"Accept": "text/markdown"},
        )
        response.raise_for_status()
        return response.text

    # ------------------------------------------------------------------
    # Workflows
    # ------------------------------------------------------------------

    async def list_workflows(self) -> WorkflowList:
        """List all stored workflows (summary view)."""
        data = await self._request("GET", "/api/workflows")
        return WorkflowList(**data)

    async def create_workflow(
        self,
        name: str,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        *,
        description: str | None = None,
    ) -> WorkflowDefinition:
        """Create a new workflow definition."""
        body: dict[str, Any] = {
            "name": name,
            "nodes": nodes,
            "edges": edges,
        }
        if description is not None:
            body["description"] = description
        data = await self._request("POST", "/api/workflows", json=body)
        return WorkflowDefinition(**data.get("workflow", data))

    async def get_workflow(self, workflow_id: str) -> WorkflowDefinition:
        """Get a workflow definition by id."""
        data = await self._request("GET", f"/api/workflows/{workflow_id}")
        return WorkflowDefinition(**data.get("workflow", data))

    async def update_workflow(
        self,
        workflow_id: str,
        name: str,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        *,
        description: str | None = None,
    ) -> WorkflowDefinition:
        """Update an existing workflow definition."""
        body: dict[str, Any] = {
            "name": name,
            "nodes": nodes,
            "edges": edges,
        }
        if description is not None:
            body["description"] = description
        data = await self._request("PUT", f"/api/workflows/{workflow_id}", json=body)
        return WorkflowDefinition(**data.get("workflow", data))

    async def delete_workflow(self, workflow_id: str) -> dict[str, Any]:
        """Delete a workflow definition."""
        return await self._request("DELETE", f"/api/workflows/{workflow_id}")

    async def execute_workflow(self, workflow_id: str) -> WorkflowExecution:
        """Preview-execute a workflow and return the generated pipeline."""
        data = await self._request("POST", f"/api/workflows/{workflow_id}/execute")
        return WorkflowExecution(**data)

    # ------------------------------------------------------------------
    # Audit Logs
    # ------------------------------------------------------------------

    async def list_audit_logs(
        self,
        *,
        source: str | None = None,
        severity: str | None = None,
        event_type: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        user_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> AuditLogs:
        """Query unified audit logs with filters and pagination."""
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if source is not None:
            params["source"] = source
        if severity is not None:
            params["severity"] = severity
        if event_type is not None:
            params["eventType"] = event_type
        if start_time is not None:
            params["startTime"] = start_time
        if end_time is not None:
            params["endTime"] = end_time
        if user_id is not None:
            params["userId"] = user_id
        data = await self._request("GET", "/api/audit/logs", params=params)
        return AuditLogs(**data)

    async def get_audit_stats(self) -> AuditStats:
        """Get aggregate audit log statistics."""
        data = await self._request("GET", "/api/audit/stats")
        return AuditStats(**data)

    async def get_audit_sources(self) -> list[AuditSourceInfo]:
        """Get per-source availability and recency."""
        data = await self._request("GET", "/api/audit/sources")
        items = data if isinstance(data, list) else []
        return [AuditSourceInfo(**item) for item in items]

    async def export_audit_logs(
        self,
        *,
        source: str | None = None,
        severity: str | None = None,
        event_type: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Export audit logs with the same filters (no pagination)."""
        params: dict[str, Any] = {}
        if source is not None:
            params["source"] = source
        if severity is not None:
            params["severity"] = severity
        if event_type is not None:
            params["eventType"] = event_type
        if start_time is not None:
            params["startTime"] = start_time
        if end_time is not None:
            params["endTime"] = end_time
        if user_id is not None:
            params["userId"] = user_id
        return await self._request("GET", "/api/audit/logs/export", params=params)

    # ------------------------------------------------------------------
    # API Keys
    # ------------------------------------------------------------------

    async def list_api_keys(self) -> ApiKeyList:
        """List API key records (admin only, no secrets)."""
        data = await self._request("GET", "/api/admin/api-keys")
        return ApiKeyList(**data)

    async def create_api_key(
        self, name: str, scopes: list[str] | None = None
    ) -> ApiKeyCreateResult:
        """Create a new API key (admin only)."""
        body: dict[str, Any] = {"name": name}
        if scopes is not None:
            body["scopes"] = scopes
        data = await self._request("POST", "/api/admin/api-keys", json=body)
        return ApiKeyCreateResult(**data)

    async def revoke_api_key(self, key_id: str) -> dict[str, Any]:
        """Revoke an API key (admin only)."""
        return await self._request("DELETE", f"/api/admin/api-keys/{key_id}")

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------

    async def get_settings(self) -> AppSettings:
        """Read current global settings."""
        data = await self._request("GET", "/api/settings")
        return AppSettings(**data.get("settings", data))

    async def update_settings(self, settings: AppSettings) -> AppSettings:
        """Update global settings (admin only)."""
        data = await self._request(
            "PUT",
            "/api/settings",
            json=settings.model_dump(by_alias=False, exclude_none=True),
        )
        return AppSettings(**data.get("settings", data))

    # ------------------------------------------------------------------
    # Security Posture
    # ------------------------------------------------------------------

    async def get_security_posture(self) -> SecurityPostureReport:
        """Get the latest self-assessed security posture report."""
        data = await self._request("GET", "/api/security/posture")
        return SecurityPostureReport(**data)

    async def get_security_posture_history(
        self, *, limit: int = 50
    ) -> SecurityPostureHistory:
        """Get security posture snapshot history."""
        data = await self._request(
            "GET", "/api/security/posture/history", params={"limit": limit}
        )
        return SecurityPostureHistory(**data)

    async def get_security_posture_snapshot(
        self, snapshot_id: str
    ) -> SecurityPostureSnapshot:
        """Get a specific posture snapshot by id."""
        data = await self._request("GET", f"/api/security/posture/{snapshot_id}")
        return SecurityPostureSnapshot(**data)

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    async def get_current_user(self) -> User:
        """Get the currently authenticated user."""
        data = await self._request("GET", "/api/auth/me")
        return User(**data.get("user", data))

    async def list_users(self) -> UserList:
        """List all users (admin only)."""
        data = await self._request("GET", "/api/auth/users")
        return UserList(**data)

    async def refresh_auth_token(self, refresh_token: str) -> AuthTokens:
        """Refresh access and refresh tokens."""
        data = await self._request(
            "POST", "/api/auth/refresh", json={"refreshToken": refresh_token}
        )
        return AuthTokens(**data)

    async def get_oidc_config(self) -> OIDCConfig:
        """Get public OIDC SSO configuration."""
        data = await self._request("GET", "/api/auth/oidc/config")
        return OIDCConfig(**data)

    async def exchange_oidc_token(self, id_token: str) -> OIDCAuthResult:
        """Exchange an OIDC id_token for Commander JWT credentials.

        Args:
            id_token: Verified OIDC ID token.

        Returns:
            Commander access token, refresh token, and user.
        """
        data = await self._request(
            "POST", "/api/auth/oidc/exchange", json={"idToken": id_token}
        )
        return OIDCAuthResult(**data)

    async def get_oidc_settings(self) -> OIDCConfig:
        """Get persisted OIDC configuration (admin only)."""
        data = await self._request("GET", "/api/auth/oidc/settings")
        return OIDCConfig(**data)

    async def update_oidc_settings(
        self, settings: OIDCSettingsUpdate
    ) -> OIDCSettingsSaved:
        """Update persisted OIDC configuration (admin only)."""
        data = await self._request(
            "PUT",
            "/api/auth/oidc/settings",
            json=settings.model_dump(by_alias=True, exclude_none=True),
        )
        return OIDCSettingsSaved(**data)

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    async def get_reporting_status(self) -> ReportingStatus:
        """Get builtin-reporting plugin status."""
        data = await self._request("GET", "/api/reporting/status")
        return ReportingStatus(**data)

    async def enable_reporting(self) -> dict[str, Any]:
        """Enable the builtin-reporting plugin."""
        return await self._request("POST", "/api/reporting/enable")

    async def disable_reporting(self) -> dict[str, Any]:
        """Disable the builtin-reporting plugin."""
        return await self._request("POST", "/api/reporting/disable")

    async def render_report(self, report_config: dict[str, Any]) -> str:
        """Render a WarRoom HTML report.

        Args:
            report_config: Report payload including projectName,
                operationCodename, health, metrics, narrative, etc.

        Returns:
            HTML report string.
        """
        response = await self._http.post(
            "/api/reporting/render",
            json=report_config,
            headers={"Accept": "text/html"},
        )
        response.raise_for_status()
        return response.text

    # ------------------------------------------------------------------
    # Security Scanner
    # ------------------------------------------------------------------

    async def get_security_stats(self) -> SecurityStats:
        """Get content scanner service statistics."""
        data = await self._request("GET", "/api/security/stats")
        return SecurityStats(**data)

    async def security_scan(
        self,
        content: str,
        *,
        content_type: str | None = None,
    ) -> SecurityScanResult:
        """Scan content for security threats.

        Args:
            content: Content to scan.
            content_type: Optional content type (html, markdown, text, json).
                When omitted, uses the generic /api/security/scan endpoint.

        Returns:
            Scan result with threats and sanitized content.
        """
        body: dict[str, Any] = {"content": content}
        if content_type is not None:
            body["contentType"] = content_type
        if content_type in ("html", "markdown", "text", "json"):
            data = await self._request(
                "POST", f"/api/security/scan/{content_type}", json=body
            )
        else:
            data = await self._request("POST", "/api/security/scan", json=body)
        return SecurityScanResult(**data)

    # ------------------------------------------------------------------
    # Confidence
    # ------------------------------------------------------------------

    async def get_mission_confidence(
        self, project_id: str, mission_id: str
    ) -> ConfidenceReport:
        """Get confidence report for a mission."""
        data = await self._request(
            "GET", f"/projects/{project_id}/missions/{mission_id}/confidence"
        )
        return ConfidenceReport(**data)

    async def get_agent_confidence(
        self,
        project_id: str,
        agent_id: str,
        *,
        mission_id: str | None = None,
    ) -> ConfidenceReport:
        """Get confidence report for an agent."""
        params: dict[str, Any] = {}
        if mission_id is not None:
            params["missionId"] = mission_id
        data = await self._request(
            "GET",
            f"/projects/{project_id}/agents/{agent_id}/confidence",
            params=params,
        )
        return ConfidenceReport(**data)

    async def get_mission_confidence_alerts(
        self, project_id: str, mission_id: str
    ) -> MissionConfidenceAlerts:
        """Get low-confidence alerts for a mission."""
        data = await self._request(
            "GET", f"/projects/{project_id}/missions/{mission_id}/confidence/alerts"
        )
        return MissionConfidenceAlerts(**data)

    async def get_confidence_thresholds(self) -> ConfidenceThresholdInfo:
        """Get confidence threshold values and descriptions."""
        data = await self._request("GET", "/api/confidence/thresholds")
        return ConfidenceThresholdInfo(**data)

    # ------------------------------------------------------------------
    # Conflict Detection
    # ------------------------------------------------------------------

    async def proactive_conflict_check(
        self,
        project_id: str,
        agent_id: str,
        proposed_action: dict[str, Any],
    ) -> ConflictDetectionResult:
        """Check whether a proposed action would create a conflict.

        Args:
            project_id: Project identifier.
            agent_id: Agent proposing the action.
            proposed_action: Action payload for conflict detection.

        Returns:
            Conflict detection result with reasoning.
        """
        data = await self._request(
            "POST",
            f"/projects/{project_id}/conflict-detection/proactive",
            json={"agentId": agent_id, "proposedAction": proposed_action},
        )
        return ConflictDetectionResult(**data)

    async def reactive_conflict_monitor(
        self,
        project_id: str,
        recent_actions: list[dict[str, Any]],
    ) -> ReactiveConflictResult:
        """Run reactive conflict monitoring over recent actions."""
        data = await self._request(
            "POST",
            f"/projects/{project_id}/conflict-detection/reactive",
            json={"recentActions": recent_actions},
        )
        return ReactiveConflictResult(**data)

    async def get_conflict_summary(self, project_id: str) -> ConflictSummary:
        """Get project-level conflict summary and recommendations."""
        data = await self._request(
            "GET", f"/projects/{project_id}/conflict-detection/summary"
        )
        return ConflictSummary(**data)

    # ------------------------------------------------------------------
    # Team / Work Coordinator
    # ------------------------------------------------------------------

    async def get_team_status(self, run_id: str) -> TeamStatus:
        """Get aggregate team status for a run."""
        data = await self._request("GET", f"/api/teams/{run_id}/status")
        return TeamStatus(**data)

    async def list_team_work(self, run_id: str) -> TeamWorkList:
        """List work items for a team run."""
        data = await self._request("GET", f"/api/teams/{run_id}/work")
        return TeamWorkList(**data)

    async def list_team_agents(self, run_id: str) -> TeamAgentList:
        """List per-agent workload summaries for a team run."""
        data = await self._request("GET", f"/api/teams/{run_id}/agents")
        return TeamAgentList(**data)

    async def reassign_team_work(self, run_id: str, work_id: str) -> TeamReassignResult:
        """Reassign a work item to a different agent."""
        data = await self._request(
            "POST",
            f"/api/teams/{run_id}/reassign",
            json={"workId": work_id},
        )
        return TeamReassignResult(**data)

    # ------------------------------------------------------------------
    # Approval Config
    # ------------------------------------------------------------------

    async def get_approval_config(self) -> UnifiedApprovalConfig:
        """Get unified approval configuration."""
        data = await self._request("GET", "/api/approval/config")
        return UnifiedApprovalConfig(**data)

    async def update_approval_sandbox_mode(
        self, mode: ApprovalMode
    ) -> ApprovalModeUpdated:
        """Update the sandbox approval mode."""
        data = await self._request(
            "PUT", "/api/approval/sandbox-mode", json={"mode": mode}
        )
        return ApprovalModeUpdated(**data)

    async def add_approval_policy(self, policy: ToolPolicy) -> ApprovalPolicyResult:
        """Add or replace a tool approval policy."""
        data = await self._request(
            "POST",
            "/api/approval/policy",
            json=policy.model_dump(by_alias=True, exclude_none=True),
        )
        return ApprovalPolicyResult(**data)

    async def update_approval_policy(
        self, pattern: str, policy: ToolPolicy
    ) -> ApprovalPolicyResult:
        """Update an existing tool approval policy."""
        data = await self._request(
            "PUT",
            f"/api/approval/policy/{pattern}",
            json=policy.model_dump(by_alias=True, exclude_none=True),
        )
        return ApprovalPolicyResult(**data)

    async def delete_approval_policy(self, pattern: str) -> ApprovalPatternRemoved:
        """Remove a custom tool approval policy."""
        data = await self._request("DELETE", f"/api/approval/policy/{pattern}")
        return ApprovalPatternRemoved(**data)

    async def get_approval_audit_log(self, *, limit: int = 50) -> ApprovalAuditLog:
        """Get recent approval decision audit log entries."""
        data = await self._request(
            "GET", "/api/approval/audit-log", params={"limit": limit}
        )
        return ApprovalAuditLog(**data)

    # ------------------------------------------------------------------
    # Outgoing Webhooks
    # ------------------------------------------------------------------

    async def list_outgoing_webhooks(self) -> OutgoingWebhookList:
        """List configured outgoing webhooks."""
        data = await self._request("GET", "/api/outgoing-webhooks")
        return OutgoingWebhookList(**data)

    async def create_outgoing_webhook(
        self, webhook: OutgoingWebhookCreate
    ) -> OutgoingWebhook:
        """Create a new outgoing webhook (admin only)."""
        data = await self._request(
            "POST",
            "/api/outgoing-webhooks",
            json=webhook.model_dump(by_alias=True, exclude_none=True),
        )
        return OutgoingWebhook(**data.get("webhook", data))

    async def get_outgoing_webhook(self, webhook_id: str) -> OutgoingWebhook:
        """Get a single outgoing webhook configuration."""
        data = await self._request("GET", f"/api/outgoing-webhooks/{webhook_id}")
        return OutgoingWebhook(**data.get("webhook", data))

    async def delete_outgoing_webhook(self, webhook_id: str) -> dict[str, Any]:
        """Delete an outgoing webhook (admin only)."""
        return await self._request("DELETE", f"/api/outgoing-webhooks/{webhook_id}")

    async def get_outgoing_webhook_stats(self) -> OutgoingWebhookStats:
        """Get outgoing webhook dispatcher statistics."""
        data = await self._request("GET", "/api/outgoing-webhooks/stats")
        return OutgoingWebhookStats(**data)

    async def get_outgoing_webhook_deliveries(
        self, webhook_id: str, *, limit: int = 50
    ) -> OutgoingWebhookDeliveries:
        """Get delivery log for a specific webhook."""
        data = await self._request(
            "GET",
            f"/api/outgoing-webhooks/{webhook_id}/deliveries",
            params={"limit": limit},
        )
        return OutgoingWebhookDeliveries(**data)

    async def get_recent_webhook_deliveries(
        self, *, limit: int = 50
    ) -> OutgoingWebhookDeliveries:
        """Get recent deliveries across all outgoing webhooks."""
        data = await self._request(
            "GET",
            "/api/outgoing-webhooks/deliveries/recent",
            params={"limit": limit},
        )
        return OutgoingWebhookDeliveries(**data)

    # ------------------------------------------------------------------
    # Observability
    # ------------------------------------------------------------------

    async def get_trace_timeline(self, run_id: str) -> TimelineView:
        """Get the high-level timeline view for a run."""
        data = await self._request(
            "GET", f"/api/v1/observability/runs/{run_id}/timeline"
        )
        return TimelineView(**data)

    async def get_trace_cost_report(self, run_id: str) -> CostReport:
        """Get the cost report for a run."""
        data = await self._request("GET", f"/api/v1/observability/runs/{run_id}/cost")
        return CostReport(**data)

    async def get_trace_span(self, run_id: str, span_id: str) -> TraceTimelineNode:
        """Get a single span from a run trace."""
        data = await self._request(
            "GET", f"/api/v1/observability/runs/{run_id}/spans/{span_id}"
        )
        return TraceTimelineNode(**data)

    async def replay_run(
        self,
        run_id: str,
        *,
        re_execute_llm: bool = False,
        model_override: str | None = None,
        only_span_ids: list[str] | None = None,
    ) -> ReplayResult:
        """Replay a run from observability data.

        Args:
            run_id: Run identifier.
            re_execute_llm: Whether to re-run LLM calls.
            model_override: Optional model override for replay.
            only_span_ids: Optional span ids to restrict replay.

        Returns:
            Replay result with original and replay summaries.
        """
        body: dict[str, Any] = {"reExecuteLlm": re_execute_llm}
        if model_override is not None:
            body["modelOverride"] = model_override
        if only_span_ids is not None:
            body["onlySpanIds"] = only_span_ids
        data = await self._request(
            "POST", f"/api/v1/observability/runs/{run_id}/replay", json=body
        )
        return ReplayResult(**data)

    # ------------------------------------------------------------------
    # Namespaced Memory
    # ------------------------------------------------------------------

    async def write_namespaced_memory(
        self,
        namespace: str,
        key: str,
        value: str,
        *,
        agent_id: str | None = None,
        project_id: str | None = None,
        kind: str | None = None,
        title: str | None = None,
        tags: list[str] | None = None,
    ) -> NamespacedMemoryWriteResult:
        """Write a key/value entry into a namespaced memory store."""
        body: dict[str, Any] = {"key": key, "value": value}
        if agent_id is not None:
            body["agentId"] = agent_id
        if project_id is not None:
            body["projectId"] = project_id
        if kind is not None:
            body["kind"] = kind
        if title is not None:
            body["title"] = title
        if tags is not None:
            body["tags"] = tags
        data = await self._request(
            "POST", f"/api/namespaced-memory/{namespace}/write", json=body
        )
        return NamespacedMemoryWriteResult(**data)

    async def read_namespaced_memory(
        self, namespace: str, entry_id: str
    ) -> NamespacedMemoryItem:
        """Read a single namespaced memory entry by id."""
        data = await self._request(
            "GET", f"/api/namespaced-memory/{namespace}/read/{entry_id}"
        )
        return NamespacedMemoryItem(**data)

    async def search_namespaced_memory(
        self,
        namespace: str,
        *,
        query: str = "",
        agent_id: str | None = None,
        project_id: str | None = None,
    ) -> NamespacedMemorySearch:
        """Search within a namespaced memory store."""
        params: dict[str, Any] = {"q": query}
        if agent_id is not None:
            params["agentId"] = agent_id
        if project_id is not None:
            params["projectId"] = project_id
        data = await self._request(
            "GET", f"/api/namespaced-memory/{namespace}/search", params=params
        )
        return NamespacedMemorySearch(**data)

    async def get_namespaced_memory_stats(self, namespace: str) -> dict[str, Any]:
        """Get statistics for a namespaced memory store."""
        return await self._request("GET", f"/api/namespaced-memory/{namespace}/stats")

    async def get_namespaced_memory_audit(
        self, namespace: str, *, limit: int = 50
    ) -> NamespacedMemoryAudit:
        """Get audit log entries for a namespace."""
        data = await self._request(
            "GET",
            f"/api/namespaced-memory/{namespace}/audit",
            params={"limit": limit},
        )
        return NamespacedMemoryAudit(**data)

    async def get_namespaced_memory_acl(self) -> NamespacedMemoryAcl:
        """Get ACL rules for namespaced memory."""
        data = await self._request("GET", "/api/namespaced-memory/acl")
        return NamespacedMemoryAcl(**data)

    # ------------------------------------------------------------------
    # Memory Index
    # ------------------------------------------------------------------

    async def list_memory_domains(self, project_id: str) -> MemoryDomainList:
        """List memory index domains for a project."""
        data = await self._request(
            "GET", f"/projects/{project_id}/memory-index/domains"
        )
        return MemoryDomainList(domains=data)

    async def create_memory_domain(
        self, project_id: str, domain: str, *, description: str = ""
    ) -> MemoryDomain:
        """Create a memory index domain."""
        data = await self._request(
            "POST",
            f"/projects/{project_id}/memory-index/domains",
            json={"domain": domain, "description": description},
        )
        return MemoryDomain(**data)

    async def get_memory_domain(self, project_id: str, domain: str) -> MemoryDomain:
        """Read a memory index domain."""
        data = await self._request(
            "GET", f"/projects/{project_id}/memory-index/domains/{domain}"
        )
        return MemoryDomain(**data)

    async def add_memory_index_entry(
        self,
        project_id: str,
        domain: str,
        type: str,
        title: str,
        content: str,
        *,
        tags: list[str] | None = None,
    ) -> MemoryIndexEntry:
        """Add an entry to a memory index domain."""
        body: dict[str, Any] = {
            "type": type,
            "title": title,
            "content": content,
        }
        if tags is not None:
            body["tags"] = tags
        data = await self._request(
            "POST",
            f"/projects/{project_id}/memory-index/domains/{domain}/entries",
            json=body,
        )
        return MemoryIndexEntry(**data)

    async def reconcile_memory_index(
        self, project_id: str
    ) -> MemoryIndexReconcileResult:
        """Reconcile the memory index for a project."""
        data = await self._request(
            "POST", f"/projects/{project_id}/memory-index/reconcile"
        )
        return MemoryIndexReconcileResult(**data)

    # ------------------------------------------------------------------
    # Dead Letter Queue
    # ------------------------------------------------------------------

    async def get_dlq_stats(self) -> DlqStats:
        """Get aggregate DLQ statistics."""
        data = await self._request("GET", "/api/dlq/stats")
        return DlqStats(**data)

    async def get_dlq_categories(self) -> list[dict[str, Any]]:
        """Get DLQ categories with entry counts."""
        data = await self._request("GET", "/api/dlq/categories")
        return data if isinstance(data, list) else []

    async def list_dlq_entries(
        self, *, category: str | None = None, limit: int = 50
    ) -> list[DlqEntry]:
        """List unrecovered DLQ entries."""
        params: dict[str, Any] = {"limit": limit}
        if category is not None:
            params["category"] = category
        data = await self._request("GET", "/api/dlq/entries", params=params)
        items = data if isinstance(data, list) else []
        return [DlqEntry(**item) for item in items]

    async def replay_dlq_entry(self, entry_id: str) -> DlqReplayResult:
        """Mark a DLQ entry as recovered (replay)."""
        data = await self._request("POST", f"/api/dlq/replay/{entry_id}")
        return DlqReplayResult(**data)

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    async def get_eval_status(self) -> EvalStatus:
        """Get builtin-eval plugin status and engine stats."""
        data = await self._request("GET", "/api/eval/status")
        return EvalStatus(**data)

    async def enable_eval(self) -> dict[str, Any]:
        """Enable the builtin-eval plugin."""
        return await self._request("POST", "/api/eval/enable")

    async def disable_eval(self) -> dict[str, Any]:
        """Disable the builtin-eval plugin."""
        return await self._request("POST", "/api/eval/disable")

    async def eval_judge(
        self,
        input: str,
        output: str,
        *,
        expected: str | None = None,
        evaluated_model: str | None = None,
    ) -> EvalJudgeResult:
        """Run LLM-as-Judge on a single target."""
        body: dict[str, Any] = {"input": input, "output": output}
        if expected is not None:
            body["expected"] = expected
        if evaluated_model is not None:
            body["evaluatedModel"] = evaluated_model
        data = await self._request("POST", "/api/eval/judge", json=body)
        return EvalJudgeResult(**data)

    async def list_eval_datasets(self) -> EvalDatasetList:
        """List versioned evaluation datasets."""
        data = await self._request("GET", "/api/eval/datasets")
        return EvalDatasetList(**data)

    async def create_eval_dataset(
        self, name: str, cases: list[dict[str, Any]]
    ) -> EvalDataset:
        """Create a new evaluation dataset."""
        data = await self._request(
            "POST", "/api/eval/datasets", json={"name": name, "cases": cases}
        )
        return EvalDataset(**data)

    async def compare_eval_ab(
        self,
        experiment_id: str,
        config: dict[str, Any],
        pairs: list[dict[str, Any]],
    ) -> EvalCompareResult:
        """Run an A/B comparison on paired scores."""
        data = await self._request(
            "POST",
            "/api/eval/compare-ab",
            json={"experimentId": experiment_id, "config": config, "pairs": pairs},
        )
        return EvalCompareResult(**data)

    async def eval_wilcoxon(
        self, deltas: list[float], *, alpha: float = 0.05
    ) -> EvalWilcoxonResult:
        """Run a Wilcoxon signed-rank test on score deltas."""
        data = await self._request(
            "POST", "/api/eval/wilcoxon", json={"deltas": deltas, "alpha": alpha}
        )
        return EvalWilcoxonResult(**data)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _build_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> Any:
        last_exception: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                response = await self._http.request(method, path, **kwargs)
                if response.status_code == 429:
                    retry_after = _parse_retry_after(response)
                    raise RateLimitError(
                        "Rate limited",
                        retry_after=retry_after,
                    )
                response.raise_for_status()
                if response.status_code in (204, 205) or response.content == b"":
                    return {}
                return response.json()
            except httpx.HTTPStatusError as exc:
                body = exc.response.text
                raise map_status_to_error(exc.response.status_code, body) from exc
            except (httpx.ConnectError, httpx.ReadTimeout) as exc:
                last_exception = exc
                # A ConnectError means nothing reached the server, so any method
                # is safe to retry. A ReadTimeout means the server may already
                # have applied the request: retrying a non-idempotent method
                # there can duplicate the side effect (the server mints a new id
                # per POST), so only explicitly idempotent methods are retried.
                retryable = isinstance(exc, httpx.ConnectError) or (
                    method.upper() in _IDEMPOTENT_METHODS
                )
                if retryable and attempt < self._max_retries - 1:
                    # Exponential backoff with full jitter.
                    delay = (2**attempt) * (0.5 + random.random())
                    await asyncio.sleep(delay)
                    continue
                raise ConnectionError(
                    f"Failed after {self._max_retries} retries"
                ) from exc
        # Should not reach here, but satisfy the type checker
        raise CommanderError(
            f"Unexpected error in request retry loop: {last_exception}"
        )


def _parse_retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("Retry-After")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


class _ChatSSEStream:
    """Async generator that yields chat SSE events.

    The chat endpoint emits a simpler event format than the runtime stream::

        event: start
        data: {"agentId":"...","timestamp":"..."}

        event: step
        data: {"type":"thought","content":"..."}

        event: done
        data: {}

        data: [DONE]
    """

    _DONE_MARKER = "[DONE]"

    def __init__(
        self,
        client: httpx.AsyncClient,
        path: str,
        params: dict[str, Any],
        body: dict[str, Any],
    ) -> None:
        self._client = client
        self._path = path
        self._params = params
        self._body = body

    async def __aiter__(self):
        current_event: str | None = None
        async with self._client.stream(
            "POST", self._path, params=self._params, json=self._body
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith((":", "id:")):
                    continue
                if line.startswith("event:"):
                    current_event = line[len("event:") :].strip()
                    continue
                if line.startswith("data:"):
                    raw = line[len("data:") :].strip()
                    if raw == self._DONE_MARKER:
                        return
                    try:
                        payload = {} if raw == "" else json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    yield ChatStreamEvent(
                        event=current_event or payload.get("event", ""),
                        data=payload if isinstance(payload, dict) else {},
                    )
                    continue
                current_event = None


# Canonical PraetorClient alias
PraetorClient = CommanderClient

