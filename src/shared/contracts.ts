export interface PetSpec {
  schemaVersion: number;
  app: {
    name: string;
    appId: string;
    version: string;
    language: string;
  };
  targets: {
    windows: { enabled: boolean; arch: string };
    macos: { enabled: boolean; arch: string };
  };
  character: {
    inputType: string;
    coreAsset: string;
    displayName: string;
    archetype: string;
    personality: string[];
    preserveTraits: string[];
    style: string;
    mirrorSafe: boolean;
    /**
     * 说话样例。
     * 光给「温婉、大方」这类形容词，模型学不像；给几条真实的
     * 「用户说 X → 我回 Y」才管用。样例只示范语气，不是聊天记忆。
     */
    speechExamples?: Array<{ user: string; reply: string }>;
  };
  companion?: CompanionSpec;
  assetPipeline: {
    backgroundMode: string;
    segmentationBackend: string;
    subjectKind: string;
    generationBackground: string;
    backgroundTolerance: number;
    edgeFeather: number;
    safeMargin: number;
    targetOccupancy: number;
  };
  experience: {
    theme: {
      primary: string;
      accent: string;
      background: string;
      surface: string;
      text: string;
      muted: string;
      cornerRadius: number;
    };
    petSizing: {
      baseWindowPx: number;
      defaultScale: number;
    };
    interactions: InteractionSpec[];
  };
  motion: {
    breathing: { enabled: boolean; periodMs: number; scaleX: number; scaleY: number };
    squashStretch: { enabled: boolean; durationMs: number; intensity: number };
    idleIntervalMs: { min: number; max: number };
  };
  features: {
    transparentWindow: boolean;
    drag: boolean;
    tray: boolean;
    edgeSnap: boolean;
    reminders: boolean;
    interactions: boolean;
    relationship: boolean;
    filePocket: boolean;
    dashboard: boolean;
    typingReaction: boolean;
    autonomousMovement: boolean;
    companionChat?: boolean;
    companionMemory?: boolean;
    companionHeartbeat?: boolean;
  };
  states: PetState[];
  storage: {
    userData: string;
    filePocket: string;
  };
  build: {
    windows: { arch: string; installer: string; portable: string };
    macos: { arch: string; diskImage: string; portable: string };
    timeoutMinutes: number;
    unsigned: boolean;
  };
}

export interface InteractionSpec {
  id: string;
  emoji: string;
  label: string;
  stateId: string;
  durationMs: number;
  affectionGain: number;
  feedback: string[];
}

export interface PetState {
  id: string;
  triggers: string[];
  frames: string[];
  frameDurationMs: number;
  loop: boolean;
  priority: number;
  interrupt: string;
  cooldownMs: number;
  direction: string;
  anchor: { x: number; y: number };
  mirrorSafe: boolean;
}

export interface PetStats {
  affection: number;
  mood: number;
  todayInteractions: number;
  companionMinutes: number;
  lastInteractionDate: string;
}

export interface Settings {
  edgeSnap: boolean;
  alwaysOnTop: boolean;
  typingReaction: boolean;
  clickThrough: boolean;
  petScale: number;
}

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  createdAt: string;
}

export interface StateActivity {
  kind: string;
  stateId?: string;
  durationMs?: number;
  feedback?: string;
}

export interface RuntimeReadyReport {
  status: string;
  stateId: string;
  frame: string;
  assetCount: number;
  expectedAssetCount: number;
  naturalWidth: number;
  naturalHeight: number;
  petVisible: boolean;
  ipcReady: boolean;
  renderers?: {
    pet: boolean;
    dashboard: boolean;
    reminder: boolean;
  };
}

export interface RuntimeFailureReport {
  message: string;
}

export interface InteractionResult {
  interaction: InteractionSpec;
  feedback: string;
  stats: PetStats;
}

export interface TypingStatus {
  enabled: boolean;
  reason: string;
}

/** 桌宠伴侣能力的静态配置（来自 pet-spec.json 的 companion 块） */
export interface CompanionSpec {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnvVar: string;
  reasoningEffort: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  personaExtra: string;
  memoryEnabled: boolean;
  memoryRecentTurns: number;
  memoryArchiveTurns: number;
  memoryConsolidateEvery: number;
  memoryMaxFacts: number;
  heartbeatEnabled: boolean;
  heartbeatMinIntervalMs: number;
  idleHeartbeatMs: number;
  /** 桌宠运行期间阻止系统休眠（默认关：多数人不希望挂着桌宠就永不睡眠）。唤醒补报始终开启。 */
  preventSuspension?: boolean;
}

/** 运行时可修改的伴侣配置。API Key 永远不会回传到渲染层。 */
export interface CompanionConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  reasoningEffort: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  personaExtra: string;
  memoryEnabled: boolean;
  memoryRecentTurns: number;
  memoryArchiveTurns: number;
  memoryConsolidateEvery: number;
  heartbeatEnabled: boolean;
  idleHeartbeatMs: number;
}

/** 对话状态（亲密度 / 情绪） */
export interface CompanionState {
  /** 亲密度 0-100 */
  intimacy: number;
  /** 情绪 0-100，越高越开心 */
  mood: number;
  /** 累计聊天轮数 */
  chatTurns: number;
  /** 上次互动时间 */
  lastInteractionAt?: string;
  /** 活力 0-100，决定是否主动开口 */
  energy?: number;
  /** 信任 0-100，决定是否给建议与提醒 */
  trust?: number;
  /** 今日已获得的亲密度涨幅（用于每日上限） */
  intimacyGainedToday?: number;
  /** 上次获得亲密度涨幅的日期（YYYY-MM-DD） */
  lastGainDate?: string;
  /** 当前关系阶段 id */
  tier?: string;
  /** 当前关系阶段称号 */
  tierTitle?: string;
}

/** 一条长期记忆事实 */
export interface CompanionFact {
  id: string;
  subject: string;
  content: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  mentions: number;
  weight: number;
}

/** 一条聊天记录 */
export interface CompanionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

/** 一次回复的结果 */
export interface CompanionReply {
  content: string;
  degraded: boolean;
  recalledCount: number;
  state: CompanionState;
  error?: string;
}

/** 主进程 -> 渲染层的伴侣事件 */
export interface CompanionEvent {
  kind: 'heartbeat' | 'reply' | 'state';
  reply?: CompanionReply;
  state?: CompanionState;
}

export interface CompanionAPI {
  /** 是否已配置好 API（不泄露 Key 本身） */
  status: () => Promise<{ configured: boolean; model: string; baseUrl: string }>;
  /** 读取运行时配置（apiKey 会被抹掉） */
  getConfig: () => Promise<Omit<CompanionConfig, 'apiKey'> & { apiKeySet: boolean }>;
  /** 保存运行时配置 */
  updateConfig: (patch: Partial<CompanionConfig>) => Promise<Omit<CompanionConfig, 'apiKey'> & { apiKeySet: boolean }>;
  /** 发送一句话 */
  send: (text: string) => Promise<CompanionReply>;
  /** 读取聊天历史 */
  history: (limit?: number) => Promise<CompanionMessage[]>;
  /** 读取长期记忆 */
  facts: () => Promise<CompanionFact[]>;
  /** 手动添加一条长期记忆 */
  remember: (input: { subject: string; content: string; weight?: number }) => Promise<CompanionFact>;
  /** 删除一条长期记忆 */
  forget: (id: string) => Promise<boolean>;
  /** 读取状态 */
  state: () => Promise<CompanionState>;
  /** 订阅伴侣事件 */
  onEvent: (listener: (event: CompanionEvent) => void) => () => void;
}

export interface PetAPI {
  settings: {
    get: () => Promise<Settings>;
    update: (patch: Partial<Settings>) => Promise<Settings>;
  };
  reminders: {
    list: () => Promise<Reminder[]>;
    save: (input: { text: string; dueAt: string }) => Promise<Reminder>;
    remove: (id: string) => Promise<boolean>;
  };
  interactions: {
    list: () => Promise<InteractionSpec[]>;
    trigger: (id: string) => Promise<InteractionResult>;
    stats: () => Promise<PetStats>;
  };
  files: {
    getPathForFile: (file: File) => string;
    put: (paths: string[]) => Promise<{ copied: string[]; failed: Array<{ source: string; reason: string }> }>;
    openPocket: () => Promise<void>;
  };
  window: {
    beginDrag: () => Promise<void>;
    updateDrag: () => Promise<void>;
    endDrag: () => Promise<void>;
    showContextMenu: () => Promise<void>;
    showReminder: () => Promise<void>;
    showDashboard: () => Promise<void>;
    hideReminder: () => Promise<void>;
    hideDashboard: () => Promise<void>;
    hidePet: () => Promise<void>;
  };
  runtime: {
    ready: (report: RuntimeReadyReport) => Promise<void>;
    fail: (report: RuntimeFailureReport) => Promise<void>;
  };
  companion?: CompanionAPI;
  events: {
    onStateActivity: (listener: (activity: StateActivity) => void) => () => void;
    onReminder: (listener: (reminder: Reminder) => void) => () => void;
    onReminderCompose: (listener: () => void) => () => void;
    onStats: (listener: (stats: PetStats) => void) => () => void;
    onTypingStatus: (listener: (status: TypingStatus) => void) => () => void;
    onFocusChat: (listener: () => void) => () => void;
  };
}

declare global {
  interface Window {
    petAPI?: PetAPI;
    __petE2E?: {
      snapshot: () => Promise<{
        tray: boolean;
        roles: Array<{ role: 'pet' | 'reminder' | 'dashboard'; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      }>;
      quit: () => Promise<void>;
    };
  }
}

export function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError('Expected string array');
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError('Expected string array');
  }
}

export function assertInteractionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 100) {
    throw new TypeError('Invalid interaction id');
  }
}

export function assertSettingsPatch(value: unknown): asserts value is Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid settings patch');
  }
  const obj = value as Record<string, unknown>;
  const booleanKeys = new Set(['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough']);
  const allowedKeys = new Set([...booleanKeys, 'petScale']);
  for (const [key, item] of Object.entries(obj)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unknown settings field: ${key}`);
    if (booleanKeys.has(key) && typeof item !== 'boolean') throw new TypeError(`Invalid settings field: ${key}`);
    if (key === 'petScale' && (typeof item !== 'number' || !Number.isFinite(item) || ![0.65, 0.8, 1, 1.2].includes(item))) {
      throw new TypeError('Invalid settings field: petScale');
    }
  }
}

export function assertReminderInput(value: unknown): asserts value is { text: string; dueAt: string } {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid reminder input');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string' || obj.text.length > 500) {
    throw new TypeError('Invalid reminder text');
  }
  if (typeof obj.dueAt !== 'string' || isNaN(Date.parse(obj.dueAt))) {
    throw new TypeError('Invalid reminder dueAt');
  }
}

export function assertRuntimeReadyReport(value: unknown): asserts value is RuntimeReadyReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime ready report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.stateId !== 'string') throw new TypeError('Invalid stateId');
  if (typeof obj.frame !== 'string') throw new TypeError('Invalid frame');
  if (typeof obj.assetCount !== 'number') throw new TypeError('Invalid assetCount');
  if (typeof obj.naturalWidth !== 'number') throw new TypeError('Invalid naturalWidth');
  if (typeof obj.naturalHeight !== 'number') throw new TypeError('Invalid naturalHeight');
}

export function assertRuntimeFailureReport(value: unknown): asserts value is RuntimeFailureReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime failure report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.message !== 'string') throw new TypeError('Invalid message');
}

export function assertCompanionText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Empty companion message');
  if (value.length > 2000) throw new TypeError('Companion message too long');
}

export function assertCompanionConfigPatch(value: unknown): asserts value is Partial<CompanionConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid companion config patch');
  }
  const obj = value as Record<string, unknown>;
  const stringKeys = new Set(['provider', 'baseUrl', 'model', 'apiKey', 'reasoningEffort', 'personaExtra']);
  const booleanKeys = new Set(['memoryEnabled', 'heartbeatEnabled']);
  const numberKeys = new Set(['temperature', 'maxTokens', 'timeoutMs', 'memoryRecentTurns', 'memoryArchiveTurns', 'memoryConsolidateEvery', 'idleHeartbeatMs']);
  const allowedKeys = new Set([...stringKeys, ...booleanKeys, ...numberKeys]);
  for (const [key, item] of Object.entries(obj)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unknown companion config field: ${key}`);
    if (stringKeys.has(key) && typeof item !== 'string') throw new TypeError(`Invalid companion config field: ${key}`);
    if (booleanKeys.has(key) && typeof item !== 'boolean') throw new TypeError(`Invalid companion config field: ${key}`);
    if (numberKeys.has(key) && (typeof item !== 'number' || !Number.isFinite(item))) {
      throw new TypeError(`Invalid companion config field: ${key}`);
    }
  }
  if (typeof obj.temperature === 'number' && (obj.temperature < 0 || obj.temperature > 2)) {
    throw new TypeError('Invalid companion config field: temperature');
  }
  if (typeof obj.maxTokens === 'number' && (obj.maxTokens < 1 || obj.maxTokens > 8192)) {
    throw new TypeError('Invalid companion config field: maxTokens');
  }
  if (typeof obj.timeoutMs === 'number' && (obj.timeoutMs < 1000 || obj.timeoutMs > 300_000)) {
    throw new TypeError('Invalid companion config field: timeoutMs');
  }
  if (typeof obj.idleHeartbeatMs === 'number' && (obj.idleHeartbeatMs < 0 || obj.idleHeartbeatMs > 86_400_000)) {
    throw new TypeError('Invalid companion config field: idleHeartbeatMs');
  }
  if (typeof obj.apiKey === 'string' && obj.apiKey.length > 500) {
    throw new TypeError('Invalid companion config field: apiKey');
  }
}

export function assertCompanionFactInput(value: unknown): asserts value is { subject: string; content: string; weight?: number } {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid companion fact input');
  const obj = value as Record<string, unknown>;
  if (typeof obj.subject !== 'string' || obj.subject.length > 60) throw new TypeError('Invalid companion fact subject');
  if (typeof obj.content !== 'string' || !obj.content.trim() || obj.content.length > 500) {
    throw new TypeError('Invalid companion fact content');
  }
  if (obj.weight !== undefined && (typeof obj.weight !== 'number' || obj.weight < 1 || obj.weight > 5)) {
    throw new TypeError('Invalid companion fact weight');
  }
}
