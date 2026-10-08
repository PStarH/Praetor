# External Agents SDK + MCP consumer

This package is an independent process boundary for Commander. It imports the
public `@openai/agents` SDK and speaks to the published Commander MCP server
over stdio; it does not import Commander packages or call Commander internals.

The deterministic mode is the CI path and makes no model-network request. The
`live` mode is opt-in, requires an explicit model and provider base URL, and is
for a redacted compatibility smoke only. Provider credentials are read from
the child process environment and are never emitted by the consumer.

Run the boundary checks with:

```bash
pnpm --filter @praetor/openai-agents-mcp typecheck
pnpm --filter @praetor/openai-agents-mcp test
```

The CLI reads one JSON invocation from stdin and writes one sanitized invocation
result to stdout. The MCP command, API key, and tenant id are supplied by the
caller through the input environment map.
