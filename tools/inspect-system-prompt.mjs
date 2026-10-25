/**
 * 打印编译后的系统提示词，用于人工检查人设注入是否正确。
 *
 * 用法：
 *   npx tsx tools/inspect-system-prompt.mjs [亲密度]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSystemPrompt, DEFAULT_COMPANION_STATE } from '../src/main/companion/persona.ts';

const root = process.cwd();
const spec = JSON.parse(await readFile(path.join(root, 'pet-spec.json'), 'utf8'));
const intimacy = Number(process.argv[2] ?? 55);

const config = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  apiKey: '',
  reasoningEffort: 'low',
  temperature: 0.85,
  maxTokens: 640,
  timeoutMs: 45000,
  personaExtra: '',
  memoryEnabled: true,
  memoryRecentTurns: 12,
  memoryArchiveTurns: 120,
  memoryConsolidateEvery: 12,
  heartbeatEnabled: true,
  idleHeartbeatMs: 1800000,
};

const state = { ...DEFAULT_COMPANION_STATE, intimacy };

console.log(`===== 亲密度 ${intimacy} =====`);
console.log(buildSystemPrompt(spec, config, state, '- [用户] 在准备 2027 考研'));
console.log('\n===== 字符数 =====');
console.log(buildSystemPrompt(spec, config, state, '').length);
