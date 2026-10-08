"""Pydantic models for Commander SDK request/response types."""

from __future__ import annotations

from collections.abc import Iterator
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel as _PydanticBaseModel
from pydantic import ConfigDict, Field


class CommanderModel(_PydanticBaseModel):
    """Base model that ignores unknown fields and accepts aliases."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)


# ============================================================================
# Execution
# ============================================================================

ExecutionStatus = Literal["SUCCESS", "FAILED", "PARTIAL", "CANCELLED", "INTERRUPTED"]


# ============================================================================
# Agent & Task
# ============================================================================


class AgentConfig(CommanderModel):
    """Configuration for creating an Agent."""

    id: str | None = None
    name: str
    role: str
    tools: list[str] | None = None
    topology: Topology = "SINGLE"
    effort: Literal["minimal", "low", "standard", "high", "maximum"] | None = None
    token_budget: int | None = None
    max_steps: int | None = Field(None, alias="maxSteps")


class AgentSnapshot(CommanderModel):
    """Stored agent state (for persistence and recovery)."""

    id: str
    name: str
    role: str
    tools: list[str]
    topology: Topology
    run_count: int = Field(0, alias="runCount")
    total_tokens_used: int = Field(0, alias="totalTokensUsed")
    created_at: str = Field("", alias="createdAt")
    last_run_at: str | None = Field(None, alias="lastRunAt")


class Task(CommanderModel):
    """A task to be executed by one or more agents."""

    goal: str
    output_schema: dict[str, Any] | None = Field(None, alias="outputSchema")
    context: dict[str, Any] | None = None
    priority: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"] | None = None
    deadline_ms: int | None = Field(None, alias="deadlineMs")
    batch_eligible: bool | None = Field(None, alias="batchEligible")


class TaskHandle(CommanderModel):
    """Task with execution metadata (after submission)."""

    id: str
    task: Task
    status: Literal["pending", "running", "completed", "failed", "cancelled"] = (
        "pending"
    )
    agent_id: str = Field("", alias="agentId")
    submitted_at: str = Field("", alias="submittedAt")
    completed_at: str | None = Field(None, alias="completedAt")
    result: ExecutionResult | None = None


# ============================================================================
# Streaming / Events
# ============================================================================

ExecutionEventType = Literal[
    "agent.started",
    "agent.completed",
    "agent.failed",
    "agent.message",
    "agent.interrupted",
    "tool.started",
    "tool.executed",
    "tool.completed",
    "tool.blocked",
    "system.alert",
    "output.delta",
    "output.completed",
    "reasoning.delta",
    "mission.updated",
]


class ExecutionEvent(CommanderModel):
    """Event emitted during streaming execution."""

    type: ExecutionEventType = "agent.message"
    timestamp: str = ""
    data: dict[str, Any] = Field(default_factory=dict)


class StepSummary(CommanderModel):
    """Summary of a single execution step."""

    step_number: int = 0
    action: str = ""
    status: str = ""
    token_usage: int = 0
    duration_ms: int = 0


class ExecutionResult(CommanderModel):
    """Result of a Commander execution."""

    status: ExecutionStatus = "SUCCESS"
    summary: str = ""
    steps: list[StepSummary] = []
    total_token_usage: int = 0
    total_duration_ms: int = 0
    error: str | None = None
    run_id: str | None = None
    session_id: str | None = None


# ============================================================================
# Plan
# ============================================================================

Topology = Literal[
    "SINGLE",
    "SEQUENTIAL",
    "PARALLEL",
    "HIERARCHICAL",
    "HYBRID",
    "DEBATE",
    "ENSEMBLE",
    "EVALUATOR_OPTIMIZER",
]
CostBand = Literal["low", "medium", "high"]


class PlanBudget(CommanderModel):
    """Estimated budget for a plan."""

    time_budget_ms: int = 0
    cost_budget_usd: float = 0.0


class PlanResult(CommanderModel):
    """Result of a zero-cost deliberation (no LLM call)."""

    task: str = ""
    topology: Topology = "SINGLE"
    complexity_score: float = 0.0
    estimated_steps: int = 1
    estimated_cost_band: CostBand = "low"
    estimated_tokens: int = 0
    estimate: PlanBudget = PlanBudget()
    provider: str | None = None
    model: str | None = None
    tenant_id: str | None = None
    plan_only: bool = True
    note: str = ""


# ============================================================================
# Streaming
# ============================================================================


class SSEEvent(CommanderModel):
    """A single SSE event from the Commander stream.

    Wire format::
        id: {seq}
        event: {eventType}
        data: {"event":"{eventType}","data":{...},"timestamp":"ISO","seq":{n}}
    """

    event: str = ""
    data: dict[str, Any] = {}
    timestamp: str = ""
    seq: int = 0


# ============================================================================
# Memory
# ============================================================================


class MemoryWriteResult(CommanderModel):
    """Result of a memory write operation."""

    id: str | None = None
    rejected: bool = False
    rejection_reason: str | None = None


class MemoryEntry(CommanderModel):
    """A single memory entry from a query result."""

    id: str = ""
    content: str = ""
    layer: str = ""
    importance: float = 0.0
    tags: list[str] = []
    context: str | None = None
    metadata: dict[str, Any] = {}
    created_at: str = ""
    last_accessed_at: str = ""
    access_count: int = 0


class MemoryQueryResult(CommanderModel):
    """Result of a memory query."""

    items: list[MemoryEntry] = []
    total: int = 0


class MemoryStats(CommanderModel):
    """Memory statistics."""

    total_entries: int = 0
    by_layer: dict[str, int] = {}
    average_importance: float = 0.0
    average_access_count: float = 0.0
    total_memory_used: int = 0


# ============================================================================
# Monitoring
# ============================================================================


class HealthStatus(CommanderModel):
    """Server health check response."""

    status: str = ""
    uptime: float = 0.0
    active_sessions: int = 0
    bus_topics: int = 0
    timestamp: str = ""


class SystemStatus(CommanderModel):
    """System status snapshot."""

    active_sessions: int = 0
    bus_topics: list[str] = []
    subscriber_counts: dict[str, int] = {}


class SessionSummary(CommanderModel):
    """Summary of an execution session (past or in-progress)."""

    run_id: str = Field("", alias="runId")
    task: str = ""
    status: str = ""
    agent_id: str = Field("", alias="agentId")
    topology: Topology = "SINGLE"
    token_usage: int = Field(0, alias="tokenUsage")
    duration_ms: int = Field(0, alias="durationMs")
    timestamp: str = ""
    error: str | None = None


class SDKReliabilityStats(CommanderModel):
    """Reliability engine statistics surfaced by the SDK."""

    circuit_state: str = Field("CLOSED", alias="circuitState")
    circuit_failures: int = Field(0, alias="circuitFailures")
    dlq_total_entries: int = Field(0, alias="dlqTotalEntries")
    pending_compensations: int = Field(0, alias="pendingCompensations")
    checkpoint_count: int = Field(0, alias="checkpointCount")


# ============================================================================
# Runtime
# ============================================================================


class RuntimeExecuteRequest(CommanderModel):
    """Request body for /api/runtime/execute."""

    agent_id: str
    goal: str
    project_id: str = "default"
    mission_id: str | None = None
    context_data: dict[str, Any] = Field(default_factory=dict)
    available_tools: list[str] = Field(default_factory=list)
    token_budget: int = 8000


class RuntimeRouteRequest(CommanderModel):
    """Request body for /api/runtime/route."""

    goal: str
    token_budget: int = 4000
    available_tools: list[str] = Field(default_factory=list)
    context_data: dict[str, Any] = Field(default_factory=dict)


class TraceRecord(CommanderModel):
    """A single execution trace record."""

    run_id: str = ""
    agent_id: str = ""
    status: str = ""
    start_time: str = ""
    end_time: str | None = None
    steps: list[dict[str, Any]] = Field(default_factory=list)
    total_token_usage: int = 0
    total_duration_ms: int = 0


class TraceList(CommanderModel):
    """List of execution traces."""

    traces: list[TraceRecord] = []
    count: int = 0


class BusTopics(CommanderModel):
    """Active message bus topics and subscriber counts."""

    topics: list[str] = []
    subscriber_counts: dict[str, int] = Field(default_factory=dict)


class ControlResponse(CommanderModel):
    """Response from pause/resume/rollback operations."""

    status: str = ""
    message: str = ""


class ResumeResponse(ControlResponse):
    """Response from runtime resume."""

    from_phase: str | None = None
    step_number: int | None = None
    injected_instructions: bool = False


class RollbackResponse(ControlResponse):
    """Response from runtime rollback."""

    from_step: int | None = None
    to_step: int | None = None
    injected_instructions: bool = False


class ActiveRun(CommanderModel):
    """A single active run entry."""

    run_id: str = ""
    agent_id: str = ""
    status: str = ""
    started_at: str = ""


class ActiveRuns(CommanderModel):
    """List of active runs."""

    runs: list[ActiveRun] = []
    total: int = 0


# ============================================================================
# Chat
# ============================================================================


class ChatMessage(CommanderModel):
    """A single chat message in the conversation history."""

    role: Literal["user", "assistant", "system"] = "user"
    content: str = ""
    timestamp: str = ""
    agent_id: str | None = None
    run_id: str | None = None


class ChatResponse(CommanderModel):
    """Non-streaming chat response."""

    reply: str = ""
    agent_id: str = ""
    run_id: str | None = None
    timestamp: str = ""


class ChatStreamEvent(CommanderModel):
    """A single event from a streaming chat response."""

    event: str = ""
    data: dict[str, Any] = Field(default_factory=dict)


class ChatHistory(CommanderModel):
    """Chat history for a project."""

    project_id: str = ""
    messages: list[ChatMessage] = []


# ============================================================================
# Governance
# ============================================================================

GovernanceMode = Literal["SINGLE", "MULTI", "AUTO"]
RiskLevel = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


class CheckpointStatus(str, Enum):
    """Status of a governance checkpoint."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


class RiskFactor(CommanderModel):
    """A risk factor attached to a checkpoint."""

    category: str = ""
    score: float = 0.0
    description: str = ""


class Checkpoint(CommanderModel):
    """A governance checkpoint."""

    id: str = ""
    mission_id: str = ""
    task_id: str = ""
    agent_id: str = ""
    agent_role: str = ""
    task_description: str = ""
    governance_mode: GovernanceMode = "SINGLE"
    risk_score: float = 0.0
    risk_level: RiskLevel = "LOW"
    risk_factors: list[RiskFactor] = []
    approvers: list[str] = []
    status: CheckpointStatus = CheckpointStatus.PENDING
    created_at: str = ""
    expires_at: str | None = None
    approved_by: list[str] = []
    rejected_by: str | None = None
    rejection_reason: str | None = None


class CheckpointList(CommanderModel):
    """List of governance checkpoints."""

    checkpoints: list[Checkpoint] = []
    count: int = 0


class ApprovalCondition(CommanderModel):
    """Condition attached to a checkpoint approval."""

    type: str = ""
    value: str = ""


# ============================================================================
# Cost
# ============================================================================


class ModelCost(CommanderModel):
    """Cost breakdown for a single model."""

    model: str = ""
    provider: str = ""
    calls: int = 0
    tokens: int = 0
    cost_usd: float = 0.0


class AgentCost(CommanderModel):
    """Cost breakdown for a single agent."""

    agent_id: str = ""
    calls: int = 0
    tokens: int = 0
    cost_usd: float = 0.0


class CostSummary(CommanderModel):
    """Aggregated cost summary."""

    total_calls: int = 0
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    by_model: list[ModelCost] = []
    by_agent: list[AgentCost] = []


class CostRecord(CommanderModel):
    """A single LLM cost record."""

    run_id: str | None = None
    agent_id: str = ""
    model: str = ""
    provider: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    timestamp: str = ""


class CostRecords(CommanderModel):
    """List of cost records."""

    records: list[CostRecord] = []
    total: int = 0


class BudgetAlert(CommanderModel):
    """A budget alert."""

    level: str = ""  # warning, critical
    message: str = ""
    timestamp: str = ""


class CostBudget(CommanderModel):
    """Monthly budget status."""

    monthly_used: float = 0.0
    monthly_limit: float = 0.0
    usage_percent: int = 0
    alert_count: int = 0
    alerts: list[BudgetAlert] = []


# ============================================================================
# Knowledge Base
# ============================================================================


class KnowledgeDocument(CommanderModel):
    """A document in the knowledge base."""

    id: str = ""
    name: str = ""
    type: str = ""
    content: str = ""
    tags: list[str] = []
    status: str = ""
    created_at: str = ""
    chunk_count: int = 0


class DocumentList(CommanderModel):
    """Paginated list of knowledge documents."""

    documents: list[KnowledgeDocument] = []
    total: int = 0
    page: int = 1
    limit: int = 20


class KnowledgeSearchResult(CommanderModel):
    """A single semantic search result."""

    document_id: str = ""
    chunk_id: str = ""
    score: float = 0.0
    content: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class KnowledgeSearchResults(CommanderModel):
    """Semantic search results."""

    results: list[KnowledgeSearchResult] = []
    total: int = 0


class RagQueryResult(CommanderModel):
    """RAG query result with context string."""

    query: str = ""
    context: str = ""
    sources: list[KnowledgeSearchResult] = []


class KnowledgeStats(CommanderModel):
    """Knowledge base aggregate statistics."""

    total_documents: int = 0
    total_chunks: int = 0
    total_size_bytes: int = 0


# ============================================================================
# Projects
# ============================================================================


class AgentState(CommanderModel):
    """Persisted state for an agent within a project."""

    project_id: str = ""
    agent_id: str = ""
    summary: str = ""
    preferences: str = ""
    tags: list[str] = []
    updated_at: str = ""


class Mission(CommanderModel):
    """A mission inside a project."""

    id: str = ""
    project_id: str = ""
    title: str = ""
    objective: str = ""
    assigned_agent_id: str = ""
    priority: str = "MEDIUM"
    risk_level: str = "LOW"
    governance_mode: str = "AUTO"
    status: str = "PLANNED"
    created_at: str = ""
    updated_at: str = ""


class ProjectMemoryItem(CommanderModel):
    """A project-scoped memory item."""

    id: str = ""
    project_id: str = ""
    mission_id: str | None = None
    agent_id: str | None = None
    kind: str = "SUMMARY"
    title: str = ""
    content: str = ""
    tags: list[str] = []
    created_at: str = ""


class ProjectLogEntry(CommanderModel):
    """A log entry attached to a mission."""

    id: str = ""
    mission_id: str = ""
    message: str = ""
    level: str = "INFO"
    created_at: str = ""


# ============================================================================
# Workflows
# ============================================================================


class WorkflowNode(CommanderModel):
    """A node in a workflow graph."""

    id: str = ""
    type: str = ""
    position: dict[str, float] = Field(default_factory=dict)
    data: dict[str, Any] = Field(default_factory=dict)


class WorkflowEdge(CommanderModel):
    """An edge in a workflow graph."""

    id: str = ""
    source: str = ""
    target: str = ""
    label: str | None = None
    condition: str | None = None


class Workflow(CommanderModel):
    """Workflow summary returned by list."""

    id: str = ""
    name: str = ""
    description: str = ""
    created_at: str = ""
    updated_at: str = ""
    node_count: int = 0
    edge_count: int = 0


class WorkflowDefinition(CommanderModel):
    """Full workflow definition."""

    id: str = ""
    name: str = ""
    description: str = ""
    nodes: list[WorkflowNode] = []
    edges: list[WorkflowEdge] = []
    created_at: str = ""
    updated_at: str = ""


class WorkflowExecution(CommanderModel):
    """Result of executing a workflow preview."""

    workflow_id: str = ""
    pipeline: dict[str, Any] = Field(default_factory=dict)


class WorkflowList(CommanderModel):
    """Paginated-like list of workflows."""

    workflows: list[Workflow] = []


# ============================================================================
# Audit Logs
# ============================================================================


class AuditLogEntry(CommanderModel):
    """A unified audit log entry."""

    id: str = ""
    timestamp: str = ""
    source: str = ""
    event_type: str = ""
    severity: str = ""
    user_id: str | None = None
    message: str = ""
    details: dict[str, Any] = Field(default_factory=dict)


class AuditLogs(CommanderModel):
    """Unified audit log query response."""

    logs: list[AuditLogEntry] = []
    total: int = 0
    sources: list[str] = []


class AuditTimeRange(CommanderModel):
    """Time range for audit stats."""

    earliest: str | None = None
    latest: str | None = None


class AuditStats(CommanderModel):
    """Aggregate audit log statistics."""

    total_events: int = 0
    by_source: dict[str, int] = Field(default_factory=dict)
    by_severity: dict[str, int] = Field(default_factory=dict)
    by_event_type: dict[str, int] = Field(default_factory=dict)
    time_range: AuditTimeRange = AuditTimeRange()


class AuditSourceInfo(CommanderModel):
    """Per-source availability and recency."""

    source: str = ""
    description: str = ""
    event_count: int = 0
    last_event: str | None = None


# ============================================================================
# API Keys
# ============================================================================


class ApiKey(CommanderModel):
    """An API key record (without the secret)."""

    id: str = ""
    name: str = ""
    scopes: list[str] = []
    created_at: str = ""
    revoked: bool = False


class ApiKeyList(CommanderModel):
    """List of API key records."""

    keys: list[ApiKey] = []


class ApiKeyCreateResult(CommanderModel):
    """Result of creating an API key, includes the plaintext secret."""

    key: str = ""
    record: ApiKey = ApiKey()


# ============================================================================
# Settings
# ============================================================================


class NotificationSettings(CommanderModel):
    """Notification preferences."""

    email_enabled: bool | None = None
    alerts_enabled: bool | None = None
    email: str | None = None
    webhook_url: str | None = None
    slack_webhook: str | None = None


class AppSettings(CommanderModel):
    """Global application settings."""

    model: str | None = None
    enable_meta_tools: bool | None = None
    tool_retrieval: bool | None = None
    entropy_gating: bool | None = None
    speculative_execution: bool | None = None
    notifications: NotificationSettings | None = None


# ============================================================================
# Security Posture
# ============================================================================


class SecurityPostureSnapshot(CommanderModel):
    """A persisted security posture snapshot."""

    id: str = ""
    timestamp: str = ""
    posture: dict[str, Any] = Field(default_factory=dict)
    trigger: str = ""


class SecurityPostureHistory(CommanderModel):
    """Security posture snapshot history."""

    snapshots: list[SecurityPostureSnapshot] = []
    total: int = 0


class SecurityPostureReport(CommanderModel):
    """Self-assessed control-coverage report from the latest posture snapshot."""

    metadata: dict[str, Any] = Field(default_factory=dict)
    posture: dict[str, Any] = Field(default_factory=dict)
    posture_history: list[SecurityPostureSnapshot] = []
    iso_compliance: dict[str, Any] = Field(default_factory=dict)
    nist_rmf_alignment: dict[str, Any] = Field(default_factory=dict)
    trend_analysis: dict[str, Any] = Field(default_factory=dict)
    audit_checklist: list[dict[str, Any]] = []


# ============================================================================
# Namespaced Memory
# ============================================================================


class NamespacedMemoryWriteResult(CommanderModel):
    """Result of writing a namespaced memory entry."""

    status: str = ""
    namespace: str = ""
    id: str = ""


class NamespacedMemoryItem(CommanderModel):
    """A namespaced memory item."""

    id: str = ""
    namespace: str = ""
    project_id: str = ""
    kind: str = ""
    title: str = ""
    content: str = ""
    tags: list[str] = []
    created_at: str = ""


class NamespacedMemorySearch(CommanderModel):
    """Namespaced memory search response."""

    namespace: str = ""
    query: str = ""
    items: list[NamespacedMemoryItem] = []
    total: int = 0


class NamespacedMemoryAudit(CommanderModel):
    """Namespaced memory audit log response."""

    namespace: str = ""
    entries: list[dict[str, Any]] = []
    count: int = 0


class NamespacedMemoryAcl(CommanderModel):
    """Namespaced memory ACL rules response."""

    rules: list[dict[str, Any]] = []


# ============================================================================
# Memory Index
# ============================================================================


class MemoryDomain(CommanderModel):
    """A memory index domain pointer."""

    domain: str = ""
    description: str = ""
    entries: list[dict[str, Any]] = []


class MemoryIndexEntry(CommanderModel):
    """A memory index entry."""

    id: str = ""
    domain: str = ""
    type: str = ""
    title: str = ""
    content: str = ""
    tags: list[str] = []
    created_at: str = ""


class MemoryIndexReconcileResult(CommanderModel):
    """Result of a memory index reconcile operation."""

    reconciled: bool = False
    removed: int = 0
    merged: int = 0


class MemoryDomainList(CommanderModel):
    """List of memory index domains."""

    domains: list[MemoryDomain] = []


# ============================================================================
# Dead Letter Queue
# ============================================================================


class DlqCategoryStat(CommanderModel):
    """DLQ category count."""

    category: str = ""
    count: int = 0
    unrecovered: int = 0


class DlqStats(CommanderModel):
    """DLQ aggregate statistics."""

    total_entries: int = 0
    total_unrecovered: int = 0
    total_recovered: int = 0
    categories: list[DlqCategoryStat] = []


class DlqTokenUsage(CommanderModel):
    """Token usage embedded in a DLQ entry."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class DlqEntry(CommanderModel):
    """A single DLQ entry."""

    id: str = ""
    category: str = ""
    run_id: str = ""
    agent_id: str = ""
    mission_id: str | None = None
    timestamp: str = ""
    error_class: str = ""
    error_message: str = ""
    retryable: bool = False
    attempt_number: int = 0
    operation_name: str = ""
    input_snapshot: str | None = None
    token_usage: DlqTokenUsage | None = None
    compensated: bool = False
    recovered: bool = False
    tags: list[str] = []
    failure_mode: str | None = None


class DlqReplayResult(CommanderModel):
    """Result of replaying a DLQ entry."""

    status: str = ""
    entry_id: str = ""
    recovered: bool = False


# ============================================================================
# Evaluation
# ============================================================================


class EvalStatus(CommanderModel):
    """Status of the builtin-eval plugin and its engines."""

    plugin: str = ""
    registered: bool = False
    enabled: bool = False
    judge_stats: dict[str, Any] | None = None
    dataset_count: int = 0
    ab_result_count: int = 0


class EvalCase(CommanderModel):
    """A single case inside an evaluation dataset."""

    input: str = ""
    output: str = ""
    expected: str | None = None


class EvalDataset(CommanderModel):
    """A versioned evaluation dataset."""

    id: str = ""
    name: str = ""
    cases: list[EvalCase] = []
    created_at: str = ""
    updated_at: str = ""


class EvalDatasetList(CommanderModel):
    """List of evaluation datasets."""

    datasets: list[EvalDataset] = []


class EvalJudgeResult(CommanderModel):
    """Result of an LLM-as-Judge call."""

    score: float = 0.0
    feedback: str = ""
    criteria: dict[str, Any] = Field(default_factory=dict)


class EvalComparePair(CommanderModel):
    """A paired score for A/B comparison."""

    a: dict[str, Any] = Field(default_factory=dict)
    b: dict[str, Any] = Field(default_factory=dict)


class EvalCompareConfig(CommanderModel):
    """Configuration for an A/B comparison."""

    metric: str = ""
    direction: str = "higher"
    alpha: float = 0.05


class EvalCompareResult(CommanderModel):
    """A/B comparison result."""

    experiment_id: str = ""
    result: dict[str, Any] = Field(default_factory=dict)


class EvalWilcoxonResult(CommanderModel):
    """Wilcoxon signed-rank test result."""

    statistic: float = 0.0
    p_value: float = 0.0
    significant: bool = False


# ============================================================================
# Governed Action Gateway (L4-A)
# ============================================================================

ActionEffect = Literal["allow", "deny", "require_approval"]
GovernedActionState = Literal[
    "PROPOSED",
    "AWAITING_APPROVAL",
    "ADMITTED",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "COMPLETION_UNKNOWN",
    "ESCALATED",
]


class ActionDecision(CommanderModel):
    """Policy decision for a governed action."""

    effect: ActionEffect
    decision_id: str = Field(..., alias="decisionId")
    reason: str
    policy_snapshot_id: str = Field(..., alias="policySnapshotId")


class ActionSimulation(ActionDecision):
    """Simulation result pinned before action submission."""

    simulation_id: str = Field(..., alias="simulationId")
    action_digest: str = Field(..., alias="actionDigest")


class GovernedAction(CommanderModel):
    """Persisted governed action view returned by /v1/actions."""

    run_id: str = Field(..., alias="runId")
    step_id: str = Field(..., alias="stepId")
    effect_id: str = Field(..., alias="effectId")
    state: GovernedActionState
    decision: ActionDecision
    simulation: ActionSimulation
    action_digest: str = Field(..., alias="actionDigest")
    policy_snapshot_id: str = Field(..., alias="policySnapshotId")
    created_at: str = Field(..., alias="createdAt")
    updated_at: str = Field(..., alias="updatedAt")


class ProposeActionInput(CommanderModel):
    """Wire payload for simulate/propose governed actions."""

    source: str
    package: str
    model: str
    tool: str
    destination: str
    effect_type: str = Field(..., alias="effectType")
    args: dict[str, Any]
    idempotency_key: str = Field(..., alias="idempotencyKey")


class ActionApprovalInput(CommanderModel):
    """Approval binding persisted with the simulation."""

    action_digest: str = Field(..., alias="actionDigest")
    simulation_id: str = Field(..., alias="simulationId")
    policy_snapshot_id: str = Field(..., alias="policySnapshotId")


class ActionCompensationInput(CommanderModel):
    """Request a governed compensation for a completed forward effect."""

    original_effect_id: str = Field(..., alias="originalEffectId")
    adapter_version: str = Field(..., alias="adapterVersion")
    compensation_effect_type: str = Field(..., alias="compensationEffectType")
    compensation_patch: dict[str, Any] = Field(alias="compensationPatch")
    forward_receipt_hash: str = Field(..., alias="forwardReceiptHash")


class ActionCompensationApprovalInput(CommanderModel):
    """Approval binding for a governed compensation authorization."""

    action_digest: str = Field(..., alias="actionDigest")
    policy_snapshot_id: str = Field(..., alias="policySnapshotId")


class ActionCompensationAuthorization(CommanderModel):
    """Persisted compensation authorization returned by the gateway."""

    id: str
    tenant_id: str = Field(alias="tenantId")
    original_run_id: str = Field(alias="originalRunId")
    original_effect_id: str = Field(alias="originalEffectId")
    compensation_effect_type: str = Field(alias="compensationEffectType")
    adapter_version: str = Field(alias="adapterVersion")
    compensation_patch: dict[str, Any] = Field(alias="compensationPatch")
    forward_receipt_hash: str = Field(alias="forwardReceiptHash")
    policy_decision_id: str = Field(alias="policyDecisionId")
    policy_snapshot_id: str = Field(alias="policySnapshotId")
    decision: Literal["allow", "require_approval", "deny"]
    action_digest: str = Field(alias="actionDigest")
    expires_at: str = Field(alias="expiresAt")
    approval_interaction_id: str | None = Field(None, alias="approvalInteractionId")


class ActionCompensationResult(CommanderModel):
    """Gateway compensation request result."""

    authorization: ActionCompensationAuthorization | None = None
    replayed: bool = False
    state: Literal["AWAITING_APPROVAL"] | None = None
    accepted: bool | None = None
    request: dict[str, Any] | None = None


class ActionCompensationApprovalResult(CommanderModel):
    """Gateway compensation approval result."""

    interaction: dict[str, Any]
    accepted: bool
    request: dict[str, Any]
    replayed: bool = False


class ActionEvidenceServerVerification(CommanderModel):
    """Integrity verification returned with a persisted evidence receipt."""

    ok: bool
    reason: str | None = None
    broken_at: Literal["effects", "auditEvents", "contentHash", "dlp"] | None = Field(
        None, alias="brokenAt"
    )
    index: int | None = None


class ActionEvidenceBundle(CommanderModel):
    """Evidence bundle and verification result."""

    receipt: dict[str, Any]
    verification: ActionEvidenceServerVerification


class ProposeActionResult(CommanderModel):
    """Typed proposal response with compatibility tuple unpacking."""

    action: GovernedAction
    idempotent_replay: bool = Field(alias="idempotentReplay")
    accepted: bool

    def __iter__(self) -> Iterator[Any]:  # pyright: ignore[reportIncompatibleMethodOverride] - tuple-like unpacking of the model fields
        yield self.action
        yield self.idempotent_replay
        yield self.accepted


class RequestReconcileResult(CommanderModel):
    """Result of requesting immediate reconciliation for an unknown effect."""

    scheduled: Literal[True]
    effect_id: str = Field(alias="effectId")
    state: Literal["COMPLETION_UNKNOWN"]
    reconcile_after: str = Field(alias="reconcileAfter")
    already_scheduled: bool = Field(alias="alreadyScheduled")


class GatewayErrorDetail(CommanderModel):
    """Structured gateway error returned by all action endpoints."""

    code: str
    message: str | None = None
    details: Any | None = None


class GatewayErrorResponse(CommanderModel):
    """Canonical gateway error envelope."""

    error: GatewayErrorDetail


KillSwitchScope = Literal[
    "tenant", "package", "model", "tool", "destination", "effect-type"
]


class KillSwitch(CommanderModel):
    """Tenant-scoped action kill switch."""

    tenant_id: str = Field(alias="tenantId")
    scope: KillSwitchScope
    value: str
    enabled: bool
    reason: str | None = None
    actor: str
    updated_at: str = Field(alias="updatedAt")


class KillSwitchUpdateInput(CommanderModel):
    """Enable or disable a kill switch."""

    enabled: bool
    reason: str | None = None


class ActionEvidenceJwk(CommanderModel):
    """Ed25519 verification key for action evidence receipts."""

    kty: Literal["OKP"]
    crv: Literal["Ed25519"]
    x: str
    kid: str
    alg: Literal["EdDSA"] | None = None
    use: Literal["sig"] | None = None


class ActionEvidenceJwks(CommanderModel):
    """Offline key set for evidence receipt verification."""

    keys: list[ActionEvidenceJwk]


class ActionEvidenceVerification(CommanderModel):
    """Pure evidence receipt verification result."""

    valid: bool
    payload: dict[str, Any] | None = None
    error: GatewayErrorDetail | None = None


# ============================================================================
# Auth
# ============================================================================


class User(CommanderModel):
    """A Commander user (safe public view)."""

    id: str = ""
    username: str = ""
    email: str = ""
    role: str = ""
    created_at: str = ""
    last_login_at: str | None = None


class UserList(CommanderModel):
    """List of users."""

    users: list[User] = []


class AuthTokens(CommanderModel):
    """Access and refresh tokens returned by auth endpoints."""

    token: str = ""
    refresh_token: str = ""
    user: User = User()


# ============================================================================
# Reporting
# ============================================================================


class ReportingStatus(CommanderModel):
    """Status of the builtin-reporting plugin."""

    plugin: str = ""
    registered: bool = False
    enabled: bool = False


# ============================================================================
# Security Scanner
# ============================================================================


class SecurityThreat(CommanderModel):
    """A single security threat found by the content scanner."""

    type: str = ""
    description: str = ""
    severity: str = ""
    position: int | None = None


class SecurityScanResult(CommanderModel):
    """Result of a security content scan."""

    safe: bool = False
    threats: list[SecurityThreat] = []
    sanitized_content: str = ""
    confidence: float = 0.0
    summary: str = ""
    content_type: str | None = Field(default=None, alias="contentType")
    scanned_at: str | None = Field(default=None, alias="scannedAt")


class SecurityStats(CommanderModel):
    """Content scanner service statistics."""

    service: str = ""
    version: str = ""
    threat_types: list[str] = Field(default_factory=list, alias="threatTypes")
    supported_content_types: list[str] = Field(
        default_factory=list, alias="supportedContentTypes"
    )


# ============================================================================
# Cost Dashboard
# ============================================================================

CostTimeRange = Literal["today", "7d", "30d", "all"]


class CostDashboardSummary(CommanderModel):
    """Aggregated cost summary for the analytics dashboard."""

    total_cost_usd: float = Field(0.0, alias="totalCostUsd")
    today_cost_usd: float = Field(0.0, alias="todayCostUsd")
    average_cost_per_task: float = Field(0.0, alias="averageCostPerTask")
    cache_savings_usd: float = Field(0.0, alias="cacheSavingsUsd")
    total_tasks: int = Field(0, alias="totalTasks")
    total_tokens: int = Field(0, alias="totalTokens")
    total_calls: int = Field(0, alias="totalCalls")
    peak_cost_hour: str | None = Field(None, alias="peakCostHour")


class ModelCostEntry(CommanderModel):
    """Cost breakdown for a single model/provider pair."""

    model: str = ""
    provider: str = ""
    calls: int = 0
    input_tokens: int = Field(0, alias="inputTokens")
    output_tokens: int = Field(0, alias="outputTokens")
    cache_tokens: int = Field(0, alias="cacheTokens")
    cost_usd: float = Field(0.0, alias="costUsd")
    percentage: float = 0.0


class ToolCostEntry(CommanderModel):
    """Cost breakdown attributed to a tool."""

    tool: str = ""
    calls: int = 0
    tokens: int = 0
    cost_usd: float = Field(0.0, alias="costUsd")
    percentage: float = 0.0


class UserCostEntry(CommanderModel):
    """Cost breakdown attributed to an agent/user."""

    user_id: str = Field("", alias="userId")
    calls: int = 0
    cost_usd: float = Field(0.0, alias="costUsd")
    percentage: float = 0.0


class TrendPoint(CommanderModel):
    """A single time-series point in the cost trend."""

    timestamp: str = ""
    cost: float = 0.0
    tokens: int = 0


class CostDashboardResponse(CommanderModel):
    """Full response from GET /api/cost/dashboard."""

    time_range: str = Field("7d", alias="timeRange")
    summary: CostDashboardSummary = Field(
        default_factory=lambda: CostDashboardSummary.model_construct()
    )
    by_model: list[ModelCostEntry] = Field(default_factory=list, alias="byModel")
    by_tool: list[ToolCostEntry] = Field(default_factory=list, alias="byTool")
    by_user: list[UserCostEntry] = Field(default_factory=list, alias="byUser")
    trend: list[TrendPoint] = Field(default_factory=list)


# ============================================================================
# OIDC Auth
# ============================================================================


class OIDCConfig(CommanderModel):
    """Public OIDC SSO configuration."""

    enabled: bool = False
    issuer: str | None = None
    client_id: str | None = Field(None, alias="clientId")
    role_claim: str = Field("roles", alias="roleClaim")
    admin_roles: list[str] = Field(
        default_factory=lambda: ["admin"], alias="adminRoles"
    )
    operator_roles: list[str] = Field(
        default_factory=lambda: ["operator", "developer"], alias="operatorRoles"
    )
    redirect_uri: str | None = Field(None, alias="redirectUri")


class OIDCSettingsUpdate(CommanderModel):
    """Payload to update OIDC settings (admin only)."""

    enabled: bool
    issuer: str
    client_id: str = Field(..., alias="clientId")
    role_claim: str = Field("roles", alias="roleClaim")
    admin_roles: list[str] = Field(default_factory=list, alias="adminRoles")
    operator_roles: list[str] = Field(default_factory=list, alias="operatorRoles")
    redirect_uri: str = Field(..., alias="redirectUri")


class OIDCAuthResult(CommanderModel):
    """Result of exchanging an OIDC id_token for Commander credentials."""

    token: str = ""
    refresh_token: str = Field("", alias="refreshToken")
    user: User = Field(default_factory=lambda: User.model_construct())


class OIDCSettingsSaved(CommanderModel):
    """Response from PUT /api/auth/oidc/settings."""

    status: str = ""
    config: OIDCConfig = Field(default_factory=lambda: OIDCConfig.model_construct())


# ============================================================================
# Confidence
# ============================================================================


class ConfidenceThresholds(CommanderModel):
    """Thresholds used by the confidence reporter."""

    low: float = 0.4
    warning: float = 0.6
    target: float = 0.8


class ConfidenceThresholdDescription(CommanderModel):
    """Human-readable description of confidence thresholds."""

    low: str = ""
    warning: str = ""
    target: str = ""


class ConfidenceTrendDataPoint(CommanderModel):
    """A single confidence trend sample."""

    timestamp: str = ""
    avg_confidence: float = Field(0.0, alias="avgConfidence")


class ConfidenceTrend(CommanderModel):
    """Confidence trend direction and samples."""

    direction: str = "insufficient-data"
    change_rate: float | None = Field(None, alias="changeRate")
    data_points: list[ConfidenceTrendDataPoint] = Field(
        default_factory=list, alias="dataPoints"
    )


class LowConfidenceAction(CommanderModel):
    """A single low-confidence action reported for review."""

    action_id: str = Field("", alias="actionId")
    action_type: str = Field("", alias="actionType")
    confidence_score: float = Field(0.0, alias="confidenceScore")
    rationale: str = ""
    timestamp: str = ""
    agent_id: str = Field("", alias="agentId")


class ConfidenceReport(CommanderModel):
    """Confidence distribution and recommendations for a mission/agent."""

    mission_id: str = Field("", alias="missionId")
    agent_id: str | None = Field(None, alias="agentId")
    total_decisions: int = Field(0, alias="totalDecisions")
    average_confidence: float = Field(0.0, alias="averageConfidence")
    distribution: dict[str, int] = Field(default_factory=dict)
    low_confidence_actions: list[LowConfidenceAction] = Field(
        default_factory=list, alias="lowConfidenceActions"
    )
    trend: ConfidenceTrend = Field(
        default_factory=lambda: ConfidenceTrend.model_construct()
    )
    recommendations: list[str] = Field(default_factory=list)


class ConfidenceAlert(CommanderModel):
    """A low-confidence alert for a mission."""

    action_id: str = Field("", alias="actionId")
    mission_id: str = Field("", alias="missionId")
    agent_id: str = Field("", alias="agentId")
    action_type: str = Field("", alias="actionType")
    confidence_score: float = Field(0.0, alias="confidenceScore")
    severity: str = ""
    rationale: str = ""


class MissionConfidenceAlerts(CommanderModel):
    """Response from /projects/:projectId/missions/:missionId/confidence/alerts."""

    mission_id: str = Field("", alias="missionId")
    alert_count: int = Field(0, alias="alertCount")
    thresholds: ConfidenceThresholds = Field(
        default_factory=lambda: ConfidenceThresholds()
    )
    alerts: list[ConfidenceAlert] = Field(default_factory=list)


class ConfidenceThresholdInfo(CommanderModel):
    """Response from /api/confidence/thresholds."""

    thresholds: ConfidenceThresholds = Field(
        default_factory=lambda: ConfidenceThresholds()
    )
    description: ConfidenceThresholdDescription = Field(
        default_factory=ConfidenceThresholdDescription
    )


# ============================================================================
# Conflict Detection
# ============================================================================


class ConflictAgent(CommanderModel):
    """Agent representation used in conflict detection."""

    id: str = ""
    name: str = ""
    role: str | None = None
    specialties: list[str] | None = None
    current_task_id: str | None = Field(None, alias="currentTaskId")
    resource_usage: dict[str, Any] | None = Field(None, alias="resourceUsage")


class ProposedAction(CommanderModel):
    """An action proposed by an agent for conflict checking."""

    agent_id: str = Field("", alias="agentId")
    action_type: str = Field("", alias="actionType")
    target_resource: str | None = Field(None, alias="targetResource")
    estimated_tokens: int | None = Field(None, alias="estimatedTokens")
    estimated_api_calls: int | None = Field(None, alias="estimatedApiCalls")
    priority: str | None = None
    governance_level: str | None = Field(None, alias="governanceLevel")
    metadata: dict[str, Any] | None = None


class Conflict(CommanderModel):
    """A detected conflict between agents."""

    id: str = ""
    type: str = ""
    severity: str = ""
    description: str = ""
    involved_agents: list[str] = Field(default_factory=list, alias="involvedAgents")
    proposed_actions: list[ProposedAction] = Field(
        default_factory=list, alias="proposedActions"
    )
    detected_at: str = Field("", alias="detectedAt")
    detection_mode: str = Field("", alias="detectionMode")
    metadata: dict[str, Any] | None = None


class ConflictDetectionResult(CommanderModel):
    """Result of a proactive conflict check."""

    has_conflict: bool = Field(False, alias="hasConflict")
    conflict: Conflict | None = None
    reasoning: str = ""


class ConflictPotentialConflict(CommanderModel):
    """A potential conflict in the project summary."""

    type: str = ""
    description: str = ""
    severity: str = ""


class ConflictSummary(CommanderModel):
    """Response from /projects/:projectId/conflict-detection/summary."""

    agent_workloads: dict[str, int] = Field(
        default_factory=dict, alias="agentWorkloads"
    )
    potential_conflicts: list[ConflictPotentialConflict] = Field(
        default_factory=list, alias="potentialConflicts"
    )
    recommendations: list[str] = Field(default_factory=list)


class ReactiveConflictResult(CommanderModel):
    """Response from reactive conflict monitoring."""

    conflicts: list[Conflict] = Field(default_factory=list)
    summary: list[str] = Field(default_factory=list)


# ============================================================================
# Team / Work Coordinator
# ============================================================================


class TeamStatus(CommanderModel):
    """Aggregate team status for a run."""

    run_id: str = Field("", alias="runId")
    total: int = 0
    pending: int = 0
    claimed: int = 0
    running: int = 0
    completed: int = 0
    failed: int = 0
    reassigned: int = 0
    by_agent: dict[str, dict[str, int]] = Field(default_factory=dict, alias="byAgent")
    pending_by_agent: dict[str, int] = Field(
        default_factory=dict, alias="pendingByAgent"
    )


class WorkItem(CommanderModel):
    """A single work item managed by the coordinator."""

    id: str = ""
    run_id: str = Field("", alias="runId")
    parent_node_id: str = Field("", alias="parentNodeId")
    goal: str = ""
    tools: list[str] = Field(default_factory=list)
    depends_on: list[str] = Field(default_factory=list, alias="dependsOn")
    status: str = ""
    claimed_by: str | None = Field(None, alias="claimedBy")
    claimed_at: str | None = Field(None, alias="claimedAt")
    completed_at: str | None = Field(None, alias="completedAt")
    result_summary: str | None = Field(None, alias="resultSummary")
    token_budget: int = Field(0, alias="tokenBudget")
    priority: int | None = None


class TeamWorkList(CommanderModel):
    """Response from /api/teams/:runId/work."""

    run_id: str = Field("", alias="runId")
    items: list[WorkItem] = Field(default_factory=list)
    total: int = 0


class AgentWorkload(CommanderModel):
    """Per-agent workload summary in a team run."""

    agent_id: str = Field("", alias="agentId")
    claimed: int = 0
    completed: int = 0
    failed: int = 0
    pending: int = 0
    total_tokens: int = Field(0, alias="totalTokens")
    current_goal: str | None = Field(None, alias="currentGoal")


class TeamAgentList(CommanderModel):
    """Response from /api/teams/:runId/agents."""

    run_id: str = Field("", alias="runId")
    agents: list[AgentWorkload] = Field(default_factory=list)
    total: int = 0


class TeamReassignResult(CommanderModel):
    """Response from /api/teams/:runId/reassign."""

    status: str = ""
    work_id: str = Field("", alias="workId")


# ============================================================================
# Approval Config
# ============================================================================

ApprovalMode = Literal["suggest", "auto-edit", "full-auto", "read-only", "plan"]
ApprovalLevel = Literal["auto", "semi_auto", "manual"]
ApprovalRiskLevel = Literal["low", "medium", "high", "critical"]


class ToolPolicy(CommanderModel):
    """A single tool approval policy."""

    pattern: str = ""
    level: ApprovalLevel = "auto"
    risk_level: ApprovalRiskLevel = Field("low", alias="riskLevel")
    description: str = ""
    auto_approve_if: dict[str, Any] | None = Field(None, alias="autoApproveIf")


class UnifiedApprovalConfig(CommanderModel):
    """Unified approval configuration response."""

    sandbox_mode: ApprovalMode = Field("auto-edit", alias="sandboxMode")
    sandbox_mode_description: str = Field("", alias="sandboxModeDescription")
    tool_policies: list[ToolPolicy] = Field(default_factory=list, alias="toolPolicies")
    fail_closed: bool = Field(True, alias="failClosed")
    last_updated: str = Field("", alias="lastUpdated")


class ApprovalModeUpdate(CommanderModel):
    """Payload to update the sandbox approval mode."""

    mode: ApprovalMode


class ApprovalModeUpdated(CommanderModel):
    """Response from PUT /api/approval/sandbox-mode."""

    status: str = ""
    mode: ApprovalMode = "auto-edit"
    description: str = ""


class ApprovalPolicyResult(CommanderModel):
    """Response from add/update/remove approval policy endpoints."""

    status: str = ""
    policy: ToolPolicy = Field(default_factory=lambda: ToolPolicy.model_construct())


class ApprovalPatternRemoved(CommanderModel):
    """Response from DELETE /api/approval/policy/:pattern."""

    status: str = ""
    pattern: str = ""


class ApprovalAuditEntry(CommanderModel):
    """A single approval decision audit entry."""

    timestamp: str = ""
    event: str = ""
    tool_name: str | None = Field(None, alias="toolName")
    decision: str | None = None
    reason: str | None = None
    risk_level: str | None = Field(None, alias="riskLevel")


class ApprovalAuditLog(CommanderModel):
    """Response from /api/approval/audit-log."""

    entries: list[ApprovalAuditEntry] = Field(default_factory=list)
    total: int = 0


# ============================================================================
# Outgoing Webhooks
# ============================================================================


class OutgoingWebhook(CommanderModel):
    """An outgoing webhook configuration (secret redacted)."""

    id: str = ""
    url: str = ""
    events: list[str] = Field(default_factory=list)
    enabled: bool = True
    name: str | None = None
    description: str | None = None
    retry_max: int | None = Field(None, alias="retryMax")
    headers: dict[str, str] | None = None
    created_at: str | None = Field(None, alias="createdAt")


class OutgoingWebhookList(CommanderModel):
    """List of configured outgoing webhooks."""

    webhooks: list[OutgoingWebhook] = Field(default_factory=list)


class OutgoingWebhookCreate(CommanderModel):
    """Payload to create an outgoing webhook."""

    url: str
    events: list[str]
    enabled: bool = True
    name: str | None = None
    description: str | None = None
    secret: str | None = None
    retry_max: int | None = Field(None, alias="retryMax")
    headers: dict[str, str] | None = None


class OutgoingWebhookDelivery(CommanderModel):
    """A single outgoing webhook delivery log entry."""

    id: str = ""
    webhook_id: str = Field("", alias="webhookId")
    event: str = ""
    payload: dict[str, Any] | None = None
    response_status: int | None = Field(None, alias="responseStatus")
    response_body: str | None = Field(None, alias="responseBody")
    error: str | None = None
    delivered_at: str | None = Field(None, alias="deliveredAt")
    retries: int = 0


class OutgoingWebhookDeliveries(CommanderModel):
    """Delivery log response for a webhook."""

    deliveries: list[OutgoingWebhookDelivery] = Field(default_factory=list)
    total: int = 0


class OutgoingWebhookStats(CommanderModel):
    """Outgoing webhook dispatcher statistics."""

    total_webhooks: int = Field(0, alias="totalWebhooks")
    total_deliveries: int = Field(0, alias="totalDeliveries")
    successful_deliveries: int = Field(0, alias="successfulDeliveries")
    failed_deliveries: int = Field(0, alias="failedDeliveries")
    pending_deliveries: int = Field(0, alias="pendingDeliveries")
    total_retries: int = Field(0, alias="totalRetries")


# ============================================================================
# Observability
# ============================================================================


class TraceTimelineNode(CommanderModel):
    """A node in the trace timeline."""

    span_id: str = Field("", alias="spanId")
    parent_span_id: str | None = Field(None, alias="parentSpanId")
    trace_id: str = Field("", alias="traceId")
    run_id: str = Field("", alias="runId")
    agent_id: str = Field("", alias="agentId")
    type: str = ""
    name: str = ""
    status: str = ""
    started_at: str | None = Field(None, alias="startedAt")
    ended_at: str | None = Field(None, alias="endedAt")
    duration_ms: int = Field(0, alias="durationMs")
    input: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    error: str | None = None
    attributes: dict[str, Any] | None = None
    children: list[Any] = Field(default_factory=list)


class TimelineSummary(CommanderModel):
    """Summary inside a TimelineView."""

    total_spans: int = Field(0, alias="totalSpans")
    total_tokens: int = Field(0, alias="totalTokens")
    total_cost_usd: float = Field(0.0, alias="totalCostUsd")
    duration_ms: int = Field(0, alias="durationMs")
    status: str = ""


class TimelineView(CommanderModel):
    """High-level trace timeline view for a run."""

    run_id: str = Field("", alias="runId")
    trace_id: str = Field("", alias="traceId")
    agent_id: str = Field("", alias="agentId")
    tenant_id: str | None = Field(None, alias="tenantId")
    started_at: str = Field("", alias="startedAt")
    summary: TimelineSummary = Field(
        default_factory=lambda: TimelineSummary.model_construct()
    )
    timeline: list[TraceTimelineNode] = Field(default_factory=list)
    span_tree: dict[str, Any] | None = Field(None, alias="spanTree")


class CostBreakdown(CommanderModel):
    """Cost breakdown inside a CostReport."""

    tokens: int = 0
    cost_usd: float = Field(0.0, alias="costUsd")
    calls: int = 0


class CostReport(CommanderModel):
    """Observability cost report for a run."""

    run_id: str = Field("", alias="runId")
    trace_id: str = Field("", alias="traceId")
    total: CostBreakdown = Field(
        default_factory=lambda: CostBreakdown.model_construct()
    )
    by_model: list[dict[str, Any]] = Field(default_factory=list, alias="byModel")
    by_provider: list[dict[str, Any]] = Field(default_factory=list, alias="byProvider")
    by_agent: list[dict[str, Any]] = Field(default_factory=list, alias="byAgent")
    by_day: list[dict[str, Any]] = Field(default_factory=list, alias="byDay")


class ReplayResult(CommanderModel):
    """Result of replaying a run from observability."""

    run_id: str = Field("", alias="runId")
    trace_id: str = Field("", alias="traceId")
    original_summary: TimelineSummary = Field(
        default_factory=lambda: TimelineSummary.model_construct(),
        alias="originalSummary",
    )
    replay_summary: TimelineSummary = Field(
        default_factory=lambda: TimelineSummary.model_construct(), alias="replaySummary"
    )
    diff: dict[str, Any] | None = None
