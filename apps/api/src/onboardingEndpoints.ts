/**
 * onboardingEndpoints — Web 端上手引导向导 API。
 *
 * 调研发现 93% 企业 Agent 项目卡在 POC→生产，上手体验是关键。CLI 端已有
 * 完善的 quickstart（packages/core/src/cli/commands/quickstart.ts），但 Web
 * 端此前完全缺失引导。本路由为新用户首次登录后的多步骤向导提供后端能力。
 *
 * 端点：
 *   GET  /api/onboarding/status        — 当前配置状态（provider/任务/知识库）
 *   GET  /api/onboarding/sample-tasks  — 返回示例任务列表（供向导展示）
 *   POST /api/onboarding/test-provider — 测试 LLM provider 连通性（10s 超时）
 *   POST /api/onboarding/save-config   — 保存 provider/model 到 .commander.json
 *   POST /api/onboarding/run-first-task — 运行首个测试任务
 *   POST /api/onboarding/complete      — 标记 onboarding 完成
 *
 * 设计约束：
 *   - 使用 Express Router 工厂函数模式（与 costDashboardEndpoints 等保持一致）
 *   - 使用 zod 做请求体验证（复用 validationMiddleware.validateBody）
 *   - 不安装新的 npm 依赖
 *   - provider 连通性测试设置 10s 超时（AbortController）
 *   - .commander.json 读写均处理文件不存在的情况
 *   - API key 仅从环境变量或部署平台的密钥管理器读取
 */
import { reportSilentFailure } from '@praetor/core';
import { Router, type NextFunction, type Request, type Response } from 'express';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { toErrorMessage } from './routeHelpers';
import { validateBody } from './validationMiddleware';
import { atomicWriteFileSync, readJsonFileSafe, isPlainObjectJson } from './atomicWrite';

// ── 常量 ───────────────────────────────────────────────────────────────────

const COMMANDER_CONFIG_FILE = path.join(process.cwd(), '.commander.json');
const COMMANDER_DIR = path.join(process.cwd(), '.commander');
const TRACES_DIR = path.join(process.cwd(), '.commander_traces');
const KNOWLEDGE_BASE_DIR = path.join(COMMANDER_DIR, 'knowledge-base');
const ONBOARDING_COMPLETE_FILE = path.join(COMMANDER_DIR, 'onboarding-complete.json');
const ONBOARDING_FIRST_TASK_FILE = path.join(COMMANDER_DIR, 'onboarding-first-task.json');

/** provider 连通性测试的硬超时（ms）。 */
const PROVIDER_TEST_TIMEOUT_MS = 10_000;

// ── Provider 检测 ──────────────────────────────────────────────────────────
//
// 此处复刻 packages/core/src/config/commanderConfig.ts 中的关键逻辑，但保持
// 自包含——因为 detectProvider 未从 @praetor/core 顶层导出，且本路由需要
// 额外的灵活性（例如使用 Web 端保存的 provider / model 偏好）。

type ProviderId = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'ollama' | 'openrouter';

interface ProviderDescriptor {
  id: ProviderId;
  /** 用于显示的人类可读名称。 */
  label: string;
  /** 检测用的环境变量名（API key）。 */
  keyEnv: string;
  /** base URL 环境变量名（可选覆盖）。 */
  baseUrlEnv: string;
  /** model 环境变量名（可选覆盖）。 */
  modelEnv: string;
  /** 默认 base URL。 */
  defaultBaseUrl: string;
  /** 默认 model。 */
  defaultModel: string;
  /** 该 provider 的 API 协议族。 */
  apiType: 'openai' | 'anthropic' | 'google';
}

const PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    modelEnv: 'OPENAI_MODEL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    apiType: 'openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-20241022',
    apiType: 'anthropic',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    keyEnv: 'GOOGLE_API_KEY',
    baseUrlEnv: 'GOOGLE_BASE_URL',
    modelEnv: 'GOOGLE_MODEL',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    apiType: 'google',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    apiType: 'openai',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    modelEnv: 'OPENROUTER_MODEL',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    apiType: 'openai',
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    keyEnv: 'OLLAMA_API_KEY',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    modelEnv: 'OLLAMA_MODEL',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    apiType: 'openai',
  },
];

interface ResolvedProvider {
  id: ProviderId;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  apiType: 'openai' | 'anthropic' | 'google';
  /** key 来自环境变量还是 .commander.json。 */
  fromEnv: boolean;
}

/** 读取 .commander.json，文件不存在时返回空对象。 */
async function readCommanderConfig(): Promise<Record<string, unknown>> {
  // REL-4: 损坏或错形隔离，禁止 silent {} → writeCommanderConfig 合并写入抹掉配置。
  const parsed = readJsonFileSafe<Record<string, unknown> | null>(
    COMMANDER_CONFIG_FILE,
    null,
    isPlainObjectJson,
  );
  return parsed ?? {};
}

/** 合并写入 .commander.json（保留既有非密钥字段）。 */
async function writeCommanderConfig(updates: Record<string, unknown>): Promise<void> {
  const existing = await readCommanderConfig();
  const { apiKey: _legacyApiKey, ...nonSecretExisting } = existing;
  const merged: Record<string, unknown> = { ...nonSecretExisting, ...updates };
  // 确保父目录存在（process.cwd() 一定存在，但保持防御性）。
  const dir = path.dirname(COMMANDER_CONFIG_FILE);
  if (!fsSync.existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true });
  }
  atomicWriteFileSync(COMMANDER_CONFIG_FILE, JSON.stringify(merged, null, 2), 0o600);
}

/**
 * 解析当前生效的 provider。优先级：
 *   1. 环境变量中配置了 key 的 provider（按 PROVIDERS 顺序）
 *   2. .commander.json 中保存的 provider / model 偏好与环境变量中的 key
 *   3. Ollama 等本地 provider（无需 key，仅需 base URL / model 环境变量）
 */
async function resolveProvider(): Promise<ResolvedProvider | null> {
  // 1) 环境变量
  for (const p of PROVIDERS) {
    const envKey = process.env[p.keyEnv];
    if (envKey && envKey.trim() !== '') {
      return {
        id: p.id,
        label: p.label,
        apiKey: envKey,
        baseUrl: process.env[p.baseUrlEnv] || p.defaultBaseUrl,
        model: process.env[p.modelEnv] || p.defaultModel,
        apiType: p.apiType,
        fromEnv: true,
      };
    }
  }

  // 2) .commander.json
  const cfg = await readCommanderConfig();
  const cfgProvider = typeof cfg.provider === 'string' ? cfg.provider : null;
  const cfgModel = typeof cfg.model === 'string' ? cfg.model : null;
  if (cfgProvider) {
    const desc = PROVIDERS.find((p) => p.id === cfgProvider);
    if (desc) {
      // 非本地 provider 必须由环境变量提供 key。
      const envKey = process.env[desc.keyEnv] || '';
      if (envKey || desc.id === 'ollama') {
        return {
          id: desc.id,
          label: desc.label,
          apiKey: envKey,
          baseUrl:
            (typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined) || desc.defaultBaseUrl,
          model: cfgModel || desc.defaultModel,
          apiType: desc.apiType,
          fromEnv: false,
        };
      }
    }
  }

  // 3) Ollama 本地（无需 key）
  const ollama = PROVIDERS.find((p) => p.id === 'ollama')!;
  const ollamaHost = process.env.OLLAMA_HOST;
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const ollamaModel = process.env.OLLAMA_MODEL;
  if (ollamaHost || ollamaBaseUrl || ollamaModel) {
    let resolvedBaseUrl: string;
    if (ollamaHost) {
      const prefix =
        ollamaHost.startsWith('http://') || ollamaHost.startsWith('https://') ? '' : 'http://';
      resolvedBaseUrl = `${prefix}${ollamaHost}`.replace(/\/+$/, '') + '/v1';
    } else {
      resolvedBaseUrl = ollamaBaseUrl || ollama.defaultBaseUrl;
    }
    return {
      id: 'ollama',
      label: ollama.label,
      apiKey: '',
      baseUrl: resolvedBaseUrl,
      model: ollamaModel || ollama.defaultModel,
      apiType: 'openai',
      fromEnv: true,
    };
  }

  return null;
}

// ── 文件系统检查 ───────────────────────────────────────────────────────────

/** 目录是否存在且至少包含一个非空文件。 */
async function dirHasContent(dir: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length > 0;
  } catch (err) {
    reportSilentFailure(err, `onboardingEndpoints:dirHasContent:${dir}`);
    return false;
  }
}

/** 读取 onboarding-complete.json，返回已完成的步骤列表。 */
async function readCompletedSteps(): Promise<{ steps: string[]; isComplete: boolean }> {
  // REL-4: 损坏或错形隔离，禁止 silent empty → 下次写入抹掉 onboarding 状态。
  const data = readJsonFileSafe<{ completedAt?: string; userId?: string; steps?: string[] } | null>(
    ONBOARDING_COMPLETE_FILE,
    null,
    isPlainObjectJson,
  );
  if (data === null) {
    return { steps: [], isComplete: false };
  }
  return {
    steps: Array.isArray(data.steps) ? data.steps.map(String) : [],
    isComplete: Boolean(data.completedAt),
  };
}

// ── Provider 连通性测试 ────────────────────────────────────────────────────

interface ProviderTestResult {
  success: boolean;
  latency: number;
  provider: string;
  model: string;
  error?: string;
}

/**
 * 向 provider 发送一个极简的 "Hello" 请求，验证连通性与凭证有效性。
 * 各协议族使用对应的请求格式：
 *   - openai 兼容:  POST {baseUrl}/chat/completions
 *   - anthropic:    POST {baseUrl}/messages
 *   - google:       POST {baseUrl}/models/{model}:generateContent
 */
async function probeProvider(resolved: ResolvedProvider): Promise<ProviderTestResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);

  try {
    let url: string;
    let init: RequestInit;

    if (resolved.apiType === 'anthropic') {
      url = `${resolved.baseUrl.replace(/\/+$/, '')}/messages`;
      init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': resolved.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: resolved.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        signal: controller.signal,
      };
    } else if (resolved.apiType === 'google') {
      url = `${resolved.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(
        resolved.model,
      )}:generateContent`;
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': resolved.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Hello' }] }],
          generationConfig: { maxOutputTokens: 8 },
        }),
        signal: controller.signal,
      };
    } else {
      // openai 兼容
      url = `${resolved.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (resolved.apiKey) {
        headers['Authorization'] = `Bearer ${resolved.apiKey}`;
      }
      init = {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolved.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        signal: controller.signal,
      };
    }

    const response = await fetch(url, init);
    const latency = Date.now() - start;

    if (response.ok) {
      return { success: true, latency, provider: resolved.id, model: resolved.model };
    }

    return {
      success: false,
      latency,
      provider: resolved.id,
      model: resolved.model,
      error: `Provider request failed (HTTP ${response.status})`,
    };
  } catch (err) {
    const latency = Date.now() - start;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      success: false,
      latency,
      provider: resolved.id,
      model: resolved.model,
      error: isAbort
        ? `Request timed out after ${PROVIDER_TEST_TIMEOUT_MS / 1000}s`
        : 'Unable to reach provider',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── 示例任务 ──────────────────────────────────────────────────────────────────
//
// 供 GET /api/onboarding/sample-tasks 端点返回，帮助新用户快速了解 Commander
// 的能力范围。任务设计覆盖常见的多 Agent 场景。

interface SampleTask {
  id: string;
  title: string;
  description: string;
  prompt: string;
}

const SAMPLE_TASKS: SampleTask[] = [
  {
    id: 'research-and-summarize',
    title: '研究并总结',
    description: '让 Agent 研究一个特定主题并生成一份简短的总结报告。',
    prompt: '研究 "AI Agent 在企业中的应用现状"，并生成一份 300 字左右的总结报告。',
  },
  {
    id: 'code-review',
    title: '代码审查',
    description: '对给定的代码片段进行审查，指出潜在问题和改进建议。',
    prompt: '请审查以下代码片段并提供改进建议：\n\nfunction add(a, b) { return a + b }',
  },
  {
    id: 'content-generation',
    title: '内容生成',
    description: '根据关键词生成一篇博客文章的大纲。',
    prompt: '为 "2024 年 AI 趋势" 生成一篇博客文章的大纲，包含至少 5 个章节。',
  },
];

// ── Schemas (zod) ──────────────────────────────────────────────────────────────────

const testProviderBody = z.object({
  provider: z
    .enum(['openai', 'anthropic', 'google', 'deepseek', 'ollama', 'openrouter'])
    .optional(),
  model: z.string().max(128).optional(),
});

const saveConfigBody = z.object({
  provider: z.enum(['openai', 'anthropic', 'google', 'deepseek', 'ollama', 'openrouter']),
  model: z.string().min(1).max(128),
});

const runFirstTaskBody = z.object({
  task: z.string().min(1).max(2000),
});

const completeBody = z.object({
  userId: z.string().max(128).optional(),
  steps: z.array(z.string().max(64)).max(16).optional(),
});

function requireOnboardingConfigAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const role = req.user?.role;
  const scopes = req.apiScopes ?? [];
  const authorized =
    role === 'admin' || role === 'super_admin' || scopes.includes('admin') || scopes.includes('*');
  if (!authorized) {
    res.status(403).json({
      error: 'Administrator privileges are required to change provider configuration.',
    });
    return;
  }
  next();
}

// ── Router ─────────────────────────────────────────────────────────────────

export interface OnboardingRouterDeps {
  writeConfig?: (updates: Record<string, unknown>) => Promise<void>;
}

export function createOnboardingRouter(deps: OnboardingRouterDeps = {}): Router {
  const router = Router();
  const persistConfig = deps.writeConfig ?? writeCommanderConfig;

  // ── GET /api/onboarding/status ──────────────────────────────────────────
  // AUDIT-API15: status discloses provider configuration and directory
  // contents — operator-scoped information.
  router.get(
    '/api/onboarding/status',
    requireOnboardingConfigAdmin,
    async (_req: Request, res: Response) => {
      try {
        const resolved = await resolveProvider();
        const hasRunTask =
          (await dirHasContent(TRACES_DIR)) || fsSync.existsSync(ONBOARDING_FIRST_TASK_FILE);
        const hasKnowledge = await dirHasContent(KNOWLEDGE_BASE_DIR);
        const completion = await readCompletedSteps();

        const hasProvider = resolved !== null;
        const hasApiKey =
          (resolved !== null && resolved.apiKey !== '') ||
          (resolved?.id === 'ollama' && resolved.baseUrl !== '');

        const completedSteps = completion.steps.slice();
        // 根据 detected 状态自动推断已完成的步骤（即使未显式标记 complete）
        if (hasProvider && !completedSteps.includes('provider')) completedSteps.push('provider');
        if (hasRunTask && !completedSteps.includes('first-task')) completedSteps.push('first-task');

        const isComplete = completion.isComplete;

        res.json({
          hasProvider,
          hasApiKey,
          provider: resolved?.id ?? null,
          providerLabel: resolved?.label ?? null,
          model: resolved?.model ?? null,
          hasRunTask,
          hasKnowledge,
          completedSteps,
          isComplete,
        });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── GET /api/onboarding/sample-tasks ───────────────────────────────────
  // 返回示例任务列表，供前端向导展示给新用户选择。
  router.get('/api/onboarding/sample-tasks', (_req: Request, res: Response) => {
    res.json({ tasks: SAMPLE_TASKS });
  });

  // ── POST /api/onboarding/test-provider ──────────────────────────────────
  router.post(
    '/api/onboarding/test-provider',
    requireOnboardingConfigAdmin,
    validateBody(testProviderBody),
    async (req: Request, res: Response) => {
      try {
        const body = req.body as z.infer<typeof testProviderBody>;

        // 解析要测试的 provider：优先 body，否则回退到环境/配置检测
        let resolved: ResolvedProvider | null = null;

        if (body.provider) {
          const desc = PROVIDERS.find((p) => p.id === body.provider);
          if (!desc) {
            return res
              .status(400)
              .json({ success: false, error: `Unknown provider: ${body.provider}` });
          }
          const envKey = process.env[desc.keyEnv] || '';
          const apiKey = envKey;
          // ollama 不强制要求 apiKey
          if (!apiKey && desc.id !== 'ollama') {
            return res.json({
              success: false,
              latency: 0,
              provider: desc.id,
              model: body.model || desc.defaultModel,
              error: 'No provider API key configured',
            });
          }
          resolved = {
            id: desc.id,
            label: desc.label,
            apiKey,
            baseUrl: process.env[desc.baseUrlEnv] || desc.defaultBaseUrl,
            model: body.model || process.env[desc.modelEnv] || desc.defaultModel,
            apiType: desc.apiType,
            fromEnv: Boolean(envKey),
          };
        } else {
          resolved = await resolveProvider();
          if (resolved && body.model) {
            resolved = { ...resolved, model: body.model };
          }
        }

        if (!resolved) {
          return res.json({
            success: false,
            latency: 0,
            provider: body.provider ?? null,
            model: body.model ?? null,
            error: 'No provider API key configured',
          });
        }

        const result = await probeProvider(resolved);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── POST /api/onboarding/save-config ────────────────────────────────────
  router.post(
    '/api/onboarding/save-config',
    requireOnboardingConfigAdmin,
    validateBody(saveConfigBody),
    async (req: Request, res: Response) => {
      try {
        const body = req.body as z.infer<typeof saveConfigBody>;
        const updates: Record<string, unknown> = {
          provider: body.provider,
          model: body.model,
        };
        await persistConfig(updates);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── POST /api/onboarding/run-first-task ─────────────────────────────────
  router.post(
    '/api/onboarding/run-first-task',
    // AUDIT-API1: this endpoint spends the operator's stored provider key on
    // a real LLM call — it needs the same admin guard as save-config.
    requireOnboardingConfigAdmin,
    validateBody(runFirstTaskBody),
    async (req: Request, res: Response) => {
      try {
        const body = req.body as z.infer<typeof runFirstTaskBody>;
        const task = body.task;
        const resolved = await resolveProvider();

        // 若 provider 可用，尝试发起一次真实的最小化调用
        if (resolved && (resolved.apiKey || resolved.id === 'ollama')) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
          try {
            let url: string;
            let init: RequestInit;

            if (resolved.apiType === 'anthropic') {
              url = `${resolved.baseUrl.replace(/\/+$/, '')}/messages`;
              init = {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': resolved.apiKey,
                  'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                  model: resolved.model,
                  max_tokens: 256,
                  messages: [{ role: 'user', content: task }],
                }),
                signal: controller.signal,
              };
            } else if (resolved.apiType === 'google') {
              url = `${resolved.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(
                resolved.model,
              )}:generateContent`;
              init = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': resolved.apiKey },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: task }] }],
                  generationConfig: { maxOutputTokens: 256 },
                }),
                signal: controller.signal,
              };
            } else {
              url = `${resolved.baseUrl.replace(/\/+$/, '')}/chat/completions`;
              const headers: Record<string, string> = { 'Content-Type': 'application/json' };
              if (resolved.apiKey) {
                headers['Authorization'] = `Bearer ${resolved.apiKey}`;
              }
              init = {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  model: resolved.model,
                  max_tokens: 256,
                  messages: [{ role: 'user', content: task }],
                }),
                signal: controller.signal,
              };
            }

            const response = await fetch(url, init);
            if (response.ok) {
              const data = (await response.json()) as Record<string, unknown>;
              // 提取可读的回复文本（兼容三种协议）
              let text = '';
              if (resolved.apiType === 'anthropic') {
                const content = data.content as Array<{ type: string; text?: string }> | undefined;
                text = Array.isArray(content)
                  ? content
                      .filter((c) => c.type === 'text' && typeof c.text === 'string')
                      .map((c) => c.text as string)
                      .join('')
                  : '';
              } else if (resolved.apiType === 'google') {
                const candidates = data.candidates as
                  Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
                text = Array.isArray(candidates)
                  ? (candidates[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
                  : '';
              } else {
                const choices = data.choices as
                  Array<{ message?: { content?: string } }> | undefined;
                text =
                  Array.isArray(choices) && choices[0]?.message?.content
                    ? (choices[0].message.content as string)
                    : '';
              }
              await markRealFirstTaskCompleted(resolved.id, resolved.model);
              return res.json({
                success: true,
                source: 'real',
                result: text || '(empty response)',
                provider: resolved.id,
                model: resolved.model,
              });
            }

            return res.status(502).json({
              success: false,
              error: `Provider request failed (HTTP ${response.status})`,
            });
          } catch (err) {
            const isAbort = err instanceof Error && err.name === 'AbortError';
            return res.status(502).json({
              success: false,
              error: isAbort
                ? `Request timed out after ${PROVIDER_TEST_TIMEOUT_MS / 1000}s`
                : 'Unable to reach provider',
            });
          } finally {
            clearTimeout(timer);
          }
        }

        return res.status(409).json({
          success: false,
          error: 'No provider API key configured',
        });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── POST /api/onboarding/complete ───────────────────────────────────────
  router.post(
    '/api/onboarding/complete',
    requireOnboardingConfigAdmin,
    validateBody(completeBody),
    async (req: Request, res: Response) => {
      try {
        const body = req.body as z.infer<typeof completeBody>;
        const userId = body.userId ?? 'anonymous';
        const realFirstTaskCompleted =
          (await dirHasContent(TRACES_DIR)) || fsSync.existsSync(ONBOARDING_FIRST_TASK_FILE);
        const steps = (Array.isArray(body.steps) ? body.steps : []).filter(
          (step) => step !== 'first-task' || realFirstTaskCompleted,
        );
        const payload = {
          completedAt: new Date().toISOString(),
          userId,
          steps,
        };
        if (!fsSync.existsSync(COMMANDER_DIR)) {
          await fsp.mkdir(COMMANDER_DIR, { recursive: true });
        }
        atomicWriteFileSync(ONBOARDING_COMPLETE_FILE, JSON.stringify(payload, null, 2));
        res.json({ success: true, completedAt: payload.completedAt });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  return router;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function markRealFirstTaskCompleted(provider: string, model: string): Promise<void> {
  if (!fsSync.existsSync(COMMANDER_DIR)) {
    await fsp.mkdir(COMMANDER_DIR, { recursive: true });
  }
  atomicWriteFileSync(
    ONBOARDING_FIRST_TASK_FILE,
    JSON.stringify({ completedAt: new Date().toISOString(), provider, model }, null, 2),
  );
}
