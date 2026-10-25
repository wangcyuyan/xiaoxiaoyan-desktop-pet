// 完整验收：小屋页面三态截图 + 滚动验证
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const executablePath = candidates.find((item) => existsSync(item));
const OUT = 'C:/Users/lenovo/WorkBuddy/2026-10-23-17-22-54';

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 520, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://127.0.0.1:3000/dashboard_window/index.html', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2200);

// ── 态 1：未配置 Key（第一屏）──
await page.screenshot({ path: `${OUT}/ui-1-未配置key.png` });
console.log('✓ ui-1-未配置key.png');

// ── 态 2：滚到底部 ──
const scrollInfo = await page.evaluate(() => {
  const sc = document.querySelector('.content-scroll');
  if (!sc) return { error: 'no scroll' };
  sc.scrollTop = sc.scrollHeight;
  return {
    scrollHeight: sc.scrollHeight,
    clientHeight: sc.clientHeight,
    maxScroll: sc.scrollHeight - sc.clientHeight,
    scrollTop: sc.scrollTop,
  };
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/ui-2-滚到底部.png` });
console.log('✓ ui-2-滚到底部.png', JSON.stringify(scrollInfo));

// ── 态 3：已配置 Key + 有聊天记录 ──
await page.evaluate(() => {
  const sc = document.querySelector('.content-scroll');
  if (sc) sc.scrollTop = 0;
  const gate = document.getElementById('key-gate');
  if (gate) gate.hidden = true;
  const status = document.getElementById('companion-status-text');
  if (status) status.textContent = '已连接 · deepseek-v4-pro';
  const dot = document.getElementById('companion-dot');
  if (dot) dot.className = 'status-dot ok';
  const empty = document.getElementById('chat-empty');
  if (empty) empty.hidden = true;
  const log = document.getElementById('chat-log');
  if (log) {
    for (const [role, text] of [
      ['user', '早上好'],
      ['assistant', '嗨，我在呢。'],
      ['user', '你好呀，我们第一次说话'],
      ['assistant', '小小闫抬头看了看：「嗨，我在呢。」'],
    ]) {
      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${role}`;
      bubble.textContent = text;
      const meta = document.createElement('span');
      meta.className = 'chat-meta';
      meta.textContent = '10:34';
      bubble.append(meta);
      log.append(bubble);
    }
    log.scrollTop = log.scrollHeight;
  }
  // 展开配置区看看形态
  const body = document.getElementById('config-body');
  if (body) body.classList.remove('collapsed');
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/ui-3-已配置key.png` });
console.log('✓ ui-3-已配置key.png');

// ── 态 4：已配置 + 滚到底部（看配置区）──
await page.evaluate(() => {
  const sc = document.querySelector('.content-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/ui-4-配置区.png` });
console.log('✓ ui-4-配置区.png');

console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无');
await browser.close();
