import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceAffinity,
  canDo,
  DAILY_GAIN_CAP,
  proactiveIntensity,
  shouldSpeakProactively,
  tierOf,
  TIERS,
} from '../../src/main/companion/affinity';
import { advanceState, DEFAULT_COMPANION_STATE } from '../../src/main/companion/persona';
import { CompanionEngine } from '../../src/main/companion/engine';
import petSpec from '../../../pet-spec.json';

/**
 * 好感度回归测试。
 *
 * 核心主张：好感度必须改变**行为**，而不只是措辞。
 * 所以这里测的不是「亲密度涨了没有」，而是
 * 「到了某个阶段，某件事到底做不做」。
 */

const base = () => ({ ...DEFAULT_COMPANION_STATE });

test('阶段阶梯单调且首尾完整', () => {
  assert.equal(TIERS[0]?.id, 'stranger');
  assert.equal(TIERS[TIERS.length - 1]?.id, 'confidant');
  for (let i = 1; i < TIERS.length; i += 1) {
    assert.ok((TIERS[i]?.min ?? 0) > (TIERS[i - 1]?.min ?? 0), '阶段阈值必须递增');
  }
});

test('亲密度决定阶段，不是反过来', () => {
  assert.equal(tierOf(0).id, 'stranger');
  assert.equal(tierOf(20).id, 'familiar');
  assert.equal(tierOf(40).id, 'close');
  assert.equal(tierOf(60).id, 'dependent');
  assert.equal(tierOf(75).id, 'tacit');
  assert.equal(tierOf(95).id, 'confidant');
});

test('用户说话会涨亲密度', () => {
  const before = base();
  const after = advanceAffinity(before, 'user_message');
  assert.ok(after.delta > 0, '亲密度应上涨');
  assert.ok(after.state.intimacy > before.intimacy);
});

test('心跳被无视会掉亲密度 —— 沉默有代价', () => {
  const before = { ...base(), intimacy: 40 };
  const after = advanceAffinity(before, 'heartbeat_ignored');
  assert.ok(after.delta < 0, '被无视应扣分');
  assert.ok(after.state.intimacy < before.intimacy, '亲密度应下降');
});

test('心跳被回应会涨亲密度', () => {
  const before = { ...base(), intimacy: 40 };
  const after = advanceAffinity(before, 'heartbeat_answered');
  assert.ok(after.delta > 0);
});

test('每日涨幅有上限，刷不出来', () => {
  let state = { ...base(), intimacy: 10, intimacyGainedToday: DAILY_GAIN_CAP, lastGainDate: '2026-10-25' };
  const after = advanceAffinity(state, 'user_message');
  assert.equal(after.delta, 0, '达到每日上限后不应再涨');
  assert.ok(after.capped, '应标记为触顶');
  assert.equal(after.state.intimacy, state.intimacy, '亲密度不应变化');
});

test('跨天后涨幅上限重置', () => {
  const state = { ...base(), intimacy: 10, intimacyGainedToday: DAILY_GAIN_CAP, lastGainDate: '2026-10-24' };
  const after = advanceAffinity(state, 'user_message', { now: new Date('2026-10-25T10:00:00').getTime() });
  assert.ok(after.delta > 0, '新的一天应重新获得涨幅空间');
});

test('亲密度低时不敢主动开口', () => {
  const low = { ...base(), intimacy: 5, energy: 90 };
  assert.equal(shouldSpeakProactively(low), false, '陌生阶段不该主动搭话');
  const friend = { ...base(), intimacy: 25, energy: 90 };
  assert.equal(shouldSpeakProactively(friend), true, '熟悉之后可以主动');
});

test('活力耗尽时即使关系好也不硬凑热闹', () => {
  const tired = { ...base(), intimacy: 60, energy: 5 };
  assert.equal(shouldSpeakProactively(tired), false, '活力太低应保持安静');
});

test('行为解锁随阶段递进', () => {
  const stranger = { ...base(), intimacy: 5 };
  const close = { ...base(), intimacy: 40 };
  const confidant = { ...base(), intimacy: 95 };

  assert.equal(canDo(stranger, '主动关心用户状态（熬夜/久坐/情绪）'), false);
  assert.equal(canDo(close, '主动关心用户状态（熬夜/久坐/情绪）'), true);
  assert.equal(canDo(confidant, '可以撒娇、吐槽用户'), true);
});

test('主动搭话强度分级', () => {
  const stranger = { ...base(), intimacy: 5 };
  const friend = { ...base(), intimacy: 25, trust: 20 };
  const intimate = { ...base(), intimacy: 40, trust: 60 };

  assert.equal(proactiveIntensity(stranger), 0, '陌生时强度为 0（不说话）');
  assert.equal(proactiveIntensity(friend), 1, '熟悉时轻描淡写');
  assert.equal(proactiveIntensity(intimate), 2, '亲近且信任时主动关心');
});

test('亲密度与活力始终被夹在 0-100', () => {
  let state = { ...base(), intimacy: 99 };
  for (let i = 0; i < 20; i += 1) {
    state = advanceAffinity(state, 'user_message').state;
  }
  assert.ok(state.intimacy <= 100, '亲密度不能超过 100');

  let low = { ...base(), intimacy: 1 };
  for (let i = 0; i < 20; i += 1) {
    low = advanceAffinity(low, 'heartbeat_ignored').state;
  }
  assert.ok(low.intimacy >= 0, '亲密度不能低于 0');
  assert.ok((low.energy ?? 0) >= 0, '活力不能低于 0');
});

test('阶段变化会被标记出来（用于播报）', () => {
  const before = { ...base(), intimacy: 14 };
  const after = advanceAffinity(before, 'user_message');
  assert.ok(after.tierChanged, '跨阶段应被标记');
  assert.equal(after.tier.id, 'familiar');
});

test('信任需要亲密度到一定水平才涨', () => {
  const stranger = { ...base(), intimacy: 10, trust: 20 };
  const afterStranger = advanceAffinity(stranger, 'user_message');
  assert.equal(afterStranger.state.trust, 20, '陌生阶段不该涨信任');

  const friend = { ...base(), intimacy: 40, trust: 20 };
  const afterFriend = advanceAffinity(friend, 'user_message');
  assert.ok((afterFriend.state.trust ?? 0) > 20, '关系到位后信任才涨');
});

test('亲密度只能由 advanceAffinity 一处累加（防双算）', () => {
  // advanceState 早期版本也加过 1.5 分，导致一轮对话涨 2.5 而不是 1。
  // 这里锁死：advanceState 不得触碰亲密度。
  const before = { ...base(), intimacy: 30 };
  const after = advanceState(before, { userEngaged: true });
  assert.equal(
    after.intimacy,
    before.intimacy,
    'advanceState 不应改变亲密度 —— 那是 advanceAffinity 的职责',
  );
  assert.ok(after.mood > before.mood, '情绪仍应由 advanceState 推进');
});

test('老存档缺三轴字段时，loadState 应立即回写补齐', async () => {
  const { mkdtemp, readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const spec = petSpec as any;

  const dir = await mkdtemp(path.join(tmpdir(), 'pet-legacy-'));
  await mkdir(dir, { recursive: true });
  // 写一个 v1 风格的存档：只有 intimacy / mood / chatTurns
  await writeFile(
    path.join(dir, 'companion-state.json'),
    JSON.stringify({ intimacy: 32, mood: 54, chatTurns: 8 }),
    'utf8',
  );

  const config: any = {
    provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm', apiKey: '',
    reasoningEffort: 'low', temperature: 0.85, maxTokens: 640, timeoutMs: 45000,
    personaExtra: '', memoryEnabled: true, memoryRecentTurns: 12, memoryArchiveTurns: 120,
    memoryConsolidateEvery: 12, heartbeatEnabled: true, idleHeartbeatMs: 1800000,
  };
  const engine = new CompanionEngine(dir, spec, config);
  await engine.loadState();

  // 读回磁盘：字段应已被补齐写回，而不是等下一次互动
  const saved = JSON.parse(await readFile(path.join(dir, 'companion-state.json'), 'utf8'));
  assert.equal(saved.intimacy, 32, '原有亲密度必须保留');
  assert.equal(typeof saved.energy, 'number', 'energy 应被补齐并落盘');
  assert.equal(typeof saved.trust, 'number', 'trust 应被补齐并落盘');
  assert.equal(typeof saved.intimacyGainedToday, 'number', 'intimacyGainedToday 应被补齐并落盘');
});
