/**
 * 上下文预算与凭据脱敏
 *
 * 背景：
 *   桌宠早期把「最近 N 轮对话 + 全部长期记忆」原样塞进系统提示词，
 *   每条消息和每条事实都没有长度上限。长期使用后单次请求的上下文
 *   会持续膨胀 —— 表现为响应变慢、token 消耗上升，也就是社区里
 *   说的「回顾聊天记录增强活人感 → 算力消耗指数级增长」。
 *
 * 设计取舍：
 *   上下文膨胀的根因不是「记得多」，而是「没有上限」。
 *   所以这里给每一层都定死预算，并且在**注入之前**裁剪，
 *   而不是注入之后再补救。
 *
 *   超预算时的取舍顺序：先丢最旧的聊天，再丢低权重的记忆，
 *   永远保留当前这条用户输入 —— 用户正在说的话不能被挤掉。
 */

/**
 * 预算常量表。单位是「字符」而不是 token：
 * 字符数与 token 数不是线性关系，但字符预算足够作为一道硬闸门，
 * 且不依赖任何分词器实现。
 */
export const BUDGET = Object.freeze({
  /** 单次模型调用的总输入上限（含系统提示、消息结构） */
  inputChars: 16000,
  /** 单条用户输入上限 */
  userChars: 4000,
  /** 近期聊天注入总量上限 */
  historyChars: 4000,
  /** 单条聊天记录上限 */
  historyItemChars: 800,
  /** 长期记忆注入总量上限 */
  memoryChars: 1200,
  /** 单条长期记忆上限 */
  memoryItemChars: 160,
  /** 归档摘录注入上限 */
  summaryChars: 1000,
  /** 系统提示（人设 + 规则）上限 */
  systemChars: 4000,
  /** 回复 token 上限（普通对话） */
  replyMaxTokens: 640,
  /** 回复 token 上限（闲聊场景，更省） */
  casualMaxTokens: 320,
});

/**
 * 凭据脱敏。
 *
 * 命中常见密钥格式就替换成占位符，避免用户不小心把 key 打进聊天，
 * 之后被存进长期记忆再原样回传给模型。
 */
const SECRET_PATTERN =
  /\b(?:sk|ds|rk|xai|gsk|api)[-_][A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|(?:api[_ -]?key|apikey|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|密码|密钥|口令)\s*[=:：]\s*[^\s,，;；"'，。]{6,}/gi;

/** 脱敏后的占位文本 */
export const REDACTED = '[已隐藏凭据]';

/**
 * 去掉文本里的凭据。
 * @param text 原始文本
 * @param max 裁剪后的最大字符数（超长时保留头尾）
 */
export function redact(text: string, max?: number): string {
  if (!text) return '';
  const cleaned = text.replace(SECRET_PATTERN, REDACTED);
  if (max === undefined || cleaned.length <= max) return cleaned;
  return excerpt(cleaned, max);
}

/** 截短标记 */
const ELISION = '\n…[已截短]\n';

/**
 * 截短长文本：保留头部与尾部，中间用省略号标记。
 * 头部承载结论、尾部常带落点，所以两端都留。
 *
 * 注意：省略标记本身也占字符，必须算进预算 ——
 * 否则「裁到 100 字」会实际输出 109 字，预算形同虚设。
 */
export function excerpt(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  // 预算装不下标记时，直接硬切
  if (max <= ELISION.length) return text.slice(0, max);
  const room = max - ELISION.length;
  const head = Math.floor(room * 0.6);
  const tail = room - head;
  return `${text.slice(0, head)}${ELISION}${text.slice(-tail)}`;
}

/** 文本的字符长度 */
export function length(text: string): number {
  return text.length;
}

/**
 * 按预算裁剪一组带权重的条目。
 *
 * @param items 待选条目
 * @param totalBudget 总量上限（字符）
 * @param itemBudget 单条上限（字符）
 * @param measure 单条文本长度
 * @returns 保留的条目（保持原顺序）
 */
export function trimToBudget<T>(
  items: T[],
  totalBudget: number,
  itemBudget: number,
  measure: (item: T) => string,
): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    // 累加裁剪后的长度，不是原始长度 —— 否则预算会被高估
    const size = Math.min(measure(item).length, itemBudget);
    if (used + size > totalBudget) break;
    used += size;
    kept.push(item);
  }
  return kept;
}

/**
 * 注入前预算裁剪的结果
 */
export interface TrimmedContext {
  /** 裁剪后可以安全注入的文本 */
  text: string;
  /** 因预算被丢弃的条目数 */
  dropped: number;
  /** 实际使用的字符数 */
  used: number;
}

/**
 * 把多段文本按优先级塞进预算。
 *
 * @param segments 按优先级从高到低的文本段
 * @param totalBudget 总量上限
 */
export function packSegments(segments: string[], totalBudget: number): TrimmedContext {
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const segment of segments) {
    if (!segment) continue;
    // 连接符也算预算 —— 否则多段拼起来会超
    const separatorCost = kept.length > 0 ? 1 : 0;
    const remaining = totalBudget - used - separatorCost;
    if (remaining <= 0) {
      dropped += 1;
      continue;
    }
    if (segment.length > remaining) {
      // 放不下就截短后放，保证高优先级内容一定进得来
      kept.push(excerpt(segment, remaining));
      used += separatorCost + Math.min(segment.length, remaining);
      dropped += 1;
      continue;
    }
    kept.push(segment);
    used += separatorCost + segment.length;
  }
  return { text: kept.join('\n'), dropped, used };
}

/**
 * 溢出时丢弃最旧的消息，但永远保留最后一条（当前用户输入）。
 *
 * @param messages 消息列表，最后一条是当前输入
 * @param maxChars 总上限
 */
export function dropOldestToFit(
  messages: Array<{ role: string; content: string }>,
  maxChars: number,
): { messages: Array<{ role: string; content: string }>; dropped: number } {
  if (messages.length === 0) return { messages, dropped: 0 };
  const kept = [...messages];
  let dropped = 0;
  // 保留最后一条（当前问题），从倒数第二条开始丢
  while (kept.length > 2 && messagesLength(kept) > maxChars) {
    kept.splice(1, 1);
    dropped += 1;
  }
  return { messages: kept, dropped };
}

/** 消息列表的总字符数 */
export function messagesLength(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * 判断一段输入是「闲聊」还是「正事」。
 *
 * 闲聊用更省的预算（更短的历史、更小的输出上限），
 * 正事才动用完整上下文。这个判断只影响预算档位，不影响功能。
 */
const WORK_PATTERN =
  /文件|代码|项目|目录|命令|任务|会话|网页|截图|图片|照片|搜索|查找|读取|保存|修改|修复|创建|生成|运行|执行|打开|关闭|停止|取消|继续|安装|部署|打包|下载|上传|删除|设置|配置|整理|处理|统计|计算|分析|检查|优化|翻译|帮我|替我|给我|上次|之前|前面|刚才|\bcreate\b|\bedit\b|\bfix\b|\brun\b|\bexecute\b|\bdelete\b|\binstall\b|\bdeploy\b|\bbuild\b|\bmake\b|\bwrite\b|\bread\b|\bpatch\b|\breplace\b|\bstop\b|\bcancel\b|\bcontinue\b/i;

/**
 * 是否是工作类请求。
 */
export function isWorkRequest(text: string): boolean {
  if (!text) return false;
  return WORK_PATTERN.test(text);
}

/**
 * 按输入类型选择预算档位。
 * casual 标记给调用方用来决定是否省略思考强度 —— 闲聊不需要模型思考。
 */
export function budgetProfile(text: string): {
  casual: boolean;
  historyChars: number;
  maxTokens: number;
  recentTurns: number;
} {
  if (isWorkRequest(text)) {
    return {
      casual: false,
      historyChars: BUDGET.historyChars,
      maxTokens: BUDGET.replyMaxTokens,
      recentTurns: 12,
    };
  }
  return {
    casual: true,
    historyChars: 1800,
    maxTokens: BUDGET.casualMaxTokens,
    recentTurns: 6,
  };
}
