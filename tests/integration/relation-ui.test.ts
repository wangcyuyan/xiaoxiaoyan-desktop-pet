import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 关系可视化回归测试。
 *
 * 背景：v2 好感度系统给小屋页面加了三轴关系条与阶段称号。
 * 这类 UI 只靠肉眼容易漏（元素在但没被赋值、id 写错、
 * 两个来源抢同一个元素的写入权），所以用静态断言锁住。
 */

const read = (relative: string) => readFile(relative, 'utf8');

test('小屋必须有三轴关系条容器', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(html.includes('id="relation-bars"'), '缺少三轴关系条容器');
  assert.ok(html.includes('class="relation-bar"'), '缺少单条关系条');
});

test('三条关系轴各有独立元素', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  for (const id of ['bar-intimacy', 'bar-energy', 'bar-trust']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`);
  }
  for (const id of ['num-intimacy', 'num-energy', 'num-trust']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`);
  }
});

test('关系条必须有实际宽度样式（否则永远是 0）', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  const fillRule = html.match(/\.relation-fill\s*\{([^}]*)\}/);
  assert.ok(fillRule, '找不到 .relation-fill 样式');
  assert.ok(/height:\s*100%/.test(fillRule[1] ?? ''), '填充条需要撑满轨道');
  assert.ok(/width:\s*0/.test(fillRule[1] ?? ''), '初始宽度应为 0，由 JS 设置');
  const trackRule = html.match(/\.relation-track\s*\{([^}]*)\}/);
  assert.ok(trackRule, '找不到 .relation-track 样式');
  assert.ok(/height:\s*\d+px/.test(trackRule[1] ?? ''), '轨道需要确定高度');
});

test('三轴要有颜色区分', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(html.includes('.relation-fill.energy'), '活力轴应有独立配色');
  assert.ok(html.includes('.relation-fill.trust'), '信任轴应有独立配色');
});

test('阶段称号元素存在', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(html.includes('id="companion-tier"'), '缺少关系阶段称号元素');
  assert.ok(html.includes('id="relation-note"'), '缺少关系说明文案元素');
});

test('渲染层必须给三条 bar 设置宽度', async () => {
  const ts = await read('src/renderer/dashboard/index.ts');
  assert.ok(
    /barIntimacy\.style\.width/.test(ts),
    '必须设置亲密轴宽度，否则进度条永远是空的',
  );
  assert.ok(/barEnergy\.style\.width/.test(ts), '必须设置活力轴宽度');
  assert.ok(/barTrust\.style\.width/.test(ts), '必须设置信任轴宽度');
});

test('阶段称号必须被渲染', async () => {
  const ts = await read('src/renderer/dashboard/index.ts');
  assert.ok(
    /tierEl\.textContent\s*=/.test(ts),
    '阶段称号必须赋值，否则永远显示默认值',
  );
  assert.ok(/relationNoteEl\.textContent\s*=/.test(ts), '关系说明必须赋值');
});

test('关系卡由关系亲密度填充，不能被互动统计抢走', async () => {
  const ts = await read('src/renderer/dashboard/index.ts');
  // 匹配 updateStats 的函数体（到下一个顶格 } 为止）
  const updateStats = ts.match(/function updateStats\([\s\S]*?\n\}/);
  assert.ok(updateStats, '找不到 updateStats');
  const body = updateStats[0];
  assert.ok(
    !/affectionEl|getElementById\('affection'\)/.test(body),
    'updateStats 不应再写「关系」卡 —— stats.affection 是累计互动值，语义不同',
  );
  assert.ok(
    /getElementById\('affection'\)/.test(ts),
    '「关系」卡应由 updateCompanionState 用关系亲密度填充',
  );
});

test('两处「好感度」语义必须分开 —— 卡片标签改为「关系」', async () => {
  const html = await read('src/renderer/dashboard/index.html');
  assert.ok(
    html.includes('💕 关系'),
    '顶部卡片应叫「关系」，与 stats.affection（累计互动）区分开',
  );
  assert.ok(
    !html.includes('💕 好感度'),
    '不应再出现两个都叫好感度的指标',
  );
});
