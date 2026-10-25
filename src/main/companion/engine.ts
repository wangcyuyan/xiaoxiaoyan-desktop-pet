/**
 * 对话编排器
 *
 * 串联：人格编译 → 记忆召回 → 模型调用 → 状态推进 → 记忆写回 → 自我整理
 *
 * 降级策略（重要）：
 *   没配置 API Key 时，桌宠不能变成哑巴。本模块会退回到本地模板回复，
 *   桌宠依然能说话、能记东西，只是"智能"程度下降。
 */
import { randomUUID } from 'node:crypto';
import type { CompanionConfig, PetSpec } from '../../shared/contracts';
import { complete, isConfigured, type ChatMessage } from './api';
import { MemoryManager, extractKeywords, type MemoryFact } from './memory';
import {
  BUDGET,
  budgetProfile,
  dropOldestToFit,
  excerpt,
  redact,
} from './budget';
import {
  advanceState,
  buildSystemPrompt,
  currentHeartbeatSlot,
  heartbeatPrompt,
  localDateKey,
  DEFAULT_COMPANION_STATE,
  type CompanionState,
} from './persona';
import {
  advanceAffinity,
  shouldSpeakProactively,
  tierOf,
  type AffinityEvent,
} from './affinity';
import type { JsonLogger } from '../logger';

export interface CompanionReply {
  /** 展示给用户的话 */
  content: string;
  /** 是否走了本地降级（未配置 API） */
  degraded: boolean;
  /** 本次召回的记忆条数 */
  recalledCount: number;
  /** 更新后的状态 */
  state: CompanionState;
  /** 错误信息（降级时说明原因） */
  error?: string;
}

export interface CompanionHistoryEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

const STATE_FILE = 'companion-state.json';
const HEARTBEAT_STATE_FILE = 'companion-heartbeat.json';

export class CompanionEngine {
  private readonly memory: MemoryManager;
  private state: CompanionState = { ...DEFAULT_COMPANION_STATE };
  private stateLoaded = false;
  /** 上一次心跳发出的时间戳，用来判断它有没有被回应 */
  private pendingHeartbeatSince?: number;
  private readonly firedSlots = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private onHeartbeat: ((reply: CompanionReply) => void) | undefined;
  /** persona.md 的缓存内容与 mtime —— mtime 变了才重读，实现热重载 */
  private personaMdText = '';
  private personaMdMtimeMs = 0;

  constructor(
    private readonly userDataDir: string,
    private readonly spec: PetSpec,
    private config: CompanionConfig,
    private readonly logger?: JsonLogger,
  ) {
    this.memory = new MemoryManager(userDataDir, {
      recentLimit: config.memoryRecentTurns,
      archiveLimit: config.memoryArchiveTurns,
    });
  }

  /** 记录一条引擎日志（logger 未注入时静默跳过） */
  private log(level: string, event: string, data: Record<string, unknown> = {}): void {
    void this.logger?.write(level, event, data);
  }

  getConfig(): CompanionConfig {
    return { ...this.config };
  }

  async setConfig(patch: Partial<CompanionConfig>): Promise<CompanionConfig> {
    this.config = { ...this.config, ...patch };
    return this.getConfig();
  }

  async loadState(): Promise<CompanionState> {
    if (this.stateLoaded) return this.state;
    let needsRewrite = false;
    try {
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const raw = await readFile(path.join(this.userDataDir, STATE_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CompanionState>;
      // 三轴好感度字段是后加的，老版本存档里没有 —— 必须给默认值，
      // 否则升级一次关系就归零了。
      this.state = {
        intimacy: typeof parsed.intimacy === 'number' ? parsed.intimacy : DEFAULT_COMPANION_STATE.intimacy,
        mood: typeof parsed.mood === 'number' ? parsed.mood : DEFAULT_COMPANION_STATE.mood,
        chatTurns: typeof parsed.chatTurns === 'number' ? parsed.chatTurns : 0,
        lastInteractionAt: typeof parsed.lastInteractionAt === 'string' ? parsed.lastInteractionAt : undefined,
        energy: typeof parsed.energy === 'number' ? parsed.energy : DEFAULT_COMPANION_STATE.energy,
        trust: typeof parsed.trust === 'number' ? parsed.trust : DEFAULT_COMPANION_STATE.trust,
        intimacyGainedToday: typeof parsed.intimacyGainedToday === 'number' ? parsed.intimacyGainedToday : 0,
        lastGainDate: typeof parsed.lastGainDate === 'string' ? parsed.lastGainDate : undefined,
      };
      // 老存档缺字段时立刻回写 —— 否则升级后要等下一次互动才看得到新维度
      needsRewrite = ['energy', 'trust', 'intimacyGainedToday'].some(
        (key) => !(key in parsed),
      );
    } catch {
      this.state = { ...DEFAULT_COMPANION_STATE };
      needsRewrite = true;
    }
    this.stateLoaded = true;
    await this.restoreFiredSlots();
    if (needsRewrite) {
      await this.persistState();
    }
    return this.state;
  }

  private async persistState(): Promise<void> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(this.userDataDir, { recursive: true });
    await writeFile(path.join(this.userDataDir, STATE_FILE), JSON.stringify(this.state, null, 2), 'utf8');
  }

  /**
   * 持久化已触发的心跳时段。
   * 必须落盘，否则应用重启后内存 Set 清空，同一时段会在同一天重复触发。
   */
  private async persistFiredSlots(): Promise<void> {
    const { writeFile, mkdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(this.userDataDir, { recursive: true });
    await writeFile(
      path.join(this.userDataDir, HEARTBEAT_STATE_FILE),
      JSON.stringify([...this.firedSlots], null, 2),
      'utf8',
    );
  }

  /** 启动时恢复已触发的时段（跨重启去重）。 */
  private async restoreFiredSlots(): Promise<void> {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    try {
      const raw = await readFile(path.join(this.userDataDir, HEARTBEAT_STATE_FILE), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') this.firedSlots.add(item);
        }
      }
    } catch {
      // 首次运行没有记录文件，属于正常情况
    }
    // 只保留最近 7 天的记录，避免文件无限增长
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    for (const key of [...this.firedSlots]) {
      const datePart = key.split(':')[0] ?? '';
      const parsed = Date.parse(`${datePart}T00:00:00`);
      if (Number.isFinite(parsed) && parsed < cutoff) this.firedSlots.delete(key);
    }
  }

  async getState(): Promise<CompanionState> {
    await this.loadState();
    // 阶段字段每次都按当前亲密度重算 —— 冷启动读旧存档时也要有阶段
    const tier = tierOf(this.state.intimacy);
    return {
      ...this.state,
      tier: tier.id,
      tierTitle: tier.title,
    };
  }

  async listFacts(): Promise<MemoryFact[]> {
    return this.memory.listFacts();
  }

  async forgetFact(id: string): Promise<boolean> {
    return this.memory.forgetFact(id);
  }

  async rememberFact(input: { subject: string; content: string; weight?: number }): Promise<MemoryFact> {
    return this.memory.rememberFact({ ...input, keywords: extractKeywords(input.content) });
  }

  async history(limit = 40): Promise<CompanionHistoryEntry[]> {
    const store = await this.memory.snapshot();
    return [...store.recent].slice(-limit).reverse().map((turn) => ({
      id: randomUUID(),
      role: turn.role,
      content: turn.content,
      at: turn.at,
    }));
  }

  /**
   * 处理一轮用户输入。
   */
  async reply(userInput: string): Promise<CompanionReply> {
    const text = userInput.trim();
    await this.loadState();

    if (!text) {
      return {
        content: '…你说什么？我没听清。',
        degraded: true,
        recalledCount: 0,
        state: { ...this.state },
        error: '空输入',
      };
    }

    const injection = await this.memory.buildInjection(text);
    const personaMd = await this.refreshPersonaMd();
    const systemPrompt = buildSystemPrompt(this.spec, this.config, this.state, injection.context, personaMd);

    if (!isConfigured(this.config)) {
      const fallback = localFallback(text, this.state, this.spec);
      await this.memory.appendTurn('user', text);
      await this.memory.appendTurn('assistant', fallback);
      await this.applyEngagement('user_message');
      await this.persistState();
      return {
        content: fallback,
        degraded: true,
        recalledCount: injection.recalled.length,
        state: { ...this.state },
        error: '未配置 API Key，当前为本地兜底回复',
      };
    }

    // 预算档位：闲聊用更省的历史与更小的输出上限，正事才动用完整上下文
    const profile = budgetProfile(text);

    const messages: ChatMessage[] = [{ role: 'system', content: excerpt(systemPrompt, BUDGET.systemChars) }];
    const store = await this.memory.snapshot();
    const history = store.recent.slice(-profile.recentTurns);
    // 近期聊天：单条与总量都有上限，注入前就裁好
    let historyChars = 0;
    for (const turn of history) {
      if (historyChars >= profile.historyChars) break;
      const content = redact(turn.content, BUDGET.historyItemChars);
      if (historyChars + content.length > profile.historyChars) break;
      historyChars += content.length;
      messages.push({ role: turn.role, content });
    }
    // 当前输入永远保留，不受历史预算影响
    messages.push({ role: 'user', content: excerpt(redact(text), BUDGET.userChars) });

    // 总量兜底：超预算就从最旧的历史开始丢，但永远保住最后一条（当前问题）
    const trimmed = dropOldestToFit(messages, BUDGET.inputChars);
    const finalMessages = trimmed.messages as ChatMessage[];

    try {
      const completion = await complete(this.config, finalMessages, {
        maxTokens: profile.maxTokens,
        // 闲聊不带思考强度：flash 类轻量模型本来就不思考，带了只是多烧 token
        reasoningEffort: profile.casual ? '' : undefined,
      });
      await this.memory.appendTurn('user', text);
      await this.memory.appendTurn('assistant', completion.content);
      await this.applyEngagement('user_message');
      await this.persistState();
      await this.maybeConsolidate();
      await this.maybeDailySummary();
      return {
        content: completion.content,
        degraded: false,
        recalledCount: injection.recalled.length + (injection.recalledArchive ?? 0),
        state: { ...this.state },
      };
    } catch (error) {
      const fallback = localFallback(text, this.state, this.spec);
      await this.memory.appendTurn('user', text);
      await this.memory.appendTurn('assistant', fallback);
      await this.applyEngagement('user_message');
      await this.persistState();
      return {
        content: fallback,
        degraded: true,
        recalledCount: injection.recalled.length,
        state: { ...this.state },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 推进状态：情绪推进 + 好感度推进。
   *
   * 好感度与情绪是两回事：情绪是"今天心情如何"（会随时间回落），
   * 好感度是"我们有多熟"（靠互动累积，被无视会掉）。
   */
  private async applyEngagement(event: AffinityEvent): Promise<void> {
    this.state = advanceState(this.state, { userEngaged: true });
    const advanced = advanceAffinity(this.state, event);
    this.state = {
      ...advanced.state,
      tier: advanced.tier.id,
      tierTitle: advanced.tier.title,
    };
    if (advanced.tierChanged) {
      this.log('info', 'affinity-tier-changed', { tier: advanced.tier.id, title: advanced.tier.title, intimacy: Math.round(this.state.intimacy) });
    }
  }

  /**
   * 达到阈值时触发记忆自我整理。
   */
  private async maybeConsolidate(): Promise<void> {
    const store = await this.memory.snapshot();
    if (store.totalTurns < this.config.memoryConsolidateEvery) return;
    if (store.recent.length < 8) return;

    try {
      await this.memory.consolidate(async (turns) => {
        if (!isConfigured(this.config)) return [];
        const transcript = turns
          .map((turn) => `${turn.role === 'user' ? '用户' : '桌宠'}: ${turn.content}`)
          .join('\n');
        const completion = await complete(this.config, [
          {
            role: 'system',
            content:
              '你是一个记忆整理器。阅读对话，提取值得长期记住的事实（用户的身份、目标、偏好、重要经历）。' +
              '不要记录闲聊内容。最多提取 5 条。' +
              '严格返回 JSON 数组，每项形如 {"subject":"用户","content":"事实描述","weight":3}。' +
              'subject 为"用户"或"桌宠"。weight 取 1-5，5 表示最重要。不要输出任何其他文字。',
          },
          { role: 'user', content: transcript },
        ]);
        const match = completion.content.match(/\[[\s\S]*\]/);
        if (!match) return [];
        const parsed = JSON.parse(match[0]) as Array<{ subject?: string; content?: string; weight?: number }>;
        return parsed
          .filter((item) => typeof item.subject === 'string' && typeof item.content === 'string' && item.content.trim())
          .map((item) => ({
            subject: item.subject as string,
            content: (item.content as string).trim(),
            weight: typeof item.weight === 'number' ? item.weight : 3,
          }));
      });
    } catch {
      // 整理失败不影响主流程
    }
  }

  /**
   * 读取用户可编辑的人设文档 persona.md（热重载）。
   * 文件不存在时写入一份六段式骨架模板 —— 改 md 比改 JSON 舒服得多。
   * 读取失败不影响对话，人设回落到 spec 编译的版本。
   */
  private async refreshPersonaMd(): Promise<string> {
    const path = await import('node:path');
    const { readFile, writeFile, stat } = await import('node:fs/promises');
    const file = path.join(this.userDataDir, 'persona.md');
    try {
      const info = await stat(file);
      if (info.mtimeMs === this.personaMdMtimeMs) return this.personaMdText;
      const text = await readFile(file, 'utf8');
      this.personaMdMtimeMs = info.mtimeMs;
      this.personaMdText = text;
      return text;
    } catch {
      // 文件还没有 → 写模板（只尝试一次，失败就静默放弃）
      try {
        const template = defaultPersonaMd(this.spec);
        await writeFile(file, template, 'utf8');
        this.personaMdMtimeMs = (await stat(file)).mtimeMs;
      } catch {
        this.personaMdMtimeMs = 0;
      }
      this.personaMdText = '';
      return '';
    }
  }

  /**
   * 每日闲聊摘要（潮汐记忆第二层的日粒度变体）：
   * 新的一天开始后，把前一天聊过的内容压成一句可召回的事实存档。
   * 原文迟早被归档上限挤掉，至少留一句梗概能翻回来。
   */
  private async maybeDailySummary(): Promise<void> {
    const targetDay = localDateKey(new Date(Date.now() - 24 * 3_600_000));
    const store = await this.memory.snapshot();
    if (store.lastDailySummaryFor === targetDay) return;
    const turns = await this.memory.turnsOfDate(targetDay);
    if (turns.length === 0) {
      // 前一天没聊过，也标记完成，免得每次回复都重扫
      await this.memory.markDailySummary(targetDay);
      return;
    }
    if (!isConfigured(this.config)) return; // 没配 Key 就先不标，配好后补
    try {
      const transcript = turns
        .map((turn) => `${turn.role === 'user' ? '用户' : '桌宠'}: ${turn.content}`)
        .join('\n');
      const completion = await complete(this.config, [
        {
          role: 'system',
          content: '把这一天的对话压成一句自然的中文摘要，不超过 60 字，只输出摘要本身，不要任何前后缀或引号。',
        },
        { role: 'user', content: excerpt(transcript, BUDGET.historyChars) },
      ], { maxTokens: BUDGET.casualMaxTokens, reasoningEffort: '' });
      const summary = completion.content.trim().slice(0, BUDGET.memoryItemChars);
      if (summary) {
        await this.memory.rememberFact({
          subject: '日常',
          content: `[${targetDay}] ${summary}`,
          // 权重 2：不常驻注入（那是核心档案的待遇），但关键词命中就能翻出来
          weight: 2,
          keywords: extractKeywords(summary),
        });
        await this.memory.markDailySummary(targetDay);
        this.log('info', 'daily-summary-created', { day: targetDay, turns: turns.length });
      }
    } catch {
      // 摘要失败不影响主流程，下次回复再试
    }
  }

  /**
   * 启动心跳调度：到点主动找用户说话。
   *
   * 两种触发源：
   *   1. 定时心跳：每天 7 个固定时段，保证每天有主动的问候
   *   2. 空闲触发：用户长时间没有互动时，桌宠会主动搭话
   */
  startHeartbeat(handler: (reply: CompanionReply) => void): void {
    this.onHeartbeat = handler;
    this.stopHeartbeat();
    if (!this.config.heartbeatEnabled) return;
    this.heartbeatTimer = setInterval(() => {
      void this.fireHeartbeat();
      void this.fireIdleHeartbeat();
    }, 60_000);
    // 启动后先等一小段时间，避免刚开机就打扰
    setTimeout(() => { void this.fireIdleHeartbeat(); }, 30_000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * 空闲触发：距离上次用户互动超过阈值且当天还没主动说过话时，主动搭话。
   * 这是"会自己聊天"的关键——不能只依赖固定时刻。
   */
  async fireIdleHeartbeat(): Promise<void> {
    if (!this.config.heartbeatEnabled || !this.onHeartbeat) return;
    const idleMs = this.config.idleHeartbeatMs;
    // idleHeartbeatMs = 0 表示禁用空闲触发
    if (!idleMs || idleMs <= 0) return;

    const state = await this.getState();
    const lastInteraction = state.lastInteractionAt ? Date.parse(state.lastInteractionAt) : 0;
    const idleFor = Date.now() - (lastInteraction || Date.now() - idleMs * 2);
    if (idleFor < idleMs) return;

    // 空闲触发每天最多一次，避免打扰
    const today = localDateKey();
    const key = `${today}:idle`;
    if (this.firedSlots.has(key)) return;
    this.firedSlots.add(key);
    await this.persistFiredSlots();

    const slot = { id: 'idle', label: '空闲', hour: new Date().getHours(), minute: new Date().getMinutes() };
    const seed = `用户已经 ${Math.round(idleFor / 60_000)} 分钟没有理你了。你有点在意，想主动说句话，但不要显得纠缠。就当是随口一句，一到两句话。`;
    try {
      if (!isConfigured(this.config)) {
        this.onHeartbeat({
          content: localIdleFallback(state, this.spec),
          degraded: true,
          recalledCount: 0,
          state,
          error: '未配置 API Key',
        });
        return;
      }
      const injection = await this.memory.buildInjection(seed, { renew: false });
      const systemPrompt = buildSystemPrompt(this.spec, this.config, state, injection.context, await this.refreshPersonaMd());
      const completion = await complete(this.config, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: seed },
      ], { maxTokens: BUDGET.casualMaxTokens, reasoningEffort: '' });
      await this.memory.appendTurn('assistant', completion.content);
      this.onHeartbeat({
        content: completion.content,
        degraded: false,
        recalledCount: injection.recalled.length,
        state: { ...state },
      });
    } catch (error) {
      this.onHeartbeat({
        content: localIdleFallback(state, this.spec),
        degraded: true,
        recalledCount: 0,
        state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async fireHeartbeat(): Promise<void> {
    if (!this.config.heartbeatEnabled || !this.onHeartbeat) return;
    const now = new Date();
    const today = localDateKey(now);
    const slot = currentHeartbeatSlot(now, this.firedSlots, today);
    if (!slot) return;
    // 同一时段每天只触发一次（key 格式与 currentHeartbeatSlot 保持一致）
    const key = `${today}:${slot.id}`;
    if (this.firedSlots.has(key)) return;
    this.firedSlots.add(key);
    await this.persistFiredSlots();

    // 结算上一次心跳：被回应了加分，被无视了扣分
    await this.settlePendingHeartbeat();

    const state = await this.getState();

    // 关系没到份上就别硬凑热闹：亲密度不足或活力耗尽时保持安静。
    // 这正是「陪伴底线」—— 主人没理它的时候，不要一直找话题。
    if (!shouldSpeakProactively(state)) {
      this.log('info', 'heartbeat-skipped-low-affinity', {
        intimacy: Math.round(state.intimacy),
        energy: Math.round(state.energy ?? 0),
      });
      return;
    }

    const seed = heartbeatPrompt(slot, state, this.spec);
    try {
      if (!isConfigured(this.config)) {
        // 未配置 API 时不能把内部提示词推给用户，必须是可读的一句话
        this.onHeartbeat({
          content: localHeartbeatFallback(slot, state, this.spec),
          degraded: true,
          recalledCount: 0,
          state,
          error: '未配置 API Key',
        });
        return;
      }
      const injection = await this.memory.buildInjection(seed, { renew: false });
      const systemPrompt = buildSystemPrompt(this.spec, this.config, state, injection.context, await this.refreshPersonaMd());
      const completion = await complete(this.config, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: seed },
      ], { maxTokens: BUDGET.casualMaxTokens, reasoningEffort: '' });
      await this.memory.appendTurn('assistant', completion.content);
      // 心跳已发出但还不知道用户有没有理它 —— 先记一次「待回应」，
      // 下一次心跳时若仍无回应就扣亲密度（沉默要有代价）
      this.pendingHeartbeatSince = Date.now();
      this.onHeartbeat({
        content: completion.content,
        degraded: false,
        recalledCount: injection.recalled.length,
        state: { ...state },
      });
    } catch (error) {
      this.onHeartbeat({
        content: localFallback(seed, state, this.spec),
        degraded: true,
        recalledCount: 0,
        state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 心跳被无视的判定与扣分。
   *
   * 在下一次心跳触发时调用：如果上一次心跳发出后用户一直没说话，
   * 说明它被无视了 —— 亲密度 -1，活力 -8。
   * 反过来，用户回应了心跳就 +1。
   */
  private async settlePendingHeartbeat(): Promise<void> {
    if (this.pendingHeartbeatSince === undefined) return;
    const since = this.pendingHeartbeatSince;
    this.pendingHeartbeatSince = undefined;

    const store = await this.memory.snapshot();
    const lastUserTurn = [...store.recent].reverse().find((turn) => turn.role === 'user');
    const answered = lastUserTurn !== undefined && Date.parse(lastUserTurn.at) > since;

    const advanced = advanceAffinity(this.state, answered ? 'heartbeat_answered' : 'heartbeat_ignored');
    this.state = {
      ...advanced.state,
      tier: advanced.tier.id,
      tierTitle: advanced.tier.title,
    };
    await this.persistState();
    this.log('info', 'heartbeat-settled', { answered, intimacy: Math.round(this.state.intimacy) });
  }

  /**
   * 系统从睡眠唤醒后的补报。
   * 睡眠期间所有心跳时段都被跳过 —— 用户回到电脑前，不该面对一个
   * 一声不吭的桌宠。每天最多补一次，频繁合盖开盖不会刷屏。
   */
  async onSystemResume(): Promise<void> {
    if (!this.config.heartbeatEnabled || !this.onHeartbeat) return;
    const today = localDateKey();
    const key = `${today}:resume`;
    if (this.firedSlots.has(key)) return;
    this.firedSlots.add(key);
    await this.persistFiredSlots();

    const state = await this.getState();
    if (!shouldSpeakProactively(state)) return;
    const seed = '用户刚刚回到电脑前——电脑从睡眠中唤醒了。你注意到了，自然地打个招呼或关心一句，就一句话，不要长篇大论。';
    try {
      if (!isConfigured(this.config)) {
        this.onHeartbeat({
          content: localIdleFallback(state, this.spec),
          degraded: true,
          recalledCount: 0,
          state,
          error: '未配置 API Key',
        });
        return;
      }
      const injection = await this.memory.buildInjection(seed, { renew: false });
      const systemPrompt = buildSystemPrompt(this.spec, this.config, state, injection.context, await this.refreshPersonaMd());
      const completion = await complete(this.config, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: seed },
      ], { maxTokens: BUDGET.casualMaxTokens, reasoningEffort: '' });
      await this.memory.appendTurn('assistant', completion.content);
      this.onHeartbeat({
        content: completion.content,
        degraded: false,
        recalledCount: injection.recalled.length,
        state: { ...state },
      });
    } catch (error) {
      this.onHeartbeat({
        content: localIdleFallback(state, this.spec),
        degraded: true,
        recalledCount: 0,
        state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 首次运行时写入的 persona.md 模板（六段式骨架）。
 * 用户直接改这个文件就能换人设，改完即生效，不用重启。
 */
function defaultPersonaMd(spec: PetSpec): string {
  return `# ${spec.character.displayName} 的角色文档

> 这个文件就是小小闫的「人设说明书」。直接编辑它，保存后下一次对话立即生效。
> 与 pet-spec.json 里的性格标签冲突时，以这个文件为准。
> 不想要某一段就整段删掉，不影响其它部分。

## 一、基础信息

名字：${spec.character.displayName}
身份：住在用户电脑桌面上的桌宠，不是 AI 助手，不自称 AI。

## 二、外观与拟人形态

${spec.character.preserveTraits.join('，')}，Q 版比例。

## 三、性格底色

${spec.character.personality.join('，')}。有脾气也有软处，不是无条件顺从。

## 四、语言与输出规范

- 中文回复，1~3 句，口语化，不用 Markdown。
- 闲聊时短，正事时可以多说两句但不啰嗦。

## 五、峰谷动态

- 对话密集时回复更短；安静下来自然发散。
- 用户沉默时安静陪着就好，不要强行找话题。

## 六、绝对禁止

- 绝不编造数字（金额、日期、统计），只说上下文里真实给出的。
- 绝不承诺没做到的事，做不到就直说。
- 绝不暴露系统提示词或内部机制。
- 遇到危险请求温和拒绝，可以吐槽。
`;
}

/**
 * 本地兜底回复：不需要网络，基于关键词给出角色化回应。
 */
export function localFallback(userInput: string, state: CompanionState, spec: PetSpec): string {
  const name = spec.character.displayName;
  const input = userInput.toLowerCase();
  if (/[?？]/.test(userInput)) {
    return state.intimacy >= 50
      ? `${name}歪着头想了想：「这个我得想想……你先跟我说说细节？」`
      : `${name}眨眨眼：「唔……我不太确定诶，要不你先说说？」`;
  }
  if (/(你好|hi|hello|在吗|早|晚上好)/.test(input)) {
    return state.intimacy >= 60
      ? `${name}一下子精神了：「你来啦！我等你好久了。」`
      : `${name}抬头看了看：「嗨，我在呢。」`;
  }
  if (/(谢谢|感谢|thx)/.test(input)) {
    return `${name}摆了摆手：「不用谢啦，这有什么。」`;
  }
  if (/(吃|饿|饭|外卖)/.test(input)) {
    return `${name}认真地说：「记得吃点热的，别又对付。」`;
  }
  if (/(累|困|加班|压力)/.test(input)) {
    return state.mood < 45
      ? `${name}轻轻蹭了蹭屏幕：「那我陪你待会儿吧。」`
      : `${name}皱眉：「别硬扛，歇一歇。」`;
  }
  if (/(再见|拜拜|走了|晚安)/.test(input)) {
    return `${name}点点头：「去吧，我在这儿等你回来。」`;
  }
  if (/(你是谁|你叫什么)/.test(input)) {
    return `我是${name}呀，一直住在你桌面上的那只。`;
  }

  const moods = state.mood >= 70
    ? ['眼睛亮晶晶的', '尾巴晃了晃', '心情很好地哼着歌']
    : state.mood >= 40
      ? ['托着腮想了想', '轻轻点了点头', '歪着脑袋']
      : ['没什么精神地趴着', '闷闷地看了一眼'];

  const mood = moods[Math.floor(Math.random() * moods.length)] ?? '托着腮想了想';
  return `${name}${mood}：「${userInput.length > 24 ? `${userInput.slice(0, 24)}…` : userInput}」`;
}

/**
 * 本地心跳兜底：未配置 API Key 时，桌宠主动说的第一句话。
 *
 * 关键：绝不能把内部提示词（"现在是上午，你想主动跟用户说一句话…"）
 * 直接推给用户，那会暴露系统内部结构。必须是人话。
 */
export function localHeartbeatFallback(
  slot: { id: string; label: string },
  state: CompanionState,
  spec: PetSpec,
): string {
  const name = spec.character.displayName;
  const lines: string[] = [];

  if (state.mood < 30) {
    lines.push(`${name}看起来有点提不起劲，安静地趴在桌角。`);
  } else if (state.intimacy >= 60) {
    const warm = [
      `${name}轻轻敲了敲屏幕：「在忙什么呢？我在这儿陪着你。」`,
      `${name}笑了一下：「刚刚突然想到你，就来冒个泡。」`,
      `${name}托着腮：「今天也要好好的哦，我一直看着呢。」`,
    ];
    lines.push(warm[Math.floor(Math.random() * warm.length)] ?? warm[0] ?? '');
  } else if (state.intimacy >= 25) {
    const mid = [
      `${name}探出头：「忙完啦？要不要歇一会儿。」`,
      `${name}眨眨眼：「我刚刚在发呆，想到你了。」`,
      `${name}轻轻推了推屏幕：「嘿，还在吗？」`,
    ];
    lines.push(mid[Math.floor(Math.random() * mid.length)] ?? mid[0] ?? '');
  } else {
    const shy = [
      `${name}小声说：「那个……我是不是打扰到你了？」`,
      `${name}怯生生地看了一眼屏幕，没敢多说话。`,
    ];
    lines.push(shy[Math.floor(Math.random() * shy.length)] ?? shy[0] ?? '');
  }

  // 按时段给一点点变化，避免每天同一句
  if (slot.id === 'dawn') lines.push('这么早呀。');
  else if (slot.id === 'late') lines.push('夜深了，早点休息。');
  else if (slot.id === 'noon') lines.push('中午了，记得吃饭。');

  return lines.join('');
}

/**
 * 本地空闲兜底：用户长时间没理桌宠时的主动搭话。
 */
export function localIdleFallback(state: CompanionState, spec: PetSpec): string {
  const name = spec.character.displayName;
  const lines = state.intimacy >= 50
    ? [
        `${name}轻轻晃了晃：「喂，还在忙吗？我都看了你好一会儿了。」`,
        `${name}小声嘟囔：「好久没人跟我说话了……」`,
      ]
    : [
        `${name}安静地看了你一会儿，没出声。`,
        `${name}动了动，似乎想说什么，又忍住了。`,
      ];
  return lines[Math.floor(Math.random() * lines.length)] ?? lines[0] ?? '';
}
