import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CompanionEngine, localHeartbeatFallback, localIdleFallback } from '../../src/main/companion/engine';
import { extractKeywords } from '../../src/main/companion/memory';
import { currentHeartbeatSlot, HEARTBEAT_SLOTS, localDateKey } from '../../src/main/companion/persona';

let spec: any;
before(async () => {
  spec = JSON.parse(await readFile('pet-spec.json', 'utf8'));
});

test('未配置 API 时降级但仍能对话', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, {
    ...spec.companion, apiKey: '',
  });
  const reply = await engine.reply('你好呀');
  assert.ok(reply.content.length > 0, '应该有回复内容');
  assert.equal(reply.degraded, true, '应该是降级模式');
  assert.ok(reply.error, '应该带降级原因');
  console.log('  降级回复:', reply.content);
});

test('降级模式下记忆仍然被写入', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  await engine.reply('我在准备考研');
  const facts = await engine.listFacts();
  assert.ok(Array.isArray(facts));
  const store = JSON.parse(await readFile(path.join(dir, 'companion-memory.json'), 'utf8'));
  assert.equal(store.recent.length, 2, '应该记录了 user + assistant 两轮');
  assert.equal(store.totalTurns, 2);
  console.log('  记忆轮次:', store.totalTurns, '近期条数:', store.recent.length);
});

test('手动记住的事实可以被召回', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  await engine.rememberFact({ subject: '用户', content: '正在准备 2027 年考研', weight: 5 });
  const facts = await engine.listFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.weight, 5);
  // 权重 >= 3 的核心档案应该被自动注入
  const reply = await engine.reply('考研');
  assert.ok(reply.recalledCount >= 1, '高权重事实应该被召回');
  console.log('  召回条数:', reply.recalledCount);
});

test('删除事实生效', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  const fact = await engine.rememberFact({ subject: '用户', content: '临时测试项', weight: 1 });
  const ok = await engine.forgetFact(fact.id);
  assert.equal(ok, true);
  assert.equal((await engine.listFacts()).length, 0);
});

test('亲密度随互动上升', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  const before = await engine.getState();
  for (let i = 0; i < 5; i++) await engine.reply('在干嘛');
  const after = await engine.getState();
  assert.ok(after.intimacy > before.intimacy, '亲密度应该上升');
  assert.equal(after.chatTurns, before.chatTurns + 5);
  console.log(`  亲密度 ${before.intimacy.toFixed(1)} -> ${after.intimacy.toFixed(1)}`);
});

test('中文关键词抽取', () => {
  const kws = extractKeywords('我在准备 2027 考研。每天写代码');
  assert.ok(kws.includes('考研'), '应该抽到 考研');
  assert.ok(kws.includes('2027'), '应该抽到 2027');
  console.log('  关键词:', kws.join(', '));
});

test('心跳时段每天只触发一次', () => {
  const fired = new Set<string>();
  const now = new Date();
  now.setHours(10, 15, 0, 0);
  const today = localDateKey(now);
  const slot = currentHeartbeatSlot(now, fired, today);
  if (slot) {
    // 必须用 日期:slotId 格式，与引擎写入格式一致
    fired.add(`${today}:${slot.id}`);
    const again = currentHeartbeatSlot(now, fired, today);
    assert.equal(again, undefined, '同一时段不应重复触发');
    console.log('  心跳时段:', slot.id, slot.label);
  }
  assert.equal(HEARTBEAT_SLOTS.length, 7, '应该有 7 个时段');
});

test('心跳触发记录持久化：重启后不会重复触发同一时段', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const config = { ...spec.companion, apiKey: '' };
  const today = localDateKey();

  // 第一个实例：真实触发一次空闲心跳，验证记录被写入磁盘
  const engineA = new CompanionEngine(dir, spec, config);
  await engineA.loadState();
  let firedCount = 0;
  engineA.startHeartbeat(() => { firedCount += 1; });
  // 把空闲阈值设为 1ms，模拟"用户很久没说话"
  await engineA.setConfig({ idleHeartbeatMs: 1 });
  await engineA.fireIdleHeartbeat();
  await engineA.stopHeartbeat();
  console.log('  第一个实例触发次数:', firedCount);

  const recordFile = path.join(dir, 'companion-heartbeat.json');
  const persisted = JSON.parse(await readFile(recordFile, 'utf8')) as string[];
  console.log('  落盘记录:', JSON.stringify(persisted));
  assert.ok(persisted.includes(`${today}:idle`), '空闲心跳记录应该落盘');

  // 第二个实例：模拟重启，应从磁盘恢复记录
  const engineB = new CompanionEngine(dir, spec, config);
  await engineB.loadState();
  const restored = (engineB as any).firedSlots as Set<string>;
  console.log('  重启后恢复的记录数:', restored.size);
  assert.ok(restored.has(`${today}:idle`), '重启后应该恢复空闲心跳记录');

  // 重启后不应再次触发同一天的空闲心跳
  let secondCount = 0;
  engineB.startHeartbeat(() => { secondCount += 1; });
  await engineB.setConfig({ idleHeartbeatMs: 1 });
  await engineB.fireIdleHeartbeat();
  await engineB.stopHeartbeat();
  console.log('  重启后再次触发次数:', secondCount);
  assert.equal(secondCount, 0, '重启后同一天的空闲心跳不应重复触发');
});

test('本地心跳兜底说的是人话，不是内部提示词', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  const state = await engine.getState();
  const slot = { id: 'morning', label: '上午', hour: 10, minute: 10 };

  const text = localHeartbeatFallback(slot, state, spec);
  console.log('  心跳兜底文案:', text);
  // 不应包含内部提示词特征
  assert.ok(!text.includes('想主动跟用户说一句话'), '不能把内部提示词推给用户');
  assert.ok(!text.includes('不要问问题式的客服语气'), '不能包含写作指令');
  assert.ok(text.includes('小小闫'), '应该带上角色名');
  assert.ok(text.length > 4, '应该有实际内容');
});

test('空闲兜底说的是人话', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  const state = await engine.getState();
  const text = localIdleFallback(state, spec);
  console.log('  空闲兜底文案:', text);
  assert.ok(!text.includes('用户已经'), '不能把内部种子提示词推给用户');
  assert.ok(text.includes('小小闫'));
});
