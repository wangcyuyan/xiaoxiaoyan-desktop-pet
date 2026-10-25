/**
 * 好感度系统
 *
 * 背景：
 *   「回顾聊天记录来增强活人感」这条路的尽头是上下文无限膨胀 ——
 *   算力消耗与响应时间一起涨。社区里叫它「指数级增长」。
 *
 *   另一条路是：关系感不该靠翻阅全部历史来表达，而该由一个**关系状态**
 *   来承载。用户被认真对待过多少次、桌宠主动关心过几次、
 *   双方是否建立过信任 —— 这些是可累加、可衰减、可解释的数值。
 *
 *   本模块的数值不是装饰。它直接决定：
 *     - 桌宠**敢说什么**（低亲密度不敢主动关心、不敢提起过去）
 *     - 桌宠**做不做某件事**（是否主动提醒、是否主动搭话）
 *     - 桌宠**怎么说**（称呼、语气、长度）
 *
 * 三轴设计：
 *   intimacy 亲密度 —— 「我们有多熟」，决定主动性与话题深度
 *   energy   活力   —— 「我现在有没有劲」，决定是否主动开口
 *   trust    信任   —— 「你信不信我」，决定是否给建议与提醒
 *
 * 涨落的规则（关键：会掉，不是单向只涨）：
 *   - 用户主动说话 +1
 *   - 用户主动交互（摸头等）+2
 *   - 心跳被回应 +1
 *   - 心跳被无视 -1（沉默要有代价，否则关系是假的）
 *   - 每日涨幅上限，防止刷
 */

import type { CompanionState } from './persona';

/** 关系阶段 */
export type AffinityTier = 'stranger' | 'familiar' | 'close' | 'dependent' | 'tacit' | 'confidant';

/** 关系阶段定义 */
export interface TierDefinition {
  id: AffinityTier;
  /** 称号 */
  title: string;
  /** 进入该阶段所需的最低亲密度 */
  min: number;
  /** 该阶段解锁的行为（真正影响输出，不只是措辞） */
  unlocks: string[];
  /** 注入系统提示词的一句话描述 */
  guidance: string;
}

/**
 * 六级关系阶梯。
 *
 * 每一级解锁的是**行为差异**，不是形容词差异。
 * 这是与「温婉大方」式人设的根本区别 —— 后者模型学不像。
 */
export const TIERS: readonly TierDefinition[] = [
  {
    id: 'stranger',
    title: '初识',
    min: 0,
    unlocks: ['回应用户说的话'],
    guidance: '和用户还不太熟。只回应用户说的话，不主动开口，不提过去的事。',
  },
  {
    id: 'familiar',
    title: '熟悉',
    min: 15,
    unlocks: ['记住用户的称呼', '偶尔主动打招呼'],
    guidance: '和用户比较熟了。可以用记住的称呼，偶尔主动打个招呼。',
  },
  {
    id: 'close',
    title: '亲近',
    min: 30,
    unlocks: ['主动关心用户状态（熬夜/久坐/情绪）', '对用户的说法表达自己的看法'],
    guidance: '和用户亲近了。会主动关心用户的状态（熬夜、久坐、情绪低落），也敢说出自己的想法。',
  },
  {
    id: 'dependent',
    title: '依赖',
    min: 50,
    unlocks: ['主动提起过去记住的事', '主动分享自己的心情与日常'],
    guidance: '很依赖用户。会主动提起以前记住的事，也愿意分享自己的心情和日常。',
  },
  {
    id: 'tacit',
    title: '默契',
    min: 70,
    unlocks: ['用户低落时主动安慰（不用用户先开口）', '不用每次都问，直接给建议'],
    guidance: '和用户有默契了。用户情绪低落时不用他先开口，你主动安慰；给建议时不必先铺垫。',
  },
  {
    id: 'confidant',
    title: '挚友',
    min: 90,
    unlocks: ['可以撒娇、吐槽用户', '可以直接指出用户的问题', '敢说真话而不是只说好话'],
    guidance: '是用户的挚友。可以撒娇、可以吐槽、可以直接指出用户的问题 —— 但不许说刻薄的话伤害他。',
  },
] as const;

/** 每日亲密度涨幅上限，防止刷量 */
export const DAILY_GAIN_CAP = 20;

/** 涨分来源 */
export type AffinityEvent =
  | 'user_message'    // 用户主动说话
  | 'user_interaction' // 用户主动交互（摸头等）
  | 'heartbeat_ignored' // 心跳被无视
  | 'heartbeat_answered' // 心跳被回应
  | 'decay';          // 长时间没互动

/** 单次事件的分值变化 */
const EVENT_DELTA: Record<AffinityEvent, number> = {
  user_message: 1,
  user_interaction: 2,
  heartbeat_ignored: -1,
  heartbeat_answered: 1,
  decay: -2,
};

/**
 * 计算当前所处的关系阶段。
 */
export function tierOf(intimacy: number): TierDefinition {
  let current: TierDefinition = TIERS[0] as TierDefinition;
  for (const tier of TIERS) {
    if (intimacy >= tier.min) current = tier;
  }
  return current;
}

/**
 * 好感度推进结果
 */
export interface AffinityAdvance {
  state: CompanionState;
  /** 本次事件的原始分值 */
  delta: number;
  /** 是否触发了每日上限 */
  capped: boolean;
  /** 是否跨越了关系阶段（用于播报） */
  tierChanged: boolean;
  /** 变化后的阶段 */
  tier: TierDefinition;
}

/**
 * 推进好感度。
 *
 * @param state 当前状态
 * @param event 事件类型
 * @param options 附加信息
 */
export function advanceAffinity(
  state: CompanionState,
  event: AffinityEvent,
  options: { now?: number } = {},
): AffinityAdvance {
  const now = options.now ?? Date.now();
  const today = localDay(now);
  const previousTier = tierOf(state.intimacy);

  let delta = EVENT_DELTA[event];
  let capped = false;

  // 每日涨幅上限。
  // 「上次涨幅日期」只有一个来源：state.lastGainDate。
  // 早期版本从 options 传入，但调用方可能不传 —— 那时会被当成新的一天，
  // 上限形同虚设，刷多少都没关系。
  if (delta > 0) {
    const lastDay = state.lastGainDate;
    const isNewDay = lastDay !== today;
    const alreadyGained = isNewDay ? 0 : state.intimacyGainedToday ?? 0;
    const room = DAILY_GAIN_CAP - alreadyGained;
    if (room <= 0) {
      delta = 0;
      capped = true;
    } else if (delta > room) {
      delta = room;
      capped = true;
    }
  }

  const nextIntimacy = clamp(state.intimacy + delta, 0, 100);
  // 今日累计涨幅：同一天累加，跨天重置
  const sameDay = state.lastGainDate === today;
  const gainedToday = delta > 0
    ? (sameDay ? (state.intimacyGainedToday ?? 0) + delta : delta)
    : (sameDay ? (state.intimacyGainedToday ?? 0) : 0);

  // 活力：互动会补充活力，无视会消耗
  let energy = state.energy ?? 60;
  if (event === 'user_message') energy = clamp(energy + 6, 0, 100);
  else if (event === 'user_interaction') energy = clamp(energy + 10, 0, 100);
  else if (event === 'heartbeat_ignored') energy = clamp(energy - 8, 0, 100);
  else if (event === 'heartbeat_answered') energy = clamp(energy + 3, 0, 100);

  // 信任：靠长期互动累积，且要求亲密度到一定水平（陌生人不会轻易交心）
  let trust = state.trust ?? 20;
  if (event === 'user_message' || event === 'user_interaction') {
    const threshold = state.intimacy >= 30 ? 1 : 0;
    trust = clamp(trust + threshold, 0, 100);
  }

  const next: CompanionState = {
    ...state,
    intimacy: nextIntimacy,
    energy,
    trust,
    intimacyGainedToday: gainedToday,
    lastGainDate: today,
  };

  const tier = tierOf(nextIntimacy);

  return {
    state: next,
    delta,
    capped,
    tierChanged: tier.id !== previousTier.id,
    tier,
  };
}

/**
 * 判断某个行为当前是否被解锁。
 */
export function canDo(state: CompanionState, unlock: string): boolean {
  const tier = tierOf(state.intimacy);
  return tier.unlocks.includes(unlock);
}

/**
 * 是否应该主动开口。
 *
 * 规则：亲密度不够（<15）不说话；活力太低（<20）说明用户一直没理它，
 * 不该硬凑热闹；信任够高（>=50）时更容易主动。
 */
export function shouldSpeakProactively(state: CompanionState): boolean {
  if (state.intimacy < 15) return false;
  if ((state.energy ?? 60) < 20) return false;
  return true;
}

/**
 * 主动搭话的语气强度：0=沉默，1=轻描淡写，2=主动关心。
 */
export function proactiveIntensity(state: CompanionState): 0 | 1 | 2 {
  if (!shouldSpeakProactively(state)) return 0;
  if (canDo(state, '主动关心用户状态（熬夜/久坐/情绪）') && (state.trust ?? 0) >= 50) return 2;
  return 1;
}

/**
 * 把关系阶段注入系统提示词的段落。
 * 描述的是「现在允许做什么」，模型才知道该守哪条线。
 */
export function affinityGuidance(state: CompanionState): string {
  const tier = tierOf(state.intimacy);
  const lines: string[] = [];
  lines.push(`你们现在的关系是「${tier.title}」（亲密度 ${Math.round(state.intimacy)}）。`);
  lines.push(tier.guidance);
  const unlocked = tier.unlocks.filter((item) => item !== '回应用户说的话');
  if (unlocked.length > 0) {
    lines.push(`现在你可以：${unlocked.join('；')}。`);
  }
  // 下一级才解锁的能力 —— 措辞要说清「还没到那个程度」，
  // 不能写成「禁止这样做」，否则模型会真的把它当禁令。
  const nextTier = TIERS.find((next) => next.min > state.intimacy);
  const pending = nextTier
    ? nextTier.unlocks.filter((item) => !tier.unlocks.includes(item))
    : [];
  if (pending.length > 0) {
    lines.push(`还没到那一步的是：${pending.join('；')} —— 关系不够时不要硬做。`);
  }
  return lines.join('\n');
}

/** 本地日期 key */
function localDay(time: number): string {
  const date = new Date(time);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 数值夹取 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
