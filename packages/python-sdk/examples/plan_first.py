"""Plan-then-execute workflow."""

import asyncio
from commander import CommanderClient


async def main():
    async with CommanderClient(
        api_key="cmd-...",
        base_url="http://localhost:4000",
    ) as client:
        task = "refactor auth module to use parameterized queries"

        # Step 1: Plan — zero-cost deliberation
        plan = await client.plan(task)
        print(f"Plan: {plan.topology} | {plan.estimated_steps} steps | "
              f"${plan.estimate.cost_budget_usd:.2f} budget")

        # Step 2: Execute if cheap enough
        if plan.estimate.cost_budget_usd < 1.0:
            print("Budget OK, executing...")
            result = await client.run(task)
            print(f"Status: {result.status}")
            print(f"Tokens: {result.total_token_usage}")
        else:
            print("Over budget, skipping execution")


asyncio.run(main())
