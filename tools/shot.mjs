// 抓取运行中桌宠的三个窗口截图，用于人工核对 UI
import { chromium } from 'playwright';

const targets = await fetch('http://127.0.0.1:9223/json/list').then((r) => r.json());
const pick = (role) => {
  const hit = targets.find((t) => (t.url || '').includes(`/${role}_window/`));
  if (!hit) throw new Error(`找不到 ${role} 窗口`);
  return hit.webSocketDebuggerUrl;
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const context = browser.contexts()[0] ?? await browser.newContext();

for (const role of ['dashboard', 'pet']) {
  const pages = context.pages();
  const target = pages.find((p) => p.url().includes(`/${role}_window/`));
  if (!target) {
    console.log(`跳过 ${role}：未找到页面`);
    continue;
  }
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  await target.waitForTimeout(1500);
  const out = `C:/Users/lenovo/WorkBuddy/2026-10-23-17-22-54/shot-${role}.png`;
  await target.screenshot({ path: out });
  console.log(`已保存 ${out}`);
  // 同时抓一份关键 DOM 状态
  const info = await target.evaluate(() => {
    const gate = document.getElementById('key-gate');
    const empty = document.getElementById('chat-empty');
    const avatar = document.getElementById('pet-avatar');
    const chatAvatar = document.getElementById('chat-avatar');
    return {
      keyGateVisible: gate ? !gate.hidden : null,
      keyGateText: gate?.querySelector('.key-gate-title')?.textContent ?? null,
      chatEmptyVisible: empty ? !empty.hidden : null,
      suggestions: Array.from(document.querySelectorAll('.chat-suggestion')).map((b) => b.textContent),
      petAvatarSrc: avatar?.getAttribute('src')?.slice(0, 60) ?? null,
      chatAvatarSrc: chatAvatar?.getAttribute('src')?.slice(0, 60) ?? null,
      statusText: document.getElementById('companion-status-text')?.textContent ?? null,
      configBodyCollapsed: document.getElementById('config-body')?.classList.contains('collapsed') ?? null,
    };
  });
  console.log(role, JSON.stringify(info, null, 2));
}

await browser.close();
