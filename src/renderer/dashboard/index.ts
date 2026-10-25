import spec from '../../../pet-spec.json';
import type { PetSpec, PetStats, Settings, InteractionSpec, CompanionState } from '../../shared/contracts';
import './index.css';

const petSpec = spec as PetSpec;
document.title = `${petSpec.character.displayName}的小屋`;

// 加载角色立绘（小屋顶部头像 + 聊天面板头像共用）
// 用 require.context 递归收集，避免硬编码具体路径
const petAssetContext = require.context('../../assets/pet', true, /\.png$/i);
const petAssetMap = new Map<string, string>();
for (const key of petAssetContext.keys()) {
  petAssetMap.set(key.replace(/^\.\//, ''), petAssetContext(key));
}
const coreAssetUrl = petAssetMap.get(petSpec.character.coreAsset);

// 设置主题色
const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);

// 设置宠物信息
document.getElementById('pet-name')!.textContent = petSpec.character.displayName;
document.getElementById('pet-personality')!.textContent = petSpec.character.personality.join('、');

// 头像使用真实立绘；取不到时回退到首字母
if (coreAssetUrl) {
  for (const id of ['pet-avatar', 'chat-avatar']) {
    const img = document.getElementById(id) as HTMLImageElement | null;
    if (img) img.src = coreAssetUrl;
  }
} else {
  const fallback = document.createElement('span');
  fallback.textContent = petSpec.character.displayName.slice(0, 1);
  fallback.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:26px;';
  const avatar = document.querySelector('.pet-avatar');
  if (avatar) avatar.replaceChildren(fallback);
}

const closeBtn = document.getElementById('close-btn') as HTMLButtonElement;
const moodEl = document.getElementById('mood') as HTMLDivElement;
const todayInteractionsEl = document.getElementById('today-interactions') as HTMLDivElement;
const companionMinutesEl = document.getElementById('companion-minutes') as HTMLDivElement;
const interactionsList = document.getElementById('interactions-list') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const toggleFocusMode = document.getElementById('toggle-focus-mode') as HTMLDivElement;
const sizeSelector = document.getElementById('size-selector') as HTMLDivElement;
const currentSizeEl = document.getElementById('current-size') as HTMLSpanElement;

let currentSettings: Settings | null = null;
let focusModeActive = false;
let savedScaleBeforeFocus: number | null = null;
let savedClickThroughBeforeFocus: boolean | null = null;

const BASE_WINDOW_PX = (spec as PetSpec).experience.petSizing.baseWindowPx;

function updateSizeDisplay(scale: number): void {
  if (!currentSizeEl) return;
  const px = Math.round(BASE_WINDOW_PX * scale);
  currentSizeEl.textContent = `${px}×${px}px`;
}

// 加载互动列表
async function loadInteractions(): Promise<void> {
  try {
    const interactions = await window.petAPI?.interactions.list();
    if (!interactions) return;

    interactionsList.replaceChildren();
    for (const interaction of interactions) {
      const btn = document.createElement('button');
      btn.className = 'interaction-btn';
      const emoji = document.createElement('span');
      emoji.textContent = interaction.emoji;
      const label = document.createElement('span');
      label.textContent = interaction.label;
      btn.append(emoji, label);
      btn.addEventListener('click', async () => {
        try {
          await window.petAPI?.interactions.trigger(interaction.id);
        } catch (error) {
          console.error('Failed to trigger interaction:', error);
        }
      });
      interactionsList.appendChild(btn);
    }
  } catch (error) {
    console.error('Failed to load interactions:', error);
  }
}

// 加载设置
async function loadSettings(): Promise<void> {
  try {
    const settings = await window.petAPI?.settings.get();
    if (!settings) return;
    currentSettings = settings;

    // 更新开关状态
    if (settings.alwaysOnTop) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }

    if (settings.clickThrough) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }

    // 推断专注模式状态：clickThrough 开启且尺寸为最小档
    focusModeActive = settings.clickThrough && Math.abs(settings.petScale - 0.65) < 0.01;
    if (focusModeActive) {
      toggleFocusMode.classList.add('active');
    } else {
      toggleFocusMode.classList.remove('active');
    }

    // 更新大小选择
    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => {
      const scale = parseFloat((btn as HTMLElement).dataset.scale || '1');
      if (Math.abs(scale - settings.petScale) < 0.01) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    updateSizeDisplay(settings.petScale);
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// 加载统计数据
async function loadStats(): Promise<void> {
  try {
    const stats = await window.petAPI?.interactions.stats();
    if (!stats) return;
    updateStats(stats);
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

function updateStats(stats: PetStats): void {
  // 「关系」卡由 updateCompanionState 填（关系亲密度），
  // 这里不要碰它 —— stats.affection 是累计互动值，语义不同，
  // 两处都写会让数字在两个值之间跳。
  moodEl.textContent = String(stats.mood);
  todayInteractionsEl.textContent = String(stats.todayInteractions);
  const unit = document.createElement('small');
  unit.textContent = '分钟';
  companionMinutesEl.replaceChildren(String(stats.companionMinutes), unit);
}

// 关闭按钮
closeBtn.addEventListener('click', async () => {
  await window.petAPI?.window.hideDashboard();
});

// 置顶开关
toggleAlwaysOnTop.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.alwaysOnTop;
  try {
    await window.petAPI?.settings.update({ alwaysOnTop: newVal });
    currentSettings.alwaysOnTop = newVal;
    if (newVal) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 鼠标穿透开关
toggleClickThrough.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.clickThrough;
  try {
    await window.petAPI?.settings.update({ clickThrough: newVal });
    currentSettings.clickThrough = newVal;
    if (newVal) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }
    // 手动关闭穿透时退出专注模式
    if (!newVal && focusModeActive) {
      focusModeActive = false;
      toggleFocusMode.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 专注模式开关：一键缩小到最小档 + 鼠标穿透，退出时恢复
toggleFocusMode.addEventListener('click', async () => {
  if (!currentSettings) return;
  try {
    if (!focusModeActive) {
      // 进入专注模式：保存当前设置，然后缩小 + 穿透
      savedScaleBeforeFocus = currentSettings.petScale;
      savedClickThroughBeforeFocus = currentSettings.clickThrough;
      await window.petAPI?.settings.update({ petScale: 0.65, clickThrough: true });
      currentSettings.petScale = 0.65;
      currentSettings.clickThrough = true;
      focusModeActive = true;
      toggleFocusMode.classList.add('active');
      toggleClickThrough.classList.add('active');
      updateSizeDisplay(0.65);
      // 更新大小选择器高亮
      const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
      sizeBtns.forEach((btn) => {
        const scale = parseFloat((btn as HTMLElement).dataset.scale || '1');
        if (Math.abs(scale - 0.65) < 0.01) btn.classList.add('active');
        else btn.classList.remove('active');
      });
    } else {
      // 退出专注模式：恢复之前的设置
      const restoreScale = savedScaleBeforeFocus ?? 0.8;
      const restoreClick = savedClickThroughBeforeFocus ?? false;
      await window.petAPI?.settings.update({ petScale: restoreScale, clickThrough: restoreClick });
      currentSettings.petScale = restoreScale;
      currentSettings.clickThrough = restoreClick;
      focusModeActive = false;
      savedScaleBeforeFocus = null;
      savedClickThroughBeforeFocus = null;
      toggleFocusMode.classList.remove('active');
      if (restoreClick) toggleClickThrough.classList.add('active');
      else toggleClickThrough.classList.remove('active');
      updateSizeDisplay(restoreScale);
      // 更新大小选择器高亮
      const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
      sizeBtns.forEach((btn) => {
        const scale = parseFloat((btn as HTMLElement).dataset.scale || '1');
        if (Math.abs(scale - restoreScale) < 0.01) btn.classList.add('active');
        else btn.classList.remove('active');
      });
    }
  } catch (error) {
    console.error('Failed to toggle focus mode:', error);
  }
});

// 大小选择
sizeSelector.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('size-btn')) return;
  if (!currentSettings) return;

  const scale = parseFloat(target.dataset.scale || '1');
  try {
    await window.petAPI?.settings.update({ petScale: scale });
    currentSettings.petScale = scale;
    updateSizeDisplay(scale);

    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => btn.classList.remove('active'));
    target.classList.add('active');
  } catch (error) {
    console.error('Failed to update pet scale:', error);
  }
});

// 监听统计数据更新
window.petAPI?.events.onStats((stats: PetStats) => {
  updateStats(stats);
});

// ---------- 伴侣：聊天 / 记忆 / 配置 ----------

const chatLog = document.getElementById('chat-log') as HTMLDivElement;
const chatEmpty = document.getElementById('chat-empty') as HTMLDivElement;
const chatText = document.getElementById('chat-text') as HTMLTextAreaElement;
const chatSendBtn = document.getElementById('chat-send') as HTMLButtonElement;
const chatHeadName = document.getElementById('chat-head-name') as HTMLDivElement;
const chatAvatar = document.getElementById('chat-avatar') as HTMLImageElement;
const companionDot = document.getElementById('companion-dot') as HTMLSpanElement;
const companionStatusText = document.getElementById('companion-status-text') as HTMLSpanElement;
const intimacyEl = document.getElementById('companion-intimacy') as HTMLDivElement;
const companionMoodEl = document.getElementById('companion-mood') as HTMLDivElement;
const turnsEl = document.getElementById('companion-turns') as HTMLDivElement;
// 三轴关系条与阶段称号
const tierEl = document.getElementById('companion-tier') as HTMLDivElement;
const relationNoteEl = document.getElementById('relation-note') as HTMLDivElement;
const barIntimacy = document.getElementById('bar-intimacy') as HTMLDivElement;
const barEnergy = document.getElementById('bar-energy') as HTMLDivElement;
const barTrust = document.getElementById('bar-trust') as HTMLDivElement;
const numIntimacy = document.getElementById('num-intimacy') as HTMLDivElement;
const numEnergy = document.getElementById('num-energy') as HTMLDivElement;
const numTrust = document.getElementById('num-trust') as HTMLDivElement;
const factList = document.getElementById('fact-list') as HTMLDivElement;
const keyGate = document.getElementById('key-gate') as HTMLDivElement;
const keyGateFill = document.getElementById('key-gate-fill') as HTMLButtonElement;
const keyGateEnv = document.getElementById('key-gate-env') as HTMLButtonElement;
const keyGateHint = document.getElementById('key-gate-hint') as HTMLDivElement;
const configGroup = document.getElementById('config-group') as HTMLDivElement;
const configToggle = document.getElementById('config-toggle') as HTMLDivElement;
const configArrow = document.getElementById('config-arrow') as HTMLSpanElement;
const configBody = document.getElementById('config-body') as HTMLDivElement;
const cfgBaseUrl = document.getElementById('cfg-base-url') as HTMLInputElement;
const cfgModel = document.getElementById('cfg-model') as HTMLInputElement;
const cfgApiKey = document.getElementById('cfg-api-key') as HTMLInputElement;
const cfgApiKeyState = document.getElementById('cfg-api-key-state') as HTMLSpanElement;
const cfgEffort = document.getElementById('cfg-effort') as HTMLSelectElement;
const cfgPersona = document.getElementById('cfg-persona') as HTMLInputElement;
const cfgSave = document.getElementById('cfg-save') as HTMLButtonElement;
const cfgSaveHint = document.getElementById('cfg-save-hint') as HTMLSpanElement;

let chatBusy = false;

/** 追加一条聊天气泡 */
function appendChatBubble(role: 'user' | 'assistant', content: string, at?: string): void {
  // 有第一条消息时隐藏空状态引导
  chatEmpty.hidden = true;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = content;
  if (at) {
    const meta = document.createElement('span');
    meta.className = 'chat-meta';
    meta.textContent = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    bubble.append(meta);
  }
  chatLog.append(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/** 展开或收起配置区 */
function setConfigCollapsed(collapsed: boolean): void {
  configBody.classList.toggle('collapsed', collapsed);
  configArrow.classList.toggle('collapsed', collapsed);
}

configToggle.addEventListener('click', () => {
  setConfigCollapsed(!configBody.classList.contains('collapsed'));
});

/** 展开配置区并把焦点放进 API Key 输入框 */
function focusConfig(): void {
  setConfigCollapsed(false);
  configGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => cfgApiKey.focus(), 320);
}

keyGateFill.addEventListener('click', () => {
  focusConfig();
});

keyGateEnv.addEventListener('click', () => {
  keyGateHint.hidden = false;
  keyGateHint.innerHTML =
    '在 PowerShell 里执行下面这行（换成你的 Key），然后重启桌宠：'
    + '<br><code>setx DEEPSEEK_API_KEY "sk-你的key"</code>'
    + '<br>环境变量方式的 Key 完全不落盘，比填在下面的输入框更安全。';
});

/** 快捷短语：点击直接填入输入框 */
for (const button of Array.from(document.querySelectorAll('.chat-suggestion'))) {
  button.addEventListener('click', () => {
    const text = (button as HTMLElement).dataset.text ?? '';
    chatText.value = text;
    chatText.focus();
  });
}

function updateCompanionState(state: CompanionState): void {
  intimacyEl.textContent = String(Math.round(state.intimacy));
  companionMoodEl.textContent = String(Math.round(state.mood));
  turnsEl.textContent = String(state.chatTurns);

  // 「关系」卡显示的是关系亲密度，不是互动统计里的 affection ——
  // 后者是累计互动次数（上限 300），两个都叫好感度会让人 confusion。
  const relationEl = document.getElementById('affection');
  if (relationEl) relationEl.textContent = String(Math.round(state.intimacy));

  // 三轴关系条
  const intimacy = Math.round(state.intimacy);
  const energy = Math.round(state.energy ?? 60);
  const trust = Math.round(state.trust ?? 20);
  barIntimacy.style.width = `${Math.min(100, intimacy)}%`;
  barEnergy.style.width = `${Math.min(100, energy)}%`;
  barTrust.style.width = `${Math.min(100, trust)}%`;
  numIntimacy.textContent = String(intimacy);
  numEnergy.textContent = String(energy);
  numTrust.textContent = String(trust);

  // 关系阶段称号 + 一句说明，让用户知道关系往哪走
  tierEl.textContent = state.tierTitle ?? '初识';
  relationNoteEl.textContent = relationHint(intimacy);
}

/**
 * 按亲密度给出关系阶段说明。
 * 与主进程 affinity.ts 的 TIERS 阶梯保持一致的文案口径。
 */
function relationHint(intimacy: number): string {
  if (intimacy >= 90) return '已经是挚友了 —— 她敢吐槽你，也敢直接指出你的问题。';
  if (intimacy >= 70) return '有默契了 —— 你低落的时候，她会先开口安慰你。';
  if (intimacy >= 50) return '很依赖你 —— 她会主动提起以前记住的事。';
  if (intimacy >= 30) return '亲近了 —— 她会主动关心你有没有熬夜、有没有久坐。';
  if (intimacy >= 15) return '熟悉了 —— 她偶尔会主动跟你打个招呼。';
  return '关系会随着相处慢慢长起来。';
}

async function loadCompanionStatus(): Promise<void> {
  const api = window.petAPI?.companion;
  if (!api) {
    companionDot.className = 'status-dot warn';
    companionStatusText.textContent = '当前构建未启用伴侣能力';
    keyGate.hidden = false;
    return;
  }
  try {
    const status = await api.status();
    if (status.configured) {
      companionDot.className = 'status-dot ok';
      companionStatusText.textContent = `已连接 · ${status.model}`;
      // 已配置则隐藏引导卡片
      keyGate.hidden = true;
      setConfigCollapsed(true);
    } else {
      companionDot.className = 'status-dot warn';
      companionStatusText.textContent = '未配置 API Key · 本地兜底模式';
      // 未配置：显示引导卡片，并把配置区展开放在聊天区旁边
      keyGate.hidden = false;
      setConfigCollapsed(false);
    }
    const state = await api.state();
    updateCompanionState(state);
  } catch (error) {
    console.error('Failed to read companion status:', error);
    companionDot.className = 'status-dot warn';
    companionStatusText.textContent = '伴侣状态读取失败';
  }
}

async function loadChatHistory(): Promise<void> {
  const api = window.petAPI?.companion;
  if (!api) return;
  try {
    const history = await api.history(40);
    // 只清掉气泡，保留空状态引导节点
    for (const child of Array.from(chatLog.children)) {
      if (child !== chatEmpty) child.remove();
    }
    chatEmpty.hidden = history.length > 0;
    // history 是倒序的，反转成正序显示
    for (const item of [...history].reverse()) {
      appendChatBubble(item.role, item.content, item.at);
    }
  } catch (error) {
    console.error('Failed to load chat history:', error);
  }
}

async function loadFacts(): Promise<void> {
  const api = window.petAPI?.companion;
  if (!api) return;
  try {
    const facts = await api.facts();
    factList.replaceChildren();
    if (!facts.length) {
      const empty = document.createElement('div');
      empty.className = 'hint-text';
      empty.textContent = '还没有记住任何事，聊几句就会自动记录。';
      factList.append(empty);
      return;
    }
    for (const fact of facts) {
      const item = document.createElement('div');
      item.className = 'fact-item';
      const content = document.createElement('span');
      content.textContent = `[${fact.subject}] ${fact.content}`;
      const weight = document.createElement('span');
      weight.className = 'fact-weight';
      weight.textContent = `★${fact.weight} ×${fact.mentions}`;
      const remove = document.createElement('button');
      remove.className = 'fact-delete';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '删除这条记忆';
      remove.addEventListener('click', async () => {
        try {
          await api.forget(fact.id);
          await loadFacts();
        } catch (error) {
          console.error('Failed to forget fact:', error);
        }
      });
      item.append(content, weight, remove);
      factList.append(item);
    }
  } catch (error) {
    console.error('Failed to load facts:', error);
  }
}

async function loadCompanionConfig(): Promise<void> {
  const api = window.petAPI?.companion;
  if (!api) return;
  try {
    const config = await api.getConfig();
    cfgBaseUrl.value = config.baseUrl;
    cfgModel.value = config.model;
    cfgEffort.value = config.reasoningEffort;
    cfgPersona.value = config.personaExtra;
    cfgApiKey.value = '';
    cfgApiKeyState.textContent = config.apiKeySet ? '（已设置，留空不改）' : '（未设置）';
  } catch (error) {
    console.error('Failed to load companion config:', error);
  }
}

async function submitCompanionChat(): Promise<void> {
  const api = window.petAPI?.companion;
  if (!api) return;
  const text = chatText.value.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  chatSendBtn.disabled = true;
  chatText.value = '';
  appendChatBubble('user', text);
  const pending = document.createElement('div');
  pending.className = 'chat-bubble assistant';
  pending.textContent = '…';
  chatLog.append(pending);
  chatLog.scrollTop = chatLog.scrollHeight;
  try {
    const reply = await api.send(text);
    pending.textContent = reply.content;
    if (reply.degraded && reply.error) {
      pending.title = `降级模式：${reply.error}`;
    }
    updateCompanionState(reply.state);
    await loadFacts();
  } catch (error) {
    console.error('Failed to send companion message:', error);
    pending.textContent = '发送失败，请检查 API 配置。';
  } finally {
    chatBusy = false;
    chatSendBtn.disabled = false;
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

chatSendBtn.addEventListener('click', () => {
  void submitCompanionChat();
});

chatText.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submitCompanionChat();
  }
});

/** 输入框随内容增高（最多 96px） */
chatText.addEventListener('input', () => {
  chatText.style.height = 'auto';
  chatText.style.height = `${Math.min(96, chatText.scrollHeight)}px`;
});

/** 失焦时恢复单行高度 */
chatText.addEventListener('blur', () => {
  if (!chatText.value) chatText.style.height = '';
});

cfgSave.addEventListener('click', async () => {
  const api = window.petAPI?.companion;
  if (!api) return;
  cfgSave.disabled = true;
  cfgSaveHint.textContent = '保存中…';
  try {
    const patch: Record<string, unknown> = {
      baseUrl: cfgBaseUrl.value.trim(),
      model: cfgModel.value.trim(),
      reasoningEffort: cfgEffort.value,
      personaExtra: cfgPersona.value.trim(),
    };
    if (cfgApiKey.value.trim()) patch.apiKey = cfgApiKey.value.trim();
    await api.updateConfig(patch);
    cfgApiKey.value = '';
    cfgSaveHint.textContent = '已保存';
    await loadCompanionStatus();
    await loadCompanionConfig();
    // 配好 Key 后给个明确反馈，并收起配置区
    const configured = await api.status();
    if (configured.configured) {
      keyGate.hidden = true;
      setConfigCollapsed(true);
      cfgSaveHint.textContent = '已保存 · 已连接';
    } else {
      cfgSaveHint.textContent = '已保存，但仍未检测到 Key';
    }
  } catch (error) {
    console.error('Failed to save companion config:', error);
    cfgSaveHint.textContent = '保存失败';
  } finally {
    cfgSave.disabled = false;
    setTimeout(() => { cfgSaveHint.textContent = ''; }, 3000);
  }
});

// 心跳主动触达时，在聊天记录里也留一条
window.petAPI?.companion?.onEvent((event) => {
  if (event.kind === 'heartbeat' && event.reply) {
    appendChatBubble('assistant', event.reply.content, new Date().toISOString());
    if (event.state) updateCompanionState(event.state);
  }
});

/**
 * 响应主进程的「聚焦聊天区」信号。
 * 从桌宠右键菜单 / 托盘菜单点击「和小小闫聊天」进入时，
 * 需要把滚动位置挪到聊天区并聚焦输入框，否则用户打开小屋还要自己找。
 *
 * 注意：渲染层是 sandbox 模式，不能直接引入 electron 模块，
 * 必须通过 preload 暴露的 petAPI 订阅。
 */
window.petAPI?.events.onFocusChat(() => {
  const chatSection = document.querySelector('#chat-log')?.closest('.settings-group') as HTMLElement | null;
  chatSection?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => chatText.focus(), 320);
});

// 初始化
async function init(): Promise<void> {
  await loadInteractions();
  await loadSettings();
  await loadStats();
  await loadCompanionStatus();
  await loadCompanionConfig();
  await loadChatHistory();
  await loadFacts();
}

init();
