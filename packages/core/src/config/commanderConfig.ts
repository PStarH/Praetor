import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
// Single source of truth for provider metadata + factory. The 6 derived
// Records below (PROVIDER_ORDER / ENV_MAP / DEFAULT_URLS / DEFAULT_MODELS /
// DISPLAY_NAMES / API_TYPE) are all generated from this registry, so adding a
// new provider is a ONE-STEP operation in providerRegistry.ts instead of
// touching 8+ files across 2 packages.
import {
  getProviderOrder,
  getEnvMap,
  getDefaultUrls,
  getDefaultModels,
  getDisplayNames,
  getApiTypes,
} from '../runtime/providers/providerRegistry';

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'mimo'
  | 'deepseek'
  | 'glm'
  | 'xiaomi'
  | 'ollama'
  | 'vllm'
  | 'cohere'
  | 'mistral'
  | 'groq'
  | 'together'
  | 'perplexity'
  | 'fireworks'
  | 'replicate'
  | 'bedrock'
  | 'xai'
  | 'anyscale'
  | 'deepinfra'
  | 'agnes'
  | 'stepfun'
  | 'minimax'
  | 'azure';

// All 6 Records below are DERIVED from the provider registry — see
// runtime/providers/providerRegistry.ts. To add a provider, register it there
// and these Records update automatically. The `as Record<ProviderType, …>`
// casts are safe because the registry registers exactly the ProviderType union.
export const PROVIDER_ORDER: ProviderType[] = getProviderOrder() as ProviderType[];

export const ENV_MAP: Record<ProviderType, { key: string; url: string; model: string }> =
  getEnvMap() as Record<ProviderType, { key: string; url: string; model: string }>;

export const DEFAULT_URLS: Record<ProviderType, string> = getDefaultUrls() as Record<
  ProviderType,
  string
>;

export const DEFAULT_MODELS: Record<ProviderType, string> = getDefaultModels() as Record<
  ProviderType,
  string
>;

const DISPLAY_NAMES: Record<ProviderType, string> = getDisplayNames() as Record<
  ProviderType,
  string
>;

export const API_TYPE: Record<ProviderType, 'openai' | 'anthropic' | 'google'> =
  getApiTypes() as Record<ProviderType, 'openai' | 'anthropic' | 'google'>;

export interface ProviderInfo {
  type: ProviderType;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  apiType: 'openai' | 'anthropic' | 'google';
}

/**
 * Auto-detect which provider is configured based on env vars.
 * Returns the first provider with a matching API key, in priority order.
 */
function checkLocalProvider(
  type: ProviderType,
  keyEnv: string,
  urlEnv: string,
  modelEnv: string,
): ProviderInfo | null {
  const baseUrl = process.env[urlEnv] || DEFAULT_URLS[type];
  const defaultModel = process.env[modelEnv] || DEFAULT_MODELS[type];
  if (!process.env[urlEnv] && !process.env[modelEnv]) return null;
  return {
    type,
    apiKey: process.env[keyEnv] || '',
    baseUrl,
    defaultModel,
    apiType: API_TYPE[type],
  };
}

/**
 * Resolve the API key for a provider, checking fallback env var names.
 */
export function resolveApiKey(type: ProviderType, primaryKey: string): string {
  return (
    process.env[primaryKey] ||
    (type === 'cohere' ? process.env.COHERE_API_KEY || '' : '') ||
    (type === 'replicate' ? process.env.REPLICATE_API_KEY || '' : '') ||
    (type === 'perplexity' ? process.env.PPLX_API_KEY || '' : '') ||
    ''
  );
}

export function detectProvider(preferredType?: ProviderType): ProviderInfo | null {
  const configured =
    preferredType ||
    (process.env.COMMANDER_PROVIDER?.toLowerCase() as ProviderType | undefined) ||
    (getSettings().provider?.toLowerCase() as ProviderType | undefined);

  let candidates: ProviderType[];
  if (preferredType) {
    candidates = [preferredType];
  } else if (configured && (PROVIDER_ORDER as string[]).includes(configured)) {
    candidates = [configured, ...PROVIDER_ORDER.filter((p) => p !== configured)];
  } else {
    candidates = PROVIDER_ORDER;
  }
  for (const type of candidates) {
    const env = ENV_MAP[type];
    const apiKey = resolveApiKey(type, env.key);

    if (!apiKey) {
      // Local providers (Ollama, vLLM) — need env configured, no API key required
      if (type === 'ollama') {
        // Support both OLLAMA_HOST (official: host:port) and OLLAMA_BASE_URL (full URL)
        const host = process.env.OLLAMA_HOST;
        const baseUrl = process.env.OLLAMA_BASE_URL;
        if (!host && !baseUrl && !process.env.OLLAMA_MODEL) continue;
        let resolvedBaseUrl: string;
        if (host) {
          const prefix = host.startsWith('http://') || host.startsWith('https://') ? '' : 'http://';
          resolvedBaseUrl = `${prefix}${host}`.replace(/\/+$/, '') + '/v1';
        } else {
          resolvedBaseUrl = baseUrl || DEFAULT_URLS[type];
        }
        return {
          type,
          apiKey: '',
          baseUrl: resolvedBaseUrl,
          defaultModel: process.env.OLLAMA_MODEL || DEFAULT_MODELS[type],
          apiType: 'openai',
        };
      }
      if (type === 'vllm') {
        const result = checkLocalProvider(type, 'VLLM_API_KEY', 'VLLM_BASE_URL', 'VLLM_MODEL');
        if (result) return result;
        continue;
      }

      // Bedrock uses AWS credentials, not a traditional API key
      if (type === 'bedrock') {
        const hasAwsCreds = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
        if (!hasAwsCreds) continue;
        return {
          type,
          apiKey: '',
          baseUrl: DEFAULT_URLS[type],
          defaultModel: process.env.BEDROCK_MODEL || DEFAULT_MODELS[type],
          apiType: API_TYPE[type],
        };
      }

      // Check if OPENAI_API_KEY + base URL hints match this provider
      if (type !== 'openai' && process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
        const baseUrl = process.env.OPENAI_BASE_URL.toLowerCase();
        const nonOpenai = type as string;
        const match =
          (nonOpenai === 'mimo' && (baseUrl.includes('mimo') || baseUrl.includes('xiaomimi'))) ||
          (nonOpenai === 'deepseek' && baseUrl.includes('deepseek')) ||
          (nonOpenai === 'glm' && (baseUrl.includes('bigmodel') || baseUrl.includes('zhipu'))) ||
          (nonOpenai === 'ollama' && baseUrl.includes('localhost:11434')) ||
          (nonOpenai === 'vllm' && baseUrl.includes('localhost:8000')) ||
          (nonOpenai === 'groq' && baseUrl.includes('groq')) ||
          (nonOpenai === 'mistral' && baseUrl.includes('mistral')) ||
          (nonOpenai === 'together' && baseUrl.includes('together'));
        if (!match) continue;
      } else {
        continue;
      }
    }

    const baseUrl = process.env[env.url] || DEFAULT_URLS[type];
    const defaultModel = process.env[env.model] || DEFAULT_MODELS[type];

    return {
      type,
      apiKey: resolveApiKey(type, env.key) || process.env.OPENAI_API_KEY || '',
      baseUrl,
      defaultModel,
      apiType: API_TYPE[type],
    };
  }
  return null;
}

export interface CommanderSettings {
  model?: string;
  provider?: string;
  enableMetaTools?: boolean;
  toolRetrieval?: boolean;
  entropyGating?: boolean;
  speculativeExecution?: boolean;
}

const CONFIG_PATHS = [
  path.join(process.cwd(), '.commander.json'),
  path.join(process.cwd(), '.commander', 'config.json'),
];

const SETTING_ALIASES: Record<string, keyof CommanderSettings> = {
  model: 'model',
  provider: 'provider',
  'meta-tools': 'enableMetaTools',
  meta_tools: 'enableMetaTools',
  enableMetaTools: 'enableMetaTools',
  toolRetrieval: 'toolRetrieval',
  entropyGating: 'entropyGating',
  speculativeExecution: 'speculativeExecution',
};

/**
 * Read settings from config file.
 */
function loadSettings(): CommanderSettings {
  for (const p of CONFIG_PATHS) {
    try {
      if (fs.existsSync(p)) {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch (err) {
          reportSilentFailure(err, 'commanderConfig:334');
          getGlobalLogger().warn('CommanderConfig', `Failed to parse config file ${p}`);
          return {};
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'commanderConfig:340');
      getGlobalLogger().debug('CommanderConfig', `Skipping config file ${p}`);
    }
  }
  return {};
}

function saveSettings(s: CommanderSettings): void {
  const filePath = CONFIG_PATHS[0];
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(s, null, 2), 'utf-8');
}

let cachedSettings: CommanderSettings | null = null;

function getSettings(): CommanderSettings {
  if (!cachedSettings) cachedSettings = loadSettings();
  return cachedSettings;
}

export function getModelOverride(): string | undefined {
  return getSettings().model;
}

export function getProviderOverride(): string | undefined {
  return process.env.COMMANDER_PROVIDER || getSettings().provider;
}

export function getEffectiveModel(preferredModel?: string, preferredProvider?: ProviderType): string {
  if (preferredModel) return preferredModel;
  const provider = detectProvider(preferredProvider);
  const override = getModelOverride();
  return override || provider?.defaultModel || 'gpt-4o';
}

export function setConfig(key: string, value: string): void {
  const settings = getSettings();
  const normalizedKey = SETTING_ALIASES[key];
  if (!normalizedKey) {
    throw new Error(
      `Unknown setting: ${key}. Try: model, provider, meta-tools, toolRetrieval, entropyGating, speculativeExecution`,
    );
  }
  if (normalizedKey === 'model') {
    settings.model = value;
  } else if (normalizedKey === 'provider') {
    settings.provider = value;
  } else {
    (settings as Record<string, unknown>)[normalizedKey] =
      value === 'true' || value === '1' || value === 'on';
  }
  saveSettings(settings);
  cachedSettings = settings;
}

export function showConfig(): void {
  const provider = detectProvider();
  const settings = getSettings();

  console.log(
    `\n  Provider:  ${provider ? `${DISPLAY_NAMES[provider.type]} (${provider.type})` : 'None'}`,
  );
  console.log(`  Model:     ${settings.model || provider?.defaultModel || 'auto'}`);
  console.log(`  API URL:   ${provider?.baseUrl || '-'}`);
  console.log(`  API type:  ${provider?.apiType || '-'}`);
  console.log(`\n  Features:`);
  console.log(`    meta-tools:         ${settings.enableMetaTools ? 'on' : 'off'}`);
  console.log(`    toolRetrieval:      ${settings.toolRetrieval ? 'on' : 'off'}`);
  console.log(`    entropyGating:      ${settings.entropyGating ? 'on' : 'off'}`);
  console.log(`    speculativeExec:    ${settings.speculativeExecution ? 'on' : 'off'}`);
}

export function listProviders(): void {
  for (const type of PROVIDER_ORDER) {
    const env = ENV_MAP[type];
    const key = process.env[env.key] || '';
    const hasKey = !!key;
    const viaOpenAI =
      !hasKey && type !== 'openai' && process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL;
    const model = process.env[env.model] || DEFAULT_MODELS[type];
    console.log(
      `  ${hasKey ? '✓' : viaOpenAI ? '~' : ' '} ${DISPLAY_NAMES[type].padEnd(20)} ${type.padEnd(12)} ${model}`,
    );
  }
}

export function listModels(): void {
  const all = [
    { provider: 'openai', name: 'gpt-4o, gpt-4o-mini, gpt-4.1, o3-mini, o4-mini' },
    {
      provider: 'anthropic',
      name: 'claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus, claude-4-sonnet',
    },
    { provider: 'google', name: 'gemini-2.0-flash, gemini-2.0-pro, gemini-2.5-pro' },
    {
      provider: 'openrouter',
      name: 'openai/gpt-4o, anthropic/claude-3.5-sonnet, google/gemini-2.0-flash, deepseek/deepseek-chat, meta-llama/llama-3.3-70b, mistral/mistral-large',
    },
    {
      provider: 'deepseek',
      name: 'deepseek-v4-flash, deepseek-v4-pro, deepseek-chat, deepseek-reasoner',
    },
    {
      provider: 'glm',
      name: 'glm-5.1, glm-5, glm-5-turbo, glm-4.7, glm-4.7-flash, glm-4.6, glm-4.5',
    },
    { provider: 'mimo', name: 'mimo-v2.5, mimo-v2.5-pro, mimo-v2-pro, mimo-v2-omni' },
    { provider: 'xiaomi', name: 'mimo-v2-flash, mimo-v2-pro, mimo-v2-omni' },
    {
      provider: 'ollama',
      name: 'llama3.2, llama3.1, llama3, mistral, qwen2.5, codellama, deepseek-coder (local)',
    },
    {
      provider: 'vllm',
      name: 'Llama-3.2, Mistral, Qwen2.5, DeepSeek-Coder, any HF model (self-hosted)',
    },
    {
      provider: 'cohere',
      name: 'command-a-plus-05-2026, command-r-08-2024, command-r-plus-08-2024',
    },
    {
      provider: 'mistral',
      name: 'mistral-large-latest, mistral-small-latest, codestral-latest, open-mistral-nemo',
    },
    {
      provider: 'groq',
      name: 'llama-3.3-70b-versatile, llama3-70b-8192, mixtral-8x7b-32768, gemma2-9b-it',
    },
    {
      provider: 'together',
      name: 'Llama-3.3-70B, DeepSeek-V3, Qwen2.5-72B, Mixtral-8x22B, Gemma-2-27b',
    },
    {
      provider: 'perplexity',
      name: 'sonar-pro, sonar, sonar-reasoning-pro, sonar-reasoning, sonar-deep-research, r1-1776',
    },
    {
      provider: 'fireworks',
      name: 'llama-v3p3-70b, deepseek-v3, qwen2p5-coder-32b, mixtral-8x22b',
    },
    {
      provider: 'replicate',
      name: 'meta-llama-3.3-70b, mistral-7b, gemma-2-27b (open-source via cloud)',
    },
    {
      provider: 'bedrock',
      name: 'Claude 3.5 Sonnet/Haiku/Opus, Llama 3 70B/8B, Mistral Large (AWS)',
    },
    {
      provider: 'azure',
      name: 'gpt-4o, gpt-4o-mini, gpt-4, gpt-35-turbo (Azure OpenAI)',
    },
  ];
  for (const p of all) {
    console.log(`  ${DISPLAY_NAMES[p.provider as ProviderType]} (${p.provider}):`);
    console.log(`    ${p.name}`);
  }
}

export function resetConfig(): void {
  cachedSettings = null;
}
