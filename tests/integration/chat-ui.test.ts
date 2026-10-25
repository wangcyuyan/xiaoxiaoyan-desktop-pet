import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 聊天页面 UI 完整性测试。
 *
 * 背景：2026-10-24 用户反馈"聊天页面制作非常不完善，并且没有配置key的页面"。
 * 实际缺陷包括：
 *   - 聊天记录区只有 220px，在 520×700 的窗口里看不全对话
 *   - 小屋头部是 🐱 emoji，不是小小闫的立绘
 *   - 未配置 Key 时只有一行灰字提示，没有引导，用户不知道下一步做什么
 *   - 配置表单在第 4 屏，几乎找不到
 *   - 没有空状态引导，第一次打开是空白框
 *
 * 这些都是"看起来不好用"的问题，光靠功能测试发现不了，
 * 必须对 UI 结构做静态断言。
 */

const read = (relative: string) => readFile(relative, 'utf8');

test('聊天面板必须占据视觉主体（记录区不能太小）', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  const logRule = html.match(/\.chat-log\s*\{([^}]*)\}/);
  assert.ok(logRule, '找不到 .chat-log 样式');
  // 记录区必须用 flex:1 自适应，且有最小高度
  const logBody = logRule[1] ?? '';
  assert.ok(logBody.includes('flex: 1'), '.chat-log 必须 flex:1 自适应高度');
  const minHeight = logBody.match(/min-height:\s*(\d+)px/);
  assert.ok(minHeight, '.chat-log 缺少 min-height');
  assert.ok(Number(minHeight[1]) >= 140, `记录区最小高度 ${minHeight[1]}px 太小`);
  // 不能再用固定 max-height 限制（那正是原来的缺陷）
  assert.ok(!/max-height:\s*2\d\dpx/.test(logBody), '记录区不应再用 220px 之类的固定上限');
});

test('聊天面板必须有独立的容器与头部', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(html.includes('id="chat-panel"'), '缺少 chat-panel 容器');
  assert.ok(html.includes('id="chat-panel-head"') || html.includes('chat-panel-head'), '缺少聊天面板头部');
  assert.ok(html.includes('id="chat-head-name"'), '缺少聊天面板角色名');
});

test('未配置 Key 时必须有引导卡片（这是用户明确要求的配置入口）', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(html.includes('id="key-gate"'), '缺少未配 Key 引导卡片');
  assert.ok(html.includes('id="key-gate-fill"'), '引导卡片缺少"立即配置"按钮');
  assert.ok(html.includes('id="key-gate-env"'), '引导卡片缺少"用环境变量"按钮');
  assert.ok(html.includes('id="key-gate-hint"'), '引导卡片缺少环境变量说明区');
  assert.ok(html.includes('还没有配置 API Key'), '引导卡片缺少标题文案');
});

test('引导卡片必须有 JS 逻辑：未配 Key 显示、配好隐藏', async () => {
  const script = await read('src/renderer/dashboard/index.ts');
  assert.ok(script.includes('keyGate.hidden = false'), '未配 Key 时未显示引导卡片');
  assert.ok(script.includes('keyGate.hidden = true'), '配好 Key 后未隐藏引导卡片');
  assert.ok(script.includes('keyGateFill.addEventListener'), '引导卡片按钮未绑定事件');
  assert.ok(script.includes('keyGateEnv.addEventListener'), '环境变量按钮未绑定事件');
  assert.ok(script.includes('function focusConfig'), '缺少 focusConfig 跳转逻辑');
});

test('配置区必须可折叠，且任何状态默认展开（自动折叠会把聊天方式调节藏起来）', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(html.includes('id="config-toggle"'), '配置区缺少折叠开关');
  assert.ok(html.includes('id="config-arrow"'), '配置区缺少折叠箭头');
  assert.ok(html.includes('id="config-body"'), '配置区缺少内容容器');
  assert.ok(html.includes('.companion-form.collapsed'), '缺少折叠样式');

  const script = await read('src/renderer/dashboard/index.ts');
  assert.ok(script.includes('function setConfigCollapsed'), '缺少折叠控制函数');
  assert.ok(script.includes('setConfigCollapsed(false)'), '未配 Key 时未展开配置区');
  // 已连接（桥接常态）时不得自动收起 —— 否则思考/温度/长度控件会被藏起来
  // 让用户找不到。折叠只应通过用户点击 config-toggle 触发。
  assert.ok(!script.includes('setConfigCollapsed(true)'), '已连接/保存后不得自动收起配置区');
});

test('配置表单必须包含 API Key 输入框', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(html.includes('id="cfg-api-key"'), '缺少 API Key 输入框');
  assert.ok(html.includes('type="password"'), 'API Key 输入框应使用 password 类型');
  assert.ok(html.includes('id="cfg-base-url"'), '缺少服务地址输入框');
  assert.ok(html.includes('id="cfg-model"'), '缺少模型输入框');
  assert.ok(html.includes('id="cfg-save"'), '缺少保存按钮');
});

test('聊天区必须有空状态引导与快捷短语', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(html.includes('id="chat-empty"'), '缺少空状态引导');
  assert.ok(html.includes('chat-suggestion'), '缺少快捷短语按钮');
  assert.ok(html.includes('data-text='), '快捷短语缺少预置文本');

  const script = await read('src/renderer/dashboard/index.ts');
  assert.ok(script.includes('chatEmpty.hidden = true'), '发消息后未隐藏空状态');
  assert.ok(script.includes('chatEmpty.hidden = history.length > 0'), '加载历史未正确处理空状态');
});

test('小屋头像必须是真实立绘而非 emoji', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(!html.includes('<div class="pet-avatar">🐱</div>'), '小屋头像仍是 emoji');
  assert.ok(html.includes('id="pet-avatar"'), '缺少立绘 img 元素');
  assert.ok(html.includes('id="chat-avatar"'), '聊天面板缺少立绘头像');

  const script = await read('src/renderer/dashboard/index.ts');
  assert.ok(script.includes('require.context'), '未加载立绘资源');
  assert.ok(script.includes('coreAssetUrl'), '未使用 coreAsset 作为头像');
});

test('聊天输入体验：Enter 发送、Shift+Enter 换行、随内容增高', async () => {
  const script = await read('src/renderer/dashboard/index.ts');
  assert.ok(
    /event\.key === 'Enter' && !event\.shiftKey/.test(script),
    'Enter 发送 / Shift+Enter 换行 未实现',
  );
  assert.ok(script.includes("chatText.addEventListener('input'"), '输入框未随内容增高');
  assert.ok(script.includes('scrollHeight'), '输入框高度未按内容计算');
});
