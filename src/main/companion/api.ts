/**
 * DeepSeek / OpenAI 兼容对话客户端
 *
 * 走标准 POST {baseUrl}/chat/completions，支持：
 *  - 思考强度 (reasoning_effort)：low / high / max，对应 DeepSeek V4 系列
 *  - 上下文缓存命��：prompt_cache_hit_tokens 会计入用量
 *  - 离峰/峰值价格差异由调用方自行决定时机
 *
 * 全部请求在主进程发起，渲染层永远拿不到 API Key。
 */
import type { CompanionConfig } from '../../shared/contracts';
import { isSseResponse, SseParser } from './sse';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletion {
  content: string;
  reasoning?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    cacheHitTokens?: number;
  };
}

export class CompanionApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'CompanionApiError';
    this.status = status;
    this.detail = detail;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * 解析本次调用实际使用的思考强度。
 * options.reasoningEffort 传空串 = 明确要求不带该字段（闲聊档）。
 */
function reasoningEffortOf(config: CompanionConfig, options: { reasoningEffort?: string }): string {
  return options.reasoningEffort !== undefined ? options.reasoningEffort : config.reasoningEffort;
}

export function isConfigured(config: CompanionConfig): boolean {
  return Boolean(config.apiKey.trim()) && Boolean(config.baseUrl.trim());
}

/**
 * 调用对话补全接口。
 * 失败时抛出 CompanionApiError，调用方负责降级到本地兜底回复。
 */
export async function complete(
  config: CompanionConfig,
  messages: ChatMessage[],
  options: { signal?: AbortSignal; timeoutMs?: number; maxTokens?: number; reasoningEffort?: string } = {},
): Promise<ChatCompletion> {
  if (!isConfigured(config)) {
    throw new CompanionApiError(0, '未配置 API Key 或服务地址');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.timeoutMs ?? 45_000);
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

  try {
    const response = await fetch(`${trimTrailingSlash(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        // 预算档位可以覆盖配置里的固定上限（闲聊用更小的输出）
        max_tokens: options.maxTokens ?? config.maxTokens,
        // 思考强度同样可按档位覆盖：闲聊传空串表示不带该字段 ——
        // flash 类轻量模型本来就不思考，硬带 low 只会多烧 token 或被上游拒
        ...(reasoningEffortOf(config, options) ? { reasoning_effort: reasoningEffortOf(config, options) } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CompanionApiError(response.status, text.slice(0, 500) || `HTTP ${response.status}`);
    }

    // 流式响应：SSE（Server-Sent Events，服务器推送事件流）。
    // 本机 DSH 桥接只提供 SSE，必须按流读 —— 用 response.json() 会直接报错。
    const contentType = response.headers.get('content-type');
    if (isSseResponse(contentType)) {
      return await readSseCompletion(response, controller.signal);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
    };
    const message = payload.choices?.[0]?.message;
    const content = (message?.content ?? '').trim();
    if (!content) {
      throw new CompanionApiError(response.status, '模型返回了空内容');
    }
    return {
      content,
      reasoning: message?.reasoning_content?.trim() || undefined,
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
        cacheHitTokens: payload.usage?.prompt_cache_hit_tokens,
      },
    };
  } catch (error) {
    if (error instanceof CompanionApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CompanionApiError(0, '请求超时');
    }
    throw new CompanionApiError(0, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

/**
 * 读取 SSE 流式响应并拼成完整回复。
 */
async function readSseCompletion(
  response: Response,
  signal: AbortSignal,
): Promise<ChatCompletion> {
  const body = response.body;
  if (!body) throw new CompanionApiError(0, '流式响应没有内容');

  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();

  try {
    for (;;) {
      if (signal.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      if (parser.error) throw new CompanionApiError(0, parser.error);
      if (parser.isFinished) break;
    }
    parser.flush();
  } finally {
    reader.cancel().catch(() => {});
  }

  if (parser.error) throw new CompanionApiError(0, parser.error);
  const content = parser.text.trim();
  if (!content) {
    throw new CompanionApiError(0, '模型返回了空内容');
  }
  return { content };
}
