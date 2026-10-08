# Praetor Python SDK

[![PyPI](https://img.shields.io/pypi/v/praetor-ai)](https://pypi.org/project/praetor-ai/)
[![Python](https://img.shields.io/pypi/pyversions/praetor-ai)](https://pypi.org/project/praetor-ai/)
[![License](https://img.shields.io/pypi/l/praetor-ai)](LICENSE)

Python SDK for [Praetor](https://github.com/PStarH/Praetor) - multi-agent orchestration via HTTP.

> **Alpha / non-production-ready:** the SDK and Enterprise Gateway are alpha. Provider calls,
> prompts, responses, traces, and memory may be persisted or sent to the configured provider.
> Review the repository [privacy boundary](../../PRIVACY.md), redact public reports, and do not
> use unattended production workloads without your own validation.

```bash
pip install praetor-ai
```

## Quick Start

```python
import asyncio
from praetor import PraetorClient

async def main():
    async with PraetorClient(
        api_key="praetor-...",
        base_url="http://localhost:4000",
    ) as client:
        # Zero-cost planning
        plan = await client.plan("audit repository for security vulnerabilities")
        print(f"Topology: {plan.topology}")
        print(f"Budget: ${plan.estimate.cost_budget_usd:.2f}")

        # Execute
        result = await client.run("list all Python files")
        print(f"Status: {result.status}")

asyncio.run(main())
```

## API Overview

### Execution & Planning

| Method                              | Description                            |
| ----------------------------------- | -------------------------------------- |
| `client.run(prompt, ...)`           | Execute an agent task                  |
| `client.plan(task, ...)`            | Zero-cost deliberation (no LLM call)   |
| `client.stream(session_id)`         | SSE event stream for a running session |

### Runtime

| Method                                 | Description                            |
| -------------------------------------- | -------------------------------------- |
| `client.runtime_execute(agent_id, goal, ...)` | Execute via the runtime API     |
| `client.runtime_route(goal, ...)`      | Preview routing decision               |
| `client.list_traces(...)`              | List execution traces                  |
| `client.get_trace(run_id)`             | Get a single trace                     |
| `client.trace_summary()`               | Trace summary statistics               |
| `client.bus_topics()`                  | Active message bus topics              |
| `client.learner_stats()`               | Meta-learner statistics                |
| `client.pause_run(run_id)`             | Pause a running execution              |
| `client.resume_run(run_id, ...)`       | Resume a paused execution              |
| `client.rollback_run(run_id, step, ...)` | Rollback to a step                   |
| `client.active_runs()`                 | List active runs                       |

### Chat

| Method                              | Description                            |
| ----------------------------------- | -------------------------------------- |
| `client.chat(message, ...)`         | Send a chat message                    |
| `client.chat_stream(message, ...)`  | Streaming chat response                |
| `client.chat_history(...)`          | Retrieve chat history                  |

### Memory

| Method                              | Description                            |
| ----------------------------------- | -------------------------------------- |
| `client.memory_write(content, ...)` | Write to memory                        |
| `client.memory_query(...)`          | Query memory                           |
| `client.memory_stats()`             | Memory statistics                      |

### Governance

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.create_checkpoint(...)`              | Create a governance checkpoint         |
| `client.get_checkpoint(checkpoint_id)`       | Get a checkpoint                       |
| `client.list_checkpoints(...)`               | List checkpoints                       |
| `client.approve_checkpoint(...)`             | Approve a checkpoint                   |
| `client.reject_checkpoint(...)`              | Reject a checkpoint                    |

### Cost

| Method                              | Description                            |
| ----------------------------------- | -------------------------------------- |
| `client.cost_summary()`             | Aggregated cost summary                |
| `client.cost_records(...)`          | Recent LLM cost records                |
| `client.cost_budget()`              | Monthly budget status                  |

### Knowledge Base

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.upload_document(content, name, type, ...)` | Upload a document                |
| `client.list_documents(...)`                 | List documents                         |
| `client.get_document(document_id)`           | Get a document                         |
| `client.delete_document(document_id)`        | Delete a document                      |
| `client.search_knowledge(query, ...)`        | Semantic search                        |
| `client.rag_query(query, ...)`               | RAG query                              |
| `client.knowledge_stats()`                   | Aggregate statistics                   |

### Projects

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.list_projects()`                     | List all projects                      |
| `client.get_project_war_room(project_id)`    | War-room snapshot                      |
| `client.list_project_agents(project_id)`     | List project agents                    |
| `client.get_agent_state(...)`                | Get agent state                        |
| `client.update_agent_state(...)`             | Update agent state                     |
| `client.get_run_context(...)`                | Build run context                      |
| `client.list_project_memory(...)`            | List project memory                    |
| `client.search_project_memory(...)`          | Search project memory                  |
| `client.create_project_memory(...)`          | Append project memory                  |
| `client.create_mission(...)`                 | Create a mission                       |
| `client.update_mission(...)`                 | Update a mission                       |
| `client.approve_mission(...)`                | Approve a mission                      |
| `client.create_mission_log(...)`             | Create mission log                     |
| `client.get_project_governance_stats(...)`   | Governance statistics                  |
| `client.get_project_governance_alerts(...)`  | Governance alerts                      |
| `client.get_project_governance_weekly_report(...)` | Weekly report (markdown)         |

### Workflows

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.list_workflows()`                    | List workflows                         |
| `client.create_workflow(...)`                | Create workflow definition             |
| `client.get_workflow(workflow_id)`           | Get workflow                           |
| `client.update_workflow(...)`                | Update workflow                        |
| `client.delete_workflow(workflow_id)`        | Delete workflow                        |
| `client.execute_workflow(workflow_id)`       | Preview-execute workflow               |

### Audit Logs

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.list_audit_logs(...)`                | Query audit logs                       |
| `client.get_audit_stats()`                   | Aggregate statistics                   |
| `client.get_audit_sources()`                 | Per-source availability                |
| `client.export_audit_logs(...)`              | Export audit logs                      |

### API Keys (admin)

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.list_api_keys()`                     | List API keys                          |
| `client.create_api_key(name, scopes)`        | Create API key                         |
| `client.revoke_api_key(key_id)`              | Revoke API key                         |

### Settings

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.get_settings()`                      | Read global settings                   |
| `client.update_settings(settings)`           | Update global settings                 |

### Security Posture

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.get_security_posture()`              | Latest self-assessed posture report    |
| `client.get_security_posture_history(...)`   | Snapshot history                       |
| `client.get_security_posture_snapshot(id)`   | Specific snapshot                      |

### Namespaced Memory

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.write_namespaced_memory(...)`        | Write namespaced entry                 |
| `client.read_namespaced_memory(...)`         | Read namespaced entry                  |
| `client.search_namespaced_memory(...)`       | Search namespace                       |
| `client.get_namespaced_memory_stats(...)`    | Namespace statistics                   |
| `client.get_namespaced_memory_audit(...)`    | Namespace audit log                    |
| `client.get_namespaced_memory_acl()`         | ACL rules                              |

### Memory Index

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.list_memory_domains(project_id)`     | List memory domains                    |
| `client.create_memory_domain(...)`           | Create memory domain                   |
| `client.get_memory_domain(...)`              | Read memory domain                     |
| `client.add_memory_index_entry(...)`         | Add index entry                        |
| `client.reconcile_memory_index(project_id)`  | Reconcile index                        |

### Dead Letter Queue

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.get_dlq_stats()`                     | Aggregate DLQ statistics               |
| `client.get_dlq_categories()`                | DLQ categories                         |
| `client.list_dlq_entries(...)`               | List unrecovered entries               |
| `client.replay_dlq_entry(entry_id)`          | Replay entry                           |

### Evaluation

| Method                                       | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `client.get_eval_status()`                   | Eval plugin status                     |
| `client.enable_eval()`                       | Enable eval plugin                     |
| `client.disable_eval()`                      | Disable eval plugin                    |
| `client.eval_judge(...)`                     | LLM-as-Judge                           |
| `client.list_eval_datasets()`                | List datasets                          |
| `client.create_eval_dataset(...)`            | Create dataset                         |
| `client.compare_eval_ab(...)`                | A/B comparison                         |
| `client.eval_wilcoxon(...)`                  | Wilcoxon test                          |

### Monitoring

| Method                              | Description                            |
| ----------------------------------- | -------------------------------------- |
| `client.health()`                   | Liveness probe                         |
| `client.health_detailed()`          | Detailed component health              |
| `client.readiness()`                | Readiness probe                        |
| `client.system_status()`            | System status                          |
| `client.metrics()`                  | OpenMetrics text                       |

## Streaming

```python
async for event in client.stream(session_id):
    if event.event == "output.delta":
        print(event.data["content"], end="", flush=True)
    elif event.event == "agent.status":
        print(f"\n[{event.data['status']}]")
    elif event.event == "tool_call.started":
        print(f"\n[Tool: {event.data['toolName']}]")
```

Event types: `output.delta`, `output.completed`, `agent.status`, `reasoning.delta`, `tool_call.started/completed/delta/timeout/retry/blocked`, `error.occurred`, `state.sync`, `cost.update`, `compensation.update`.

## Sync Wrapper

For scripts and non-async contexts:

```python
from commander import CommanderClientSync

client = CommanderClientSync(api_key="cmd-...", base_url="http://localhost:4000")
result = client.run("analyze this")
client.close()
```

Not for Jupyter/notebooks — use `CommanderClient` with `asyncio` there.

## Configuration

| Env var             | Used by                       | Default                 | Description                        |
| ------------------- | ----------------------------- | ----------------------- | ---------------------------------- |
| `COMMANDER_API_KEY` | both clients                  | —                       | API key sent as `Bearer` auth      |
| `COMMANDER_API_URL` | `CommanderGatewayClient` only | `http://127.0.0.1:4000` | Commander server base URL          |
| —                   | `CommanderClient` (legacy)    | `http://localhost:3001` | Legacy default; see the warning below |

> **Warning — legacy default port.** `CommanderClient` and
> `CommanderClientSync` do **not** read `COMMANDER_API_URL`; they default to port
> `3001`, which is **not** a Commander API port (it belongs to Grafana in the
> observability profile). Always pass an explicit `base_url` when using the
> legacy client, or use `CommanderGatewayClient`, which is the current server
> path and defaults to port `4000`.

## Architecture

```
Python SDK → HTTP → Commander Server → Runtime
```

The SDK is a thin `httpx` client — no Python-side runtime porting.

## Development

```bash
git clone https://github.com/PStarH/Commander.git
cd packages/python-sdk
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m pytest tests/ -v
ruff check src tests
pyright src
```

## License

MIT
