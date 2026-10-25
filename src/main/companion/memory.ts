/**
 * 长期记忆存储
 *
 * 设计取舍：刻意不使用「向量数据库 + RAG」，而采用
 * 「本地文件持久化 + 分层上下文注入 + LLM 自我整理」：
 *   - 记忆是纯 JSON / Markdown，用户可以直接打开查看、编辑、删除
 *   - 不引入 embedding 服务依赖，冷启动即可用
 *   - 分层：核心档案(facts) / 近期对话(recent) / 归档(archive)
 *
 * 三层结构对应三种召回强度：
 *   核心档案  → 每次对话都注入（相当于"长期性格与关系设定"）
 *   近期对话  → 滚动窗口保留最近 N 轮
 *   归档      → 关键词命中才注入
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { BUDGET, excerpt, redact } from './budget';

/** 事实保鲜期：30 天没被提起且权重不足就下架 */
const FACT_TTL_MS = 30 * 24 * 3_600_000;
/** 下架事实的保存上限（保底可回溯，超出丢最旧） */
const RETIRED_CAP = 100;
/** 单次注入最多翻出的旧对话片段数 */
const ARCHIVE_HIT_LIMIT = 3;

/** 本地日期 key（YYYY-MM-DD） */
function dateKeyOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface MemoryFact {
  id: string;
  /** 事实主体，例如"用户"、"小小闫" */
  subject: string;
  /** 事实内容，例如"在准备 2027 考研" */
  content: string;
  /** 关键词，用于归档层命中 */
  keywords: string[];
  /** 创建时间戳 */
  createdAt: string;
  /** 最近一次被提及的时间戳 */
  updatedAt: string;
  /** 被提及次数 */
  mentions: number;
  /** 重要度 1-5，5 为最高 */
  weight: number;
}

export interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface MemoryStore {
  facts: MemoryFact[];
  recent: MemoryTurn[];
  archive: MemoryTurn[];
  /** 已下架的陈旧事实。重新提起（精确命中）会复活，所以不删除。 */
  retired?: MemoryFact[];
  /** 上次执行时效衰减的本地日期（一天最多跑一次） */
  lastDecayAt?: string;
  /** 已生成过每日摘要的那一天（本地日期） */
  lastDailySummaryFor?: string;
  /** 累计对话轮数 */
  totalTurns: number;
  /** 上次自我整理时间 */
  lastConsolidatedAt?: string;
}

export interface MemoryInjection {
  /** 注入到系统提示词的长期上下文 */
  context: string;
  /** 本次召回了哪些事实 */
  recalled: MemoryFact[];
  /** 本次从归档翻出的旧对话片段数 */
  recalledArchive?: number;
}

/**
 * 生成独立的空存储。
 * 注意：必须逐个复制数组，不能用 { ...EMPTY_STORE } 浅拷贝，
 * 否则多个 MemoryManager 实例会共享同一批数组导致数据串台。
 */
function emptyStore(): MemoryStore {
  return { facts: [], recent: [], archive: [], totalTurns: 0 };
}

export class MemoryManager {
  private readonly file: string;
  private readonly recentLimit: number;
  private readonly archiveLimit: number;
  private store: MemoryStore = emptyStore();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataDir: string, options: { recentLimit?: number; archiveLimit?: number } = {}) {
    this.file = path.join(userDataDir, 'companion-memory.json');
    this.recentLimit = options.recentLimit ?? 24;
    this.archiveLimit = options.archiveLimit ?? 200;
  }

  async load(): Promise<MemoryStore> {
    if (this.loaded) return this.store;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<MemoryStore>;
      this.store = {
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
        archive: Array.isArray(parsed.archive) ? parsed.archive : [],
        retired: Array.isArray(parsed.retired) ? parsed.retired : [],
        lastDecayAt: typeof parsed.lastDecayAt === 'string' ? parsed.lastDecayAt : undefined,
        lastDailySummaryFor: typeof parsed.lastDailySummaryFor === 'string' ? parsed.lastDailySummaryFor : undefined,
        totalTurns: typeof parsed.totalTurns === 'number' ? parsed.totalTurns : 0,
        lastConsolidatedAt: typeof parsed.lastConsolidatedAt === 'string' ? parsed.lastConsolidatedAt : undefined,
      };
    } catch {
      this.store = emptyStore();
    }
    this.loaded = true;
    // 每天第一次加载时跑时效衰减（下架陈年事实），一天只跑一次
    await this.decayStaleFacts();
    return this.store;
  }

  /**
   * 事实时效衰减（潮汐记忆第三层）：
   * 权重 <3 且连续 30 天没被提起的事实移入 retired —— 不删除，
   * 精确命中可复活。核心事实（权重 >=3）永不衰减，它们是关系的地基。
   */
  private async decayStaleFacts(): Promise<void> {
    const today = dateKeyOf(new Date());
    if (this.store.lastDecayAt === today) return;
    this.store.lastDecayAt = today;
    const cutoff = Date.now() - FACT_TTL_MS;
    const keep: MemoryFact[] = [];
    const retired = this.store.retired ?? [];
    let decayed = 0;
    for (const fact of this.store.facts) {
      if (fact.weight < 3 && Date.parse(fact.updatedAt) < cutoff) {
        retired.push(fact);
        decayed += 1;
      } else {
        keep.push(fact);
      }
    }
    if (decayed > 0) {
      this.store.facts = keep;
      this.store.retired = retired.slice(-RETIRED_CAP);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.store, null, 2);
    // 串行化写入，避免并发写导致的文件截断
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, this.file);
    }).catch(() => {});
    await this.writeQueue;
  }

  async snapshot(): Promise<MemoryStore> {
    await this.load();
    return JSON.parse(JSON.stringify(this.store)) as MemoryStore;
  }

  async listFacts(): Promise<MemoryFact[]> {
    await this.load();
    return [...this.store.facts].sort((a, b) => b.weight - a.weight || b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendTurn(role: 'user' | 'assistant', content: string): Promise<void> {
    await this.load();
    // 写入前脱敏：用户可能在聊天里贴了 key，不能落盘更不能回传模型
    const turn: MemoryTurn = { role, content: redact(content), at: new Date().toISOString() };
    this.store.recent.push(turn);
    this.store.totalTurns += 1;
    if (this.store.recent.length > this.recentLimit) {
      const overflow = this.store.recent.splice(0, this.store.recent.length - this.recentLimit);
      this.store.archive.push(...overflow);
      if (this.store.archive.length > this.archiveLimit) {
        this.store.archive.splice(0, this.store.archive.length - this.archiveLimit);
      }
    }
    await this.persist();
  }

  /**
   * 记录一条长期事实。相同 subject+content 会合并并提升提及次数。
   */
  async rememberFact(input: {
    subject: string;
    content: string;
    keywords?: string[];
    weight?: number;
  }): Promise<MemoryFact> {
    await this.load();
    const normalized = redact(input.content.trim()).slice(0, BUDGET.memoryItemChars);
    const now = new Date().toISOString();
    // 已下架的事实被重新提起 → 复活并续期（潮汐记忆的「提起即续期」）
    const retiredList = this.store.retired ?? [];
    const retiredIndex = retiredList.findIndex(
      (fact) => fact.subject === input.subject && fact.content === normalized,
    );
    if (retiredIndex >= 0) {
      const [revived] = retiredList.splice(retiredIndex, 1);
      const fact: MemoryFact = {
        ...(revived as MemoryFact),
        mentions: (revived as MemoryFact).mentions + 1,
        updatedAt: now,
      };
      this.store.facts.push(fact);
      await this.persist();
      return fact;
    }
    const existing = this.store.facts.find(
      (fact) => fact.subject === input.subject && fact.content === normalized,
    );
    if (existing) {
      existing.mentions += 1;
      existing.updatedAt = now;
      existing.weight = Math.min(5, Math.max(existing.weight, input.weight ?? 1) + (existing.mentions % 3 === 0 ? 1 : 0));
      await this.persist();
      return existing;
    }
    const fact: MemoryFact = {
      id: createHash('sha256').update(`${input.subject}\u0000${normalized}`).digest('hex').slice(0, 12),
      subject: input.subject.trim() || '用户',
      content: normalized,
      keywords: input.keywords ?? [],
      createdAt: now,
      updatedAt: now,
      mentions: 1,
      weight: Math.min(5, Math.max(1, input.weight ?? 1)),
    };
    this.store.facts.push(fact);
    await this.persist();
    return fact;
  }

  async forgetFact(id: string): Promise<boolean> {
    await this.load();
    const before = this.store.facts.length;
    this.store.facts = this.store.facts.filter((fact) => fact.id !== id);
    if (this.store.facts.length === before) return false;
    await this.persist();
    return true;
  }

  /**
   * 构建注入到系统提示词的分层上下文。
   * - 核心档案：权重 >= 3 的事实，始终注入
   * - 关键词命中：正文命中关键词的事实追加注入
   * - 归档检索（潮汐第四层）：事实没覆盖到的旧话题，翻归档原文片段兜底
   *
   * 预算约束：事实注入总量不超过 BUDGET.memoryChars，
   * 归档片段使用独立的 summaryChars 预算，单条不超过 memoryItemChars。
   *
   * 续期：被召回的事实刷新 updatedAt —— 30 天 TTL 靠「被提起」重置。
   * 心跳等合成话题不应续期，调用方传 { renew: false }。
   */
  async buildInjection(query: string, options: { renew?: boolean } = {}): Promise<MemoryInjection> {
    await this.load();
    const renew = options.renew !== false;
    const recalled: MemoryFact[] = [];
    const seen = new Set<string>();
    const lines: string[] = [];
    let used = 0;

    const core = this.store.facts
      .filter((fact) => fact.weight >= 3)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12);
    for (const fact of core) {
      if (seen.has(fact.id)) continue;
      const text = `- [${fact.subject}] ${redact(fact.content)}`;
      if (used + text.length > BUDGET.memoryChars) continue;
      seen.add(fact.id);
      recalled.push(fact);
      lines.push(text);
      used += text.length;
    }

    const keywords = extractKeywords(query);
    let recalledArchive = 0;
    if (keywords.length) {
      const matched = this.store.facts.filter((fact) => {
        if (seen.has(fact.id)) return false;
        const haystack = `${fact.content} ${fact.subject} ${fact.keywords.join(' ')}`.toLowerCase();
        return keywords.some((keyword) => haystack.includes(keyword));
      });
      for (const fact of matched.slice(0, 6)) {
        if (seen.has(fact.id)) continue;
        const text = `- [${fact.subject}] ${redact(fact.content)}`;
        if (used + text.length > BUDGET.memoryChars) continue;
        seen.add(fact.id);
        recalled.push(fact);
        lines.push(text);
        used += text.length;
      }

      // 归档检索：从最新往回翻，命中当前话题关键词的旧对话摘录进来。
      // 之前归档层只写不读 —— 存了 120 条却没有任何召回路径，等于死数据。
      const archiveHits: string[] = [];
      let archiveUsed = 0;
      for (
        let i = this.store.archive.length - 1;
        i >= 0 && archiveHits.length < ARCHIVE_HIT_LIMIT && archiveUsed < BUDGET.summaryChars;
        i -= 1
      ) {
        const turn = this.store.archive[i];
        if (!turn) continue;
        const haystack = turn.content.toLowerCase();
        if (!keywords.some((keyword) => haystack.includes(keyword))) continue;
        const quote = excerpt(
          `${turn.role === 'user' ? '用户' : '桌宠'}：${turn.content}`,
          BUDGET.memoryItemChars,
        );
        if (archiveUsed + quote.length > BUDGET.summaryChars) continue;
        archiveUsed += quote.length;
        archiveHits.push(`- [旧对话] ${quote}`);
      }
      if (archiveHits.length > 0) {
        lines.push('', '很久以前聊到过（旧对话摘录）：', ...archiveHits);
        recalledArchive = archiveHits.length;
      }
    }

    // 续期：被用户话题召回的事实刷新 updatedAt（TTL 靠「被提起」重置）
    if (renew && recalled.length > 0) {
      const now = new Date().toISOString();
      for (const fact of recalled) fact.updatedAt = now;
      await this.persist();
    }

    return {
      context: lines.length ? lines.join('\n') : '',
      recalled,
      recalledArchive,
    };
  }

  /** 取某一天（本地日期）的全部对话轮，近期与归档合并，按时间排序。 */
  async turnsOfDate(dateKey: string): Promise<MemoryTurn[]> {
    await this.load();
    return [...this.store.recent, ...this.store.archive]
      .filter((turn) => dateKeyOf(new Date(Date.parse(turn.at))) === dateKey)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** 标记某一天的每日摘要已完成（空天也标记，避免反复扫描）。 */
  async markDailySummary(dateKey: string): Promise<void> {
    await this.load();
    if (this.store.lastDailySummaryFor === dateKey) return;
    this.store.lastDailySummaryFor = dateKey;
    await this.persist();
  }

  /**
   * 自我整理：把近期对话压缩成结构化事实，减少上下文膨胀。
   * 由主进程在对话轮数达到阈值时触发。
   */
  async consolidate(extract: (turns: MemoryTurn[]) => Promise<Array<{ subject: string; content: string; weight?: number }>>): Promise<number> {
    await this.load();
    if (this.store.recent.length < 6) return 0;
    const candidates = this.store.recent.slice(-16);
    const extracted = await extract(candidates);
    for (const item of extracted) {
      await this.rememberFact({
        subject: item.subject,
        content: item.content,
        weight: item.weight ?? 3,
        keywords: extractKeywords(item.content),
      });
    }
    this.store.lastConsolidatedAt = new Date().toISOString();
    await this.persist();
    return extracted.length;
  }
}

/**
 * 从文本中抽取候选关键词。
 * 中文按 2-gram 切分，英文/数字按单词切分。
 */
export function extractKeywords(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[，。！？、；：""''（）()\[\]{}<>《》…—·\n\r\t]/g, ' ');
  const tokens = new Set<string>();
  for (const word of cleaned.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length >= 2) tokens.add(word);
      continue;
    }
    // 中文与符号混合：切成 2-gram
    const chars = Array.from(word);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const gram = `${chars[i] ?? ''}${chars[i + 1] ?? ''}`;
      if (/[\u4e00-\u9fa5]{2}/.test(gram)) tokens.add(gram);
    }
  }
  return [...tokens].slice(0, 24);
}
