import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { CompanionEngine } from '../../src/main/companion/engine';

let spec: any;
let mock: ChildProcess | undefined;
const MOCK_URL = 'http://127.0.0.1:18777';

before(async () => {
  spec = JSON.parse(await readFile('pet-spec.json', 'utf8'));
  mock = spawn(process.execPath, ['tests/mock-server.mjs'], { stdio: 'inherit' });
  // 等 mock server 就绪
  await new Promise((resolve) => setTimeout(resolve, 1200));
});

after(() => {
  mock?.kill();
});

test('完整闭环：真实 HTTP 调用 + 记忆召回 + 状态推进', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, {
    ...spec.companion,
    baseUrl: MOCK_URL,
    apiKey: 'sk-mock-key',
    model: 'deepseek-v4-pro',
  });

  // 1. 首轮对话：应该真实走 HTTP
  const reply1 = await engine.reply('你好呀，我今天在写代码');
  console.log('  第一轮回复:', reply1.content);
  assert.equal(reply1.degraded, false, '配置了 mock server 后不应降级');
  assert.ok(reply1.content.includes('Mock回复'), '应该拿到 mock 服务器的回复');

  // 2. 记忆写入：应该落盘
  const store = JSON.parse(await readFile(path.join(dir, 'companion-memory.json'), 'utf8')) as any;
  console.log('  记忆轮次:', store.totalTurns, '近期条数:', store.recent.length);
  assert.equal(store.totalTurns, 2, 'user + assistant 两轮');
  assert.equal(store.recent[0].role, 'user');
  assert.equal(store.recent[1].role, 'assistant');

  // 3. 第二轮对话：应该带上历史上下文
  const reply2 = await engine.reply('我刚才说到哪了');
  console.log('  第二轮回复:', reply2.content);
  assert.equal(reply2.degraded, false);

  // 4. 状态推进：亲密度上升
  console.log(`  亲密度: ${reply1.state.intimacy.toFixed(1)} -> ${reply2.state.intimacy.toFixed(1)}`);
  assert.ok(reply2.state.intimacy > reply1.state.intimacy, '亲密度应上升');

  // 5. 长期事实：写入后能被下一轮召回
  await engine.rememberFact({ subject: '用户', content: '正在准备 2027 年考研', weight: 5 });
  const reply3 = await engine.reply('考研的事我还记得吗');
  console.log('  第三轮召回了', reply3.recalledCount, '条记忆');
  assert.ok(reply3.recalledCount >= 1, '高权重事实应被召回');
});

test('完整闭环：心跳主动发起对话（真实 HTTP）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, {
    ...spec.companion,
    baseUrl: MOCK_URL,
    apiKey: 'sk-mock-key',
  });
  await engine.loadState();

  let received: any = null;
  engine.startHeartbeat((reply) => { received = reply; });
  // 强制空闲触发
  await engine.setConfig({ idleHeartbeatMs: 1 });
  await engine.fireIdleHeartbeat();
  await engine.stopHeartbeat();

  console.log('  心跳回复:', received?.content);
  assert.ok(received, '心跳应该产生回复');
  assert.equal(received.degraded, false, '配置了 mock server 后心跳不应降级');
  assert.ok(received.content.includes('Mock回复'), '心跳应该走真实 HTTP');
});

test('完整闭环：记忆自我整理会调用模型提取事实', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-'));
  const engine = new CompanionEngine(dir, spec, {
    ...spec.companion,
    baseUrl: MOCK_URL,
    apiKey: 'sk-mock-key',
    memoryConsolidateEvery: 2,
  });
  // mock server 返回的是「（Mock回复）...」，不是 JSON 数组
  // 所以整理应该失败但不影响主流程
  await engine.reply('第一句');
  await engine.reply('第二句');
  const store = JSON.parse(await readFile(path.join(dir, 'companion-memory.json'), 'utf8')) as any;
  console.log('  整理后总轮数:', store.totalTurns, '事实数:', store.facts.length);
  assert.ok(store.totalTurns >= 4, '即使整理失败，记忆写入也不能受影响');
});
