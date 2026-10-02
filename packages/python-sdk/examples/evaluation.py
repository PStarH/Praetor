"""Evaluation example — LLM-as-Judge, datasets, and A/B comparison."""

import asyncio

from commander import CommanderClient


async def main():
    async with CommanderClient(
        api_key="cmd-...",
        base_url="http://localhost:4000",
    ) as client:
        # Check eval plugin status
        status = await client.get_eval_status()
        print(f"Eval plugin enabled: {status.enabled}")

        if not status.enabled:
            await client.enable_eval()

        # Run a single judge call
        result = await client.eval_judge(
            input="What is 2+2?",
            output="4",
            expected="4",
        )
        print(f"Judge score: {result.score}")
        print(f"Feedback: {result.feedback}")

        # Create a dataset
        dataset = await client.create_eval_dataset(
            name="math-basics",
            cases=[
                {"input": "2+2", "output": "4", "expected": "4"},
                {"input": "3*3", "output": "9", "expected": "9"},
            ],
        )
        print(f"Dataset: {dataset.id} ({len(dataset.cases)} cases)")

        # A/B comparison on paired scores
        comparison = await client.compare_eval_ab(
            experiment_id="math-model-v2",
            config={"metric": "accuracy", "direction": "higher"},
            pairs=[
                {"a": {"score": 0.8}, "b": {"score": 0.9}},
                {"a": {"score": 0.7}, "b": {"score": 0.85}},
            ],
        )
        print(f"A/B result: {comparison.result}")


asyncio.run(main())
