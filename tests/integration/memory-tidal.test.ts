import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../../src/main/companion/memory';
import { budgetProfile } from '../../src/main/companion/budget';
import { pickBridgeModel } from '../../src/main/companion/bridge';

/**
 * 潮汐记忆机制回归测试（借鉴自 AstrBot「潮汐记忆」插件的分层思路）：
 *   第四层：归档全量兜底 —— 关键词命中时翻出旧对话片段
 *   第三层：事实 30 天 TTL —— 没被提起就下架，重新提起可复活，被召回即续期
 *   模型选择：桥接列表里有 Trae 通道时优先 Trae（积分计费），否则回落官方源
 */

function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test('归档检索：关键词命中时翻出旧对话片段（之前归档只写不读）', async () => {
  const dir = await tempDir('pet-tidal-archive-');
  const memory = new MemoryManager(dir, { recentLimit: 2, archiveLimit: 50 });
  await memory.appendTurn('user', '我们养了一只叫咪咪的橘猫');
  await memory.appendTurn('assistant', '咪咪很可爱呀');
  // 挤出 recentLimit，让咪咪对话沉入归档
  await memory.appendTurn('user', '今天天气不错');
  await memory.appendTurn('assistant', '是呀');
  await memory.appendTurn('user', '再见');

  const injection = await memory.buildInjection('还记得咪咪吗');
  assert.ok(injection.context.includes('旧对话'), '应出现旧对话摘录段');
  assert.ok(injection.context.includes('咪咪'), '摘录里应含命中内容');
  // 两条咪咪对话（用户说的 + 桌宠回的）都应被翻出
  assert.equal(injection.recalledArchive, 2);

  // 无关话题不应翻旧账（不能用含「今天」的问句——归档里有「今天天气不错」，会正常命中）
  const unrelated = await memory.buildInjection('股票行情怎么样');
  assert.equal(unrelated.recalledArchive ?? 0, 0);
});

test('事实 TTL：30 天没被提起且权重不足的事实下架到 retired', async () => {
  const dir = await tempDir('pet-tidal-ttl-');
  const stale = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
  const facts = [
    { id: 'stale1', subject: '用户', content: '在准备考研', keywords: ['考研'], createdAt: stale, updatedAt: stale, mentions: 1, weight: 2 },
    { id: 'core1', subject: '用户', content: '不喜欢香菜', keywords: ['香菜'], createdAt: stale, updatedAt: stale, mentions: 9, weight: 4 },
  ];
  await writeFile(
    path.join(dir, 'companion-memory.json'),
    JSON.stringify({ facts, recent: [], archive: [], totalTurns: 0, lastDecayAt: '2020-01-01' }),
    'utf8',
  );
  const memory = new MemoryManager(dir);
  const store = await memory.load();
  // 低权重 + 超期 → 下架；核心事实（权重>=3）永不衰减
  assert.equal(store.facts.filter((fact) => fact.content === '在准备考研').length, 0, '陈年低权重事实应下架');
  assert.equal(store.facts.filter((fact) => fact.content === '不喜欢香菜').length, 1, '核心事实不应衰减');
  assert.equal((store.retired ?? []).length, 1);
});

test('事实复活：下架的事实被重新提起会回到活跃区并续期', async () => {
  const dir = await tempDir('pet-tidal-revive-');
  const stale = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
  const facts = [
    { id: 'stale1', subject: '用户', content: '在准备考研', keywords: ['考研'], createdAt: stale, updatedAt: stale, mentions: 1, weight: 2 },
  ];
  await writeFile(
    path.join(dir, 'companion-memory.json'),
    JSON.stringify({ facts, recent: [], archive: [], totalTurns: 0, lastDecayAt: '2020-01-01' }),
    'utf8',
  );
  const memory = new MemoryManager(dir);
  await memory.load();
  await memory.rememberFact({ subject: '用户', content: '在准备考研' });
  const store = await memory.snapshot();
  assert.equal(store.facts.filter((fact) => fact.content === '在准备考研').length, 1, '应复活回活跃区');
  assert.equal((store.retired ?? []).length, 0, 'retired 应清空');
  const revived = store.facts.find((fact) => fact.content === '在准备考研');
  assert.ok(revived && Date.parse(revived.updatedAt) > Date.now() - 60_000, '复活应续期 updatedAt');
});

test('召回续期：用户话题召回刷新 updatedAt，心跳（renew:false）不刷新', async () => {
  const dir = await tempDir('pet-tidal-renew-');
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
  const facts = [
    { id: 'fact1', subject: '用户', content: '在准备考研', keywords: ['考研'], createdAt: tenDaysAgo, updatedAt: tenDaysAgo, mentions: 1, weight: 2 },
    { id: 'fact2', subject: '用户', content: '想学会计', keywords: ['会计'], createdAt: tenDaysAgo, updatedAt: tenDaysAgo, mentions: 1, weight: 2 },
  ];
  await writeFile(
    path.join(dir, 'companion-memory.json'),
    JSON.stringify({ facts, recent: [], archive: [], totalTurns: 0, lastDecayAt: '2020-01-01' }),
    'utf8',
  );
  const memory = new MemoryManager(dir);
  await memory.load();

  // 用户话题召回 → 续期
  await memory.buildInjection('考研准备得怎么样了');
  const renewed = (await memory.snapshot()).facts.find((fact) => fact.content === '在准备考研');
  assert.ok(renewed && Date.parse(renewed.updatedAt) > Date.now() - 60_000, '被召回的事实应续期');

  // renew:false（心跳种子）→ 原样不动
  await memory.buildInjection('最近想学会计的事', { renew: false });
  const untouched = (await memory.snapshot()).facts.find((fact) => fact.content === '想学会计');
  assert.equal(untouched?.updatedAt, tenDaysAgo, '心跳话题不应续期');
});

test('每日摘要支撑：turnsOfDate 按本地日期取轮次，markDailySummary 幂等', async () => {
  const dir = await tempDir('pet-tidal-daily-');
  const memory = new MemoryManager(dir, { recentLimit: 50, archiveLimit: 50 });
  await memory.appendTurn('user', '早上好');
  await memory.appendTurn('assistant', '早呀');
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.equal((await memory.turnsOfDate(key)).length, 2);
  assert.equal((await memory.turnsOfDate('2020-01-01')).length, 0);
  await memory.markDailySummary(key);
  await memory.markDailySummary(key);
  assert.equal((await memory.snapshot()).lastDailySummaryFor, key);
});

test('桥接模型选择：Trae 通道优先且 Pro 智力档先于 Flash（用户反馈 Flash 降智）', () => {
  assert.equal(
    pickBridgeModel(['deepseek-official/deepseek-flash', 'trae/deepseek-v4.1-flash', 'trae/DeepSeek-V4-Pro-Official']),
    'trae/DeepSeek-V4-Pro-Official',
    'Trae 通道内 Pro 应优先于 Flash',
  );
  assert.equal(
    pickBridgeModel(['trae-vision/DeepSeek-V4-Pro-Official', 'trae/DeepSeek-V4-Pro-Official']),
    'trae/DeepSeek-V4-Pro-Official',
    '精确 trae/ 通道应优先于 trae-vision 变体',
  );
  assert.equal(
    pickBridgeModel(['deepseek-official/deepseek-flash', 'trae/deepseek-v4.1-flash']),
    'trae/deepseek-v4.1-flash',
    'Trae 通道没有 Pro 时才回落 Flash',
  );
  assert.equal(
    pickBridgeModel(['deepseek-official/deepseek-flash', 'deepseek-account/deepseek-v4-pro']),
    'deepseek-account/deepseek-v4-pro',
    '没有 Trae 时同样 Pro 优先于 Flash',
  );
});

test('预算分档：闲聊/正事带 casual 标记（决定是否省略思考强度）', () => {
  assert.equal(budgetProfile('今天好累').casual, true);
  assert.equal(budgetProfile('帮我修复这个项目的输入框').casual, false);
});
