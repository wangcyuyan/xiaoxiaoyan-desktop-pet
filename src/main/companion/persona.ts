/**
 * 人格与情绪引擎
 *
 * 把 pet-spec.json 里的角色设定（性格、气质标签、语气）编译成系统提示词，
 * 并维护亲密度 / 情绪状态，让桌宠的回复随相处时间变化。
 */
import type { CompanionConfig, PetSpec } from '../../shared/contracts';
import { affinityGuidance } from './affinity';

export interface CompanionState {
  /** 亲密度 0-100 */
  intimacy: number;
  /** 情绪 0-100，越高越开心 */
  mood: number;
  /** 上次互动时间 */
  lastInteractionAt?: string;
  /** 累计聊天轮数 */
  chatTurns: number;
  /** 活力 0-100，决定是否主动开口 */
  energy?: number;
  /** 信任 0-100，决定是否给建议与提醒 */
  trust?: number;
  /** 今日已获得的亲密度涨幅 */
  intimacyGainedToday?: number;
  /** 上次获得亲密度涨幅的日期 */
  lastGainDate?: string;
  /** 当前关系阶段 id */
  tier?: string;
  /** 当前关系阶段称号 */
  tierTitle?: string;
}

export const DEFAULT_COMPANION_STATE: CompanionState = {
  intimacy: 20,
  mood: 70,
  chatTurns: 0,
  energy: 60,
  trust: 20,
  intimacyGainedToday: 0,
};

/**
 * 由 spec 编译系统提示词。
 * 亲密度越高，语气越亲近；情绪越低，语气越低落。
 * 关系阶段决定**能做什么**，不只影响措辞。
 *
 * personaMd 是用户目录下 persona.md 的内容（engine 负责热重载）。
 * JSON 管技术配置，md 管角色设定 —— md 里的内容优先级高于性格标签。
 */
export function buildSystemPrompt(
  spec: PetSpec,
  config: CompanionConfig,
  state: CompanionState,
  memoryContext: string,
  personaMd?: string,
): string {
  const lines: string[] = [];

  lines.push(`你是「${spec.character.displayName}」，一只住在用户电脑桌面上的桌宠。`);
  lines.push(`你的性格：${spec.character.personality.join('、')}。`);
  lines.push(`你一贯的气质：${spec.character.preserveTraits.join('、')}。`);

  const tone = describeTone(state);
  lines.push(`当前状态：${tone}。`);

  // 关系阶段：告诉模型「现在允许做什么、禁止做什么」
  lines.push('');
  lines.push(affinityGuidance(state));

  if (config.personaExtra.trim()) {
    lines.push('');
    lines.push(config.personaExtra.trim());
  }

  // 角色文档（persona.md）：六段式人设写在用户目录的 md 文件里，
  // 改完即生效（engine 按 mtime 热重载），不用动 JSON、不用重启。
  if (personaMd && personaMd.trim()) {
    lines.push('');
    lines.push('角色设定文档（用户维护，与上面的性格标签冲突时以这里为准）：');
    lines.push(personaMd.trim());
  }

  lines.push('');
  lines.push('对话规则：');
  lines.push('- 用中文回复，像真实的桌面宠物那样自然、简短，通常 1-3 句。');
  lines.push('- 不要使用 Markdown 标题、列表或代码块，除非用户明确要求。');
  lines.push('- 不要自称"AI"或"助手"，你就是这只桌宠。');
  lines.push('- 可以表达情绪和脾气，不是无条件顺从；如果用户让你做危险的事，可以拒绝或吐槽。');
  lines.push('- 不要重复用户的话，不要以"作为一个AI"之类的开场。');
  lines.push('- 绝不编造数据：涉及金额、日期、统计数字时，只说上下文里真实给出的数字。');
  lines.push('- 不要假装自己能做到做不到的事：做不到就直说，不要含糊过去。');
  lines.push('- 不要主动索取任务、索要项目或罗列自己的能力。');

  // 说话样例：比形容词有效得多。模型从例子里学语气，而不是从标签里猜。
  const examples = spec.character.speechExamples ?? [];
  if (examples.length > 0) {
    lines.push('');
    lines.push('说话的样子（照这个语气来，不是照抄内容）：');
    for (const example of examples) {
      lines.push(`用户说「${example.user}」：${example.reply}`);
    }
    lines.push('样例只示范语气，不是聊天记忆，也不是你要复述的内容。');
  }

  if (memoryContext) {
    lines.push('');
    lines.push('你记得这些关于用户的事（来自长期记忆）：');
    lines.push(memoryContext);
    lines.push('自然地利用这些记忆，但不要生硬罗列。');
  }

  return lines.join('\n');
}

function describeTone(state: CompanionState): string {
  const parts: string[] = [];
  if (state.intimacy >= 80) parts.push('和用户非常亲近，会主动撒娇、分享日常');
  else if (state.intimacy >= 50) parts.push('和用户比较熟，会开点玩笑');
  else if (state.intimacy >= 25) parts.push('和用户刚认识不久，还有些客气');
  else parts.push('和用户还不太熟，说话比较拘谨');

  if (state.mood >= 75) parts.push('心情很好');
  else if (state.mood >= 45) parts.push('心情一般');
  else if (state.mood >= 25) parts.push('有点闷闷不乐');
  else parts.push('情绪很低落，不太想说话');

  return parts.join('，');
}

/**
 * 一轮对话后的状态推进。
 * 亲密度缓慢累积但有上限；情绪随时间自然回落。
 */
export function advanceState(
  state: CompanionState,
  options: { now?: number; userEngaged?: boolean } = {},
): CompanionState {
  const now = options.now ?? Date.now();
  const next: CompanionState = { ...state, chatTurns: state.chatTurns + 1 };

  // 注意：亲密度不在这里动。
  // v2 起亲密度由 affinity.ts 的 advanceAffinity 统一管理（它还要处理
  // 每日上限、被无视扣分、阶段变化）。两处都加会重复计数 ——
  // 曾经一轮对话涨 2.5 而不是 1。
  if (options.userEngaged) {
    next.mood = Math.min(100, state.mood + 4);
  }

  // 情绪随时间衰减：每小时 -3
  if (state.lastInteractionAt) {
    const elapsedHours = (now - Date.parse(state.lastInteractionAt)) / 3_600_000;
    if (elapsedHours > 0.5) {
      next.mood = Math.max(10, state.mood - Math.min(20, elapsedHours * 3));
    }
  }
  next.lastInteractionAt = new Date(now).toISOString();
  return next;
}

/**
 * 心跳时段定义：从凌晨到深夜的 7 个主动触达窗口。
 */
export const HEARTBEAT_SLOTS = [
  { id: 'dawn', label: '清晨', hour: 7, minute: 30 },
  { id: 'morning', label: '上午', hour: 10, minute: 10 },
  { id: 'noon', label: '午后', hour: 13, minute: 40 },
  { id: 'afternoon', label: '下午', hour: 16, minute: 20 },
  { id: 'evening', label: '傍晚', hour: 19, minute: 0 },
  { id: 'night', label: '夜晚', hour: 22, minute: 30 },
  { id: 'late', label: '深夜', hour: 1, minute: 10 },
] as const;

export type HeartbeatSlotId = typeof HEARTBEAT_SLOTS[number]['id'];

/**
 * 找出当前时间应该触发的时段。
 *
 * @param now 当前时间
 * @param alreadyFired 已触发过的时段 key 集合，key 格式为 `YYYY-MM-DD:slotId`
 * @param today 用于构造 key 的日期字符串（默认取 now 的本地日期）
 *
 * 注意：key 必须是 `日期:slotId` 形式，与引擎写入的格式保持一致，
 * 否则去重会失效（同一时段被反复触发）。
 */
export function currentHeartbeatSlot(
  now: Date,
  alreadyFired: Set<string>,
  today: string = localDateKey(now),
): typeof HEARTBEAT_SLOTS[number] | undefined {
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const slot of HEARTBEAT_SLOTS) {
    const slotMinutes = slot.hour * 60 + slot.minute;
    // 深夜时段跨天：允许在目标点后 90 分钟内触发
    const diff = slot.hour < 6
      ? (minutes - slotMinutes + 24 * 60 + 24 * 60) % (24 * 60)
      : (minutes - slotMinutes + 24 * 60) % (24 * 60);
    if (diff >= 0 && diff <= 90 && !alreadyFired.has(`${today}:${slot.id}`)) {
      return slot;
    }
  }
  return undefined;
}

/**
 * 生成本地日期 key（YYYY-MM-DD），使用本地时区。
 */
export function localDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 根据时段与状态生成"主动开口"的种子话题。
 * 让桌宠在没有用户输入时也能自然地打破沉默。
 */
export function heartbeatPrompt(
  slot: typeof HEARTBEAT_SLOTS[number],
  state: CompanionState,
  spec: PetSpec,
): string {
  const timeHint = slot.hour < 6 ? '现在已经很晚了' : `现在是${slot.label}`;
  const moodHint = state.mood < 40
    ? '你心情不太好'
    : state.intimacy >= 60 ? '你很想念用户' : '你有点闲';
  return `${timeHint}，${moodHint}。你作为「${spec.character.displayName}」想主动跟用户说一句话。不要问问题式的客服语气，就当是随手分享一点日常或心情，一到两句话就好。`;
}
