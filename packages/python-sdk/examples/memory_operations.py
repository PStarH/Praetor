"""Memory operations example."""

import asyncio
from commander import CommanderClient


async def main():
    async with CommanderClient(
        api_key="cmd-...",
        base_url="http://localhost:4000",
    ) as client:
        # Write to memory
        result = await client.memory_write(
            content="Always use parameterized queries to prevent SQL injection",
            importance=0.9,
            tags=["security", "sql", "best-practice"],
            layer="longterm",
        )
        if result.rejected:
            print(f"Memory rejected: {result.rejection_reason}")
        else:
            print(f"Stored: {result.id}")

        # Query memory
        results = await client.memory_query(
            keywords=["sql", "security"],
            layer="longterm",
            limit=5,
        )
        print(f"Found {results.total} results:")
        for item in results.items:
            print(f"  [{item.importance:.1f}] {item.content}")

        # Stats
        stats = await client.memory_stats()
        print(f"Total entries: {stats.total_entries}")
        print(f"By layer: {stats.by_layer}")


asyncio.run(main())
