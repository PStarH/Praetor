"""Streaming example — watch agent thoughts in real time."""

import asyncio
from commander import CommanderClient


async def main():
    async with CommanderClient(
        api_key="cmd-...",
        base_url="http://localhost:4000",
    ) as client:
        # Execute first to get a session_id
        result = await client.run("analyze this project")
        session_id = result.session_id
        if not session_id:
            print("No session id returned")
            return

        # Stream events from the session
        print("Streaming events...")
        async for event in client.stream(session_id):
            if event.event == "output.delta":
                print(event.data.get("content", ""), end="", flush=True)
            elif event.event == "agent.status":
                print(f"\n[Agent: {event.data.get('status', '')}]")
            elif event.event == "tool_call.started":
                print(f"\n[Tool: {event.data.get('toolName', '?')}]")
            elif event.event == "error.occurred":
                print(f"\n[Error: {event.data.get('error', '')}]")


asyncio.run(main())
