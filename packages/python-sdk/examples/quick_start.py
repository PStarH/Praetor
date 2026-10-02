"""Quick start example — run, plan, health check."""

import asyncio
from commander import CommanderClient


async def main():
    async with CommanderClient(
        api_key="cmd-...",
        base_url="http://localhost:4000",
    ) as client:
        # Health check
        health = await client.health()
        print(f"Server: {health.status} (uptime: {health.uptime:.0f}s)")

        # Zero-cost planning
        plan = await client.plan("audit repository for security vulnerabilities")
        print(f"Topology: {plan.topology}")
        print(f"Estimated steps: {plan.estimated_steps}")
        print(f"Cost band: {plan.estimated_cost_band}")
        print(f"Budget: ${plan.estimate.cost_budget_usd:.2f}")

        # Execute
        result = await client.run("list all Python files")
        print(f"Status: {result.status}")
        print(f"Summary: {result.summary}")


asyncio.run(main())
