"""Project, workflow, audit log, and DLQ example."""

import asyncio

from commander import CommanderClient


async def main():
    async with CommanderClient(
        api_key="cmd-...",
        base_url="http://localhost:4000",
    ) as client:
        # List projects
        projects = await client.list_projects()
        print(f"Projects: {len(projects)}")

        # Create a workflow
        workflow = await client.create_workflow(
            name="security-audit",
            description="Run a lightweight security audit",
            nodes=[
                {
                    "id": "scan",
                    "type": "agent",
                    "data": {"agentId": "security-scanner"},
                },
                {
                    "id": "report",
                    "type": "agent",
                    "data": {"agentId": "report-writer"},
                },
            ],
            edges=[
                {"id": "e1", "source": "scan", "target": "report"},
            ],
        )
        print(f"Created workflow: {workflow.id}")

        # Execute workflow preview
        preview = await client.execute_workflow(workflow.id)
        print(f"Pipeline nodes: {list(preview.pipeline.keys())}")

        # Query audit logs
        logs = await client.list_audit_logs(
            source="runtime",
            severity="info",
            limit=10,
        )
        print(f"Audit logs: {logs.total}")

        # Check DLQ health
        stats = await client.get_dlq_stats()
        print(f"DLQ unrecovered: {stats.total_unrecovered}")


asyncio.run(main())
