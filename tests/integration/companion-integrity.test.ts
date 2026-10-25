import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 伴侣能力完整性回归测试。
 *
 * 背景：2026-10-23 的一次 rollback 操作把 preload.ts 和
 * src/renderer/pet/index.ts 回滚掉了，导致：
 *   - 桌宠的聊天面板完全不存在（用户找不到对话入口）
 *   - pet 窗口没有订阅 companion:event，心跳主动搭话完全无效
 *   - 但主进程照样跑、照样打日志，看不出任何异常
 *
 * 这类"文件内容丢失但程序不报错"的缺陷，光靠运行测试发现不了。
 * 所以这里直接对源码做静态断言。
 */

const read = (relative: string) => readFile(relative, 'utf8');

test('preload 必须暴露 companion 桥（否则渲染层无法调用）', async () => {
  const source = await read('src/preload.ts');
  assert.ok(source.includes('companion:send'), '缺少 companion:send 通道');
  assert.ok(source.includes('companion:facts'), '缺少 companion:facts 通道');
  assert.ok(source.includes('companion:state'), '缺少 companion:state 通道');
  assert.ok(source.includes("subscribe<CompanionEvent>('companion:event'"), '缺少 companion:event 订阅');
  assert.ok(source.includes('onFocusChat'), '缺少 onFocusChat 桥');
});

test('pet 窗口必须订阅 companion:event（心跳主动搭话靠这条通道）', async () => {
  const source = await read('src/renderer/pet/index.ts');
  assert.ok(
    source.includes('companion?.onEvent'),
    'pet 窗口缺少 companion.onEvent 订阅 —— 桌宠主动找你聊天会完全失效',
  );
  assert.ok(source.includes("event.kind === 'heartbeat'"), '未处理 heartbeat 事件');
});

test('pet 窗口必须有聊天面板元素与交互逻辑', async () => {
  const html = await read('src/renderer/pet/index.html');
  const script = await read('src/renderer/pet/index.ts');

  assert.ok(html.includes('id="chat-panel"'), 'HTML 缺少聊天面板');
  assert.ok(html.includes('id="chat-input"'), 'HTML 缺少输入框');
  assert.ok(html.includes('id="chat-send"'), 'HTML 缺少发送按钮');

  assert.ok(script.includes('function openChat'), '缺少 openChat');
  assert.ok(script.includes('function submitChat'), '缺少 submitChat');
  assert.ok(script.includes('chatInput.addEventListener'), '缺少输入框事件绑定');
});

test('气泡显示时长必须可配置（心跳消息不能 2 秒就消失）', async () => {
  const script = await read('src/renderer/pet/index.ts');
  assert.ok(
    /function showFeedback\(text: string, durationMs = \d+\)/.test(script),
    'showFeedback 必须支持自定义时长',
  );
  // 心跳至少停留 15 秒（注意 20_000 这类数字分隔符写法）
  const heartbeatCall = script.match(
    /event\.kind === 'heartbeat'[\s\S]{0,240}?showFeedback\([^,]+,\s*([\d_]+)/,
  );
  assert.ok(heartbeatCall, '心跳未使用自定义时长');
  const duration = Number(heartbeatCall[1]?.replace(/_/g, ''));
  assert.ok(duration >= 15_000, `心跳气泡停留 ${duration}ms 太短，用户会错过`);
});

test('右键菜单与托盘菜单必须有显眼的聊天入口', async () => {
  const source = await read('src/main.ts');
  const occurrences = source.split('和小小闫聊天').length - 1;
  assert.ok(occurrences >= 3, `聊天入口出现 ${occurrences} 次，应覆盖右键菜单 + 两处托盘菜单`);
});

test('契约层必须定义 companion 类型与事件订阅', async () => {
  const source = await read('src/shared/contracts.ts');
  for (const name of [
    'interface CompanionSpec',
    'interface CompanionConfig',
    'interface CompanionState',
    'interface CompanionFact',
    'interface CompanionReply',
    'interface CompanionEvent',
    'interface CompanionAPI',
    'onFocusChat',
  ]) {
    assert.ok(source.includes(name), `缺少 ${name}`);
  }
});

test('pet-spec 必须开启伴侣功能开关', async () => {
  const spec = JSON.parse(await read('pet-spec.json'));
  assert.equal(spec.features.companionChat, true, 'companionChat 未开启');
  assert.equal(spec.features.companionMemory, true, 'companionMemory 未开启');
  assert.equal(spec.features.companionHeartbeat, true, 'companionHeartbeat 未开启');
  assert.ok(spec.companion, '缺少 companion 配置块');
  assert.ok(spec.companion.idleHeartbeatMs > 0, '空闲触发阈值必须为正数');
});
