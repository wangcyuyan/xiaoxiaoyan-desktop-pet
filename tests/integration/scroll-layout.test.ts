import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 页面滚动链路回归测试。
 *
 * 背景：2026-10-24 用户反馈「只有这个页面不能上下翻页」。
 * 根因是 flex 布局的经典陷阱：
 *
 *   #dashboard (height:100%, flex column)
 *     └─ .card (flex:1)          ← flex 子项默认 min-height:auto，
 *        │                          会被内容撑高，flex:1 形同虚设
 *        └─ .content-scroll (flex:1, overflow-y:auto)
 *
 * 表面上 .content-scroll 设了 overflow-y:auto，但因为父级没有被压缩，
 * 它不会产生滚动条，超出的内容直接溢出到窗口外 —— 用户看到的就是"滚不动"。
 *
 * 修复：给 .card 和 #dashboard 都加 min-height:0。
 *
 * 这类问题光看代码容易漏（本例中三处 CSS 都"看起来对"），
 * 所以除了静态断言，还配了 tools/verify-scroll.mjs 做真实滚轮验证。
 */

const read = (relative: string) => readFile(relative, 'utf8');

test('dashboard 滚动链路：.card 必须 min-height:0', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  const cardRule = html.match(/\.card\s*\{([^}]*)\}/);
  assert.ok(cardRule, '找不到 .card 样式');
  const body = cardRule[1] ?? '';
  assert.ok(
    /min-height:\s*0/.test(body),
    '.card 缺少 min-height:0 —— flex 子项会被内容撑高，导致内部无法滚动',
  );
  assert.ok(/overflow:\s*hidden/.test(body), '.card 应设置 overflow:hidden 裁掉圆角外的溢出');
});

test('dashboard 滚动链路：#dashboard 必须 min-height:0 且不能 overflow:hidden', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  const dashRule = html.match(/#dashboard\s*\{([^}]*)\}/);
  assert.ok(dashRule, '找不到 #dashboard 样式');
  const body = dashRule[1] ?? '';
  assert.ok(/min-height:\s*0/.test(body), '#dashboard 缺少 min-height:0');
  assert.ok(
    !/overflow:\s*hidden/.test(body),
    '#dashboard 不能设 overflow:hidden —— 会把超出内容裁掉且滚不动',
  );
});

test('dashboard 滚动链路：.content-scroll 必须可滚动', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  const rule = html.match(/\.content-scroll\s*\{([^}]*)\}/);
  assert.ok(rule, '找不到 .content-scroll 样式');
  const body = rule[1] ?? '';
  assert.ok(/flex:\s*1/.test(body), '.content-scroll 必须 flex:1');
  assert.ok(/min-height:\s*0/.test(body), '.content-scroll 必须 min-height:0');
  assert.ok(/height:\s*0/.test(body), '.content-scroll 必须 height:0（配合 flex 才有确定高度）');
  assert.ok(/overflow-y:\s*(auto|scroll)/.test(body), '.content-scroll 必须可纵向滚动');
  assert.ok(/overflow-x:\s*hidden/.test(body), '.content-scroll 不应出现横向滚动');
  assert.ok(/overscroll-behavior:\s*contain/.test(body), '缺少 overscroll-behavior:contain，滚到边界会带动父级');
});

test('滚动条必须可见（用户要能看到自己在第几屏）', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  const rule = html.match(/\.content-scroll::\-webkit-scrollbar\s*\{([^}]*)\}/);
  assert.ok(rule, '缺少滚动条样式');
  const width = (rule[1] ?? '').match(/width:\s*(\d+)px/);
  assert.ok(width, '滚动条未设宽度');
  assert.ok(Number(width[1]) >= 4, `滚动条宽度 ${width[1]}px 太细，几乎看不见`);
  assert.ok(
    html.includes('.content-scroll::-webkit-scrollbar-thumb'),
    '缺少滚动条滑块样式',
  );
  assert.ok(
    html.includes('.content-scroll::-webkit-scrollbar-thumb:hover'),
    '滚动条缺少 hover 反馈',
  );
});

test('聊天区不能撑破外层布局（固定高度会挤掉其他区块）', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  const panelRule = html.match(/\.chat-panel\s*\{([^}]*)\}/);
  assert.ok(panelRule, '找不到 .chat-panel 样式');
  const panelBody = panelRule[1] ?? '';
  // 不能用固定 max-height 限死，否则记录区一大就撑破布局
  assert.ok(
    !/max-height:\s*\d+px/.test(panelBody),
    '.chat-panel 不应设固定 max-height',
  );
  // .chat-panel 是固定高度的 flex 列，记录区靠 flex 自适应填满剩余空间，
  // 超出部分在 .chat-log 内部滚动，不外溢到面板之外。
  assert.ok(
    /height:\s*\d+px/.test(panelBody),
    '.chat-panel 需要确定的高度，记录区才能算出可用空间',
  );

  const logRule = html.match(/\.chat-log\s*\{([^}]*)\}/);
  assert.ok(logRule, '找不到 .chat-log 样式');
  const logBody = logRule[1] ?? '';
  assert.ok(/flex:\s*1/.test(logBody), '.chat-log 必须 flex:1 自适应');
  // 注意：.chat-log 不适用 min-height:0 那一套。
  // min-height:0 是给「高度由 flex 分配」的容器用的（.card / #dashboard / .content-scroll）；
  // .chat-log 在固定高度的 .chat-panel 内部，需要一个下限保证记录区不塌成一条缝，
  // 超出内容由 overflow-y 自行滚动。断言的是「有下限 + 内部可滚」，不是 min-height:0。
  const minHeight = logBody.match(/min-height:\s*(\d+)px/);
  assert.ok(minHeight, '.chat-log 缺少 min-height 下限');
  assert.ok(Number(minHeight[1]) >= 140, `记录区最小高度 ${minHeight[1]}px 太小`);
  assert.ok(
    /overflow-y:\s*(auto|scroll)/.test(logBody),
    '.chat-log 必须内部可滚动，超长内容不能撑破 .chat-panel',
  );
});

test('reminder 窗口的滚动容器必须存在且可滚动', async () => {
  const html = await read('src/renderer/reminder/index.html');
  assert.ok(/overflow-y:\s*(auto|scroll)/.test(html), 'reminder 缺少纵向滚动容器');
});

test('pet 窗口的聊天面板不能撑破桌宠窗口', async () => {
  const html = await read('src/renderer/pet/index.html');
  const rule = html.match(/#chat-panel\s*\{([^}]*)\}/);
  assert.ok(rule, '找不到 #chat-panel 样式');
  const body = rule[1] ?? '';
  assert.ok(/position:\s*absolute/.test(body), '聊天面板应绝对定位，不参与文档流');
  assert.ok(/max-width|left:\s*50%/.test(body), '聊天面板应水平居中且不超出窗口');
});

test('滚动验证脚本存在（真实滚轮回归用）', async () => {
  const script = await read('tools/verify-scroll.mjs');
  assert.ok(script.includes('mouse.wheel'), '缺少真实滚轮模拟');
  assert.ok(script.includes('scrollHeight'), '缺少 scrollHeight 检查');
  assert.ok(script.includes('底部可达') || script.includes('lastSectionVisible'), '缺少底部可达性检查');
});
