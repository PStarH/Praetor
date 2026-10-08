/** OpenAPI 3.0 specification for Commander HTTP API */

export const openApiSpec: Record<string, unknown> = {
  openapi: '3.0.3',
  info: {
    title: 'Praetor HTTP API',
    version: '0.2.0',
    description:
      'Multi-agent orchestration system — REST API for runtime management, execution, and monitoring.',
    license: { name: 'MIT', url: 'https://github.com/PStarH/Praetor/blob/master/LICENSE' },
    contact: { url: 'https://github.com/PStarH/Praetor' },
  },
  servers: [
    {
      url: `http://localhost:${process.env.COMMANDER_PORT ?? '3001'}`,
      description: 'Default development server',
    },
    { url: `http://localhost:${process.env.PORT ?? '4000'}`, description: 'Production API server' },
  ],
  paths: {
    '/health': {
      get: {
        summary: 'Liveness probe',
        description:
          'Health check endpoint that bypasses authentication and rate limiting. Returns server status and basic metrics.',
        tags: ['Monitoring'],
        responses: {
          '200': {
            description: 'Server is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    uptime: { type: 'number', description: 'Process uptime in seconds' },
                    activeSessions: { type: 'integer' },
                    busTopics: { type: 'integer' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/ready': {
      get: {
        summary: 'Readiness probe',
        description:
          'Readiness endpoint for Kubernetes-style deployment orchestrators. Checks that the server is accepting requests.',
        tags: ['Monitoring'],
        responses: {
          '200': { description: 'Server is ready' },
          '503': { description: 'Server is not ready' },
        },
      },
    },
    '/metrics': {
      get: {
        summary: 'Metrics export',
        description:
          'Exports server metrics in JSON format (default) or OpenMetrics text format (when Accept: text/plain header is set).',
        tags: ['Monitoring'],
        parameters: [
          {
            name: 'Accept',
            in: 'header',
            description:
              'Set to "text/plain" or "application/openmetrics-text" for Prometheus-compatible text format',
            schema: { type: 'string', default: 'application/json' },
          },
        ],
        responses: {
          '200': { description: 'Metrics data' },
        },
      },
    },
    '/api/v1/runtime': {
      post: {
        summary: 'Create runtime session',
        description: 'Creates a new AgentRuntime session with an optional provider and model.',
        tags: ['Runtime'],
        security: [{ BearerAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string', description: 'Optional custom session ID' },
                  provider: { type: 'string', enum: ['openai', 'anthropic'], default: 'openai' },
                  model: { type: 'string', description: 'Optional model override' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Session created' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/api/v1/runtime/{id}': {
      get: {
        summary: 'Get runtime session',
        tags: ['Runtime'],
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Session details' },
          '404': { description: 'Session not found' },
        },
      },
      delete: {
        summary: 'Delete runtime session',
        tags: ['Runtime'],
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Session deleted' },
          '404': { description: 'Session not found' },
        },
      },
    },
    '/api/v1/execute': {
      post: {
        summary: 'Execute agent task',
        description:
          'Executes an agent task with the given prompt. Creates a runtime session if one does not exist.',
        tags: ['Execution'],
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['prompt'],
                properties: {
                  prompt: { type: 'string', description: 'Task description for the agent' },
                  sessionId: { type: 'string' },
                  provider: { type: 'string', enum: ['openai', 'anthropic'] },
                  model: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Execution result' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/api/v1/bus': {
      get: {
        summary: 'Message bus status',
        description:
          'Returns active topics and recent message history from the internal message bus.',
        tags: ['Monitoring'],
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'topic',
            in: 'query',
            schema: { type: 'string' },
            description: 'Filter by topic name',
          },
        ],
        responses: {
          '200': { description: 'Bus state' },
        },
      },
    },
    '/api/v1/status': {
      get: {
        summary: 'System status',
        description:
          'Returns system-wide status including active sessions, bus topics, and subscriber counts.',
        tags: ['Monitoring'],
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'System status' },
        },
      },
    },
    '/stream': {
      get: {
        summary: 'SSE event stream',
        description: 'Streams real-time agent execution events via Server-Sent Events.',
        tags: ['Streaming'],
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Runtime session ID',
          },
        ],
        responses: {
          '200': {
            description: 'SSE event stream',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API key',
        description:
          'API key authentication. Provide the API key in the Authorization header as "Bearer <api-key>".',
      },
    },
  },
  tags: [
    { name: 'Monitoring', description: 'Health, readiness, and metrics endpoints' },
    { name: 'Runtime', description: 'Runtime session management' },
    { name: 'Execution', description: 'Agent task execution' },
    { name: 'Streaming', description: 'Real-time event streaming' },
  ],
};
