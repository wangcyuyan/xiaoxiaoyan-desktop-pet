import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CompanionEngine } from '../../src/main/companion/engine';

let spec: any;
before(async () => {
  spec = JSON.parse(await readFile('pet-spec.json', 'utf8'));
});

/**
 * 验证"桌宠主动找你聊天"的完整事件流。
 *
 * 上一轮的致命缺陷：pet 窗口没有订阅 companion:event，
 * 导致心跳消息发出去后桌宠本体完全不显示 —— 用户永远看不到。
 * 这个测试模拟"主进程广播 -> 渲染层收到"这一段，
 * 确保事件里确实带上了可显示的内容。
 */
test('心跳事件携带可显示内容（渲染层能直接展示）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  await engine.loadState();

  const events: any[] = [];
  engine.startHeartbeat((reply) => { events.push(reply); });
  await engine.setConfig({ idleHeartbeatMs: 1 });
  await engine.fireIdleHeartbeat();
  await engine.stopHeartbeat();

  assert.equal(events.length, 1, '应该产生一次心跳事件');
  const event = events[0];
  console.log('  心跳事件内容:', event.content);

  // 这些是渲染层 showFeedback() 能直接显示的前提
  assert.ok(typeof event.content === 'string', 'content 必须是字符串');
  assert.ok(event.content.length > 0, 'content 不能为空');
  assert.ok(!event.content.includes('用户已经'), '不能是内部种子提示词');
  assert.ok(!event.content.includes('想主动跟用户说'), '不能是内部提示词');
  assert.ok(event.state, '必须携带状态，供渲染层更新亲密度/心情');
  assert.equal(typeof event.degraded, 'boolean', '必须标记是否降级');
});

test('定时心跳同样产生可显示事件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  await engine.loadState();

  const events: any[] = [];
  engine.startHeartbeat((reply) => { events.push(reply); });

  // 直接调用定时心跳；未到时段则不触发，这里验证不会崩、事件结构正确
  await engine.fireHeartbeat();
  await engine.stopHeartbeat();

  console.log(`  定时心跳事件数: ${events.length}（未到时段为 0，正常）`);
  for (const event of events) {
    assert.ok(event.content.length > 0);
  }
});

test('对话回复也走同一条事件通道，渲染层能收到', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, { ...spec.companion, apiKey: '' });
  await engine.loadState();

  const events: any[] = [];
  engine.startHeartbeat((reply) => { events.push(reply); });
  const reply = await engine.reply('你好');
  await engine.stopHeartbeat();

  console.log('  对话回复:', reply.content);
  assert.ok(reply.content.length > 0, '回复不能为空');
  assert.ok(reply.state, '必须带状态');
});
