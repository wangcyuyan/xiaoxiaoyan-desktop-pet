/**
 * 本机 DSH 桥接发现
 *
 * 背景：
 *   桌宠要能用「不花钱」的模型（Trae 积分换来的免费额度），最省事的路径是
 *   让 DSH 在本机暴露一个 OpenAI 兼容端点，然后桌宠连它。
 *
 *   但让用户手工填 baseUrl 与令牌是不友好的 —— 令牌是随机生成的，
 *   每次 DSH 重启都可能变。所以这里做自动发现：
 *
 *   1. 读 ~/.dsh/openai-bridge.json 拿令牌（插件写、桌宠读，同一个文件）
 *   2. 探测 DSH 的 HTTP 端口（从本机监听列表里找）
 *   3. 试探 /v1/bridge/models，确认端点真的在
 *
 *   全部成功才算「发现成功」，否则桌宠保持原配置不动。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** 桥接插件写的状态文件 */
const BRIDGE_STATE_FILE = 'openai-bridge.json';
/** 桥接端点前缀 */
const BRIDGE_PREFIX = '/v1/bridge';
/** 探测超时（毫秒） */
const PROBE_TIMEOUT_MS = 1500;

/**
 * DSH 桥接的连接信息
 */
export interface BridgeEndpoint {
  /** OpenAI 兼容 baseUrl，形如 http://127.0.0.1:18087/v1/bridge */
  baseUrl: string;
  /** Bearer 令牌 */
  apiKey: string;
  /** 探测到的可用模型（可能为空） */
  models: string[];
}

/**
 * DSH home 目录。
 */
function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}

/**
 * 读取桥接令牌。
 */
async function readBridgeToken(): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(resolveDshHome(), BRIDGE_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.length > 0) return parsed.token;
  } catch {
    // 桥接没装或没跑
  }
  return undefined;
}

/**
 * 列出本机正在监听的 TCP 端口及其进程。
 *
 * 用 netstat 而不是 lsof —— Windows 上 netstat 一定有，
 * 而解析它的输出比跨平台调用系统 API 省事得多。
 */
async function listListeningPorts(): Promise<number[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const ports = new Set<number>();
  try {
    const { stdout } = await run('netstat', ['-ano'], { timeout: 5000, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      // 只看 LISTENING 行，取本地地址的端口
      if (!/LISTENING/i.test(line)) continue;
      const match = /:(\d+)\s+\S+\s+LISTENING/i.exec(line);
      if (!match?.[1]) continue;
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  } catch {
    // netstat 不可用
  }
  return [...ports];
}

/**
 * 试探一个端口上的桥接端点。
 *
 * @returns 探测到的模型列表；不是桥接则返回 undefined
 */
async function probeBridge(
  port: number,
  token: string,
): Promise<string[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${BRIDGE_PREFIX}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(payload.data)) return undefined;
    return payload.data
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 桥接的可用性诊断。
 */
export interface BridgeHealth {
  /** 桥接是否可达 */
  reachable: boolean;
  /** 可用模型数 */
  modelCount: number;
  /** 原因说明（不可达时给出人话） */
  reason?: string;
}

/**
 * 检查桥接是否真的能对话（而不只是能列模型）。
 *
 * 桥接在但没有凭据（没装 Trae、没登录 DeepSeek 账号）时，
 * /models 会正常返回，但真正发请求会失败 —— 这时候要区分开，
 * 否则用户以为装好了，其实一句也说不出来。
 *
 * @returns 诊断结果
 */
export async function checkBridgeHealth(
  endpoint: BridgeEndpoint,
): Promise<BridgeHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({
        model: pickBridgeModel(endpoint.models) ?? '',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        reachable: false,
        modelCount: endpoint.models.length,
        reason: `桥接返回 HTTP ${response.status}`,
      };
    }
    // 读出流里的错误帧（桥接把上游失败如实透传）
    const text = await response.text();
    if (text.includes('"finish_reason":"error"') || text.includes('"error"')) {
      return {
        reachable: false,
        modelCount: endpoint.models.length,
        reason: '桥接已连通，但模型侧没有可用凭据（未装 Trae 或未登录模型账号）',
      };
    }
    return { reachable: true, modelCount: endpoint.models.length };
  } catch (error) {
    return {
      reachable: false,
      modelCount: endpoint.models.length,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 自动发现本机的 DSH 桥接端点。
 *
 * @param preferredPorts 优先尝试的端口（DSH 常用 18087 / 8787）
 * @returns 找到则返回连接信息，没找到返回 undefined
 */
export async function discoverBridge(
  preferredPorts: number[] = [18087, 8787, 18088],
): Promise<BridgeEndpoint | undefined> {
  const token = await readBridgeToken();
  if (!token) return undefined;

  const listening = await listListeningPorts();
  // 优先端口排前面，其余监听端口排后面（同样要试，因为 DSH 端口可配）
  const ordered = [
    ...preferredPorts.filter((port) => listening.includes(port)),
    ...listening.filter((port) => !preferredPorts.includes(port) && port > 1024),
  ];

  for (const port of ordered) {
    const models = await probeBridge(port, token);
    if (models === undefined) continue;
    return {
      baseUrl: `http://127.0.0.1:${port}${BRIDGE_PREFIX}`,
      apiKey: token,
      models,
    };
  }
  return undefined;
}

/**
 * 从桥接模型列表里挑一个合适的。
 *
 * 优先级：Trae 通道（积分计费，零成本）> 其它通道；
 * 同通道内 **Pro 档优先于 Flash** —— 用户实测反馈 Flash 轻量档明显降智，
 * 智力体验优先于省钱（Pro 走积分依然零成本，只是烧得略快）。
 * 前缀匹配时优先精确 "trae/" 通道而非 trae-vision 等变体。
 */
export function pickBridgeModel(models: string[]): string | undefined {
  if (models.length === 0) return undefined;
  const lower = models.map((id) => ({ id, key: id.toLowerCase() }));
  const trae = lower.filter((item) => item.key.includes('trae'));
  let pool = trae.length > 0 ? trae : lower;
  // 精确 trae/ 通道优先于 trae-vision / trae-global 等变体
  const exact = pool.filter((item) => item.key.startsWith('trae/'));
  if (exact.length > 0) pool = exact;
  const pro = pool.find((item) => item.key.includes('pro'));
  if (pro) return pro.id;
  const flash = pool.find((item) => item.key.includes('flash'));
  if (flash) return flash.id;
  return pool[0]?.id;
}
