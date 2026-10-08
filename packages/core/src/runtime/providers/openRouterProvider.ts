import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
import type { LLMRequest } from '../types';

/**
 * OpenRouter Provider — unified gateway to many models via the OpenRouter API
 * (OpenAI-compatible).
 *
 * Endpoint: https://openrouter.ai/api/v1
 * Models: openai/gpt-4o-mini, anthropic/claude-3.5-sonnet,
 *         google/gemini-2.0-flash-exp, deepseek/deepseek-r1,
 *         meta-llama/llama-3.3-70b-instruct, etc.
 *
 * By extending BaseOpenAICompatibleProvider, this provider inherits:
 *  - Streaming SSE parsing (parseOpenAIStream)
 *  - Non-streaming response parsing (parseOpenAIResponse)
 *  - Cache token parsing (prompt_tokens_details.cached_tokens)
 *  - prompt_cache_key propagation (buildOpenAIBody)
 *  - Automatic HTTP retry with exponential backoff for 429/5xx
 *  - Tool adaptation via FormatBridge.adaptToolsForProvider(tools, 'openrouter')
 *    (the provider name is derived from this class's name)
 *
 * OpenRouter-specific behavior handled below:
 *  - Requires `HTTP-Referer` and `X-Title` headers for app attribution/ranking
 *    (injected via getExtraConfig).
 *  - Uses a `reasoning: { enabled, effort, max_tokens }` object instead of the
 *    flat `reasoning_effort` field for reasoning models. getExtraBody emits the
 *    `reasoning` object; buildOpenAIBody detects the `reasoning` key in the
 *    extra body and suppresses `reasoning_effort`/`max_thinking_tokens` so only
 *    the OpenRouter-native directive is sent.
 *  - Returns reasoning content under `message.reasoning` (non-streaming) and
 *    `delta.reasoning` (streaming) instead of `reasoning_content`. The base
 *    parse functions read these as fallbacks (see parseOpenAIResponse /
 *    parseOpenAIStream).
 *
 * Env: OPENROUTER_API_KEY (required)
 *      OPENROUTER_BASE_URL (optional)
 *      OPENROUTER_MODEL (optional)
 */
export class OpenRouterProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'openrouter';

  protected getDefaultBaseUrl(): string {
    return 'https://openrouter.ai/api/v1';
  }

  protected getDefaultModel(): string {
    return 'openai/gpt-4o-mini';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    // OpenRouter requests app attribution headers for ranking and the free
    // tier. These are sent with every request via the base class fetch.
    return {
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/PStarH/Praetor',
        'X-Title': 'Praetor',
      },
    };
  }

  protected getExtraBody(request: LLMRequest): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    const rc = request.reasoningConfig;
    if (rc?.enabled) {
      // OpenRouter expects a `reasoning` object instead of the flat
      // `reasoning_effort` field. The presence of this `reasoning` key in the
      // extra body tells buildOpenAIBody to suppress `reasoning_effort` and
      // `max_thinking_tokens`, so we emit a single, OpenRouter-native
      // reasoning directive here.
      const reasoning: Record<string, unknown> = { enabled: true };
      if (rc.effort) reasoning.effort = rc.effort;
      if (rc.budget && rc.budget > 0) reasoning.max_tokens = rc.budget;
      extra.reasoning = reasoning;
    }
    return extra;
  }
}
