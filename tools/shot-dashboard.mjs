// 直接打开 webpack dev server 的 dashboard 页面截图
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

// 优先用系统 Chrome/Edge（Electron 的 exe 不能当 Chromium 用，参数不兼容）
const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const executablePath = candidates.find((item) => existsSync(item));

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 520, height: 700 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://127.0.0.1:3000/dashboard_window/index.html', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2500);

const out = 'C:/Users/lenovo/WorkBuddy/2026-10-23-17-22-54/shot-dashboard.png';
// 按真实窗口尺寸截图（不 fullPage），反映用户实际看到的样子
await page.screenshot({ path: out });
console.log('已保存', out);

// 再截一张「已配置 Key」形态：隐藏引导卡，模拟配好后的样子
await page.evaluate(() => {
  const gate = document.getElementById('key-gate');
  if (gate) gate.hidden = true;
  const status = document.getElementById('companion-status-text');
  if (status) status.textContent = '已连接 · deepseek-v4-pro';
  const dot = document.getElementById('companion-dot');
  if (dot) dot.className = 'status-dot ok';
  // 模拟有几条历史消息
  const log = document.getElementById('chat-log');
  if (log) {
    const empty = document.getElementById('chat-empty');
    if (empty) empty.hidden = true;
    for (const [role, text] of [
      ['user', '你好呀，今天有点累'],
      ['assistant', '辛苦啦～要不要先歇一会儿？我在这儿陪着你。'],
    ]) {
      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${role}`;
      bubble.textContent = text;
      log.append(bubble);
    }
  }
});
await page.waitForTimeout(400);
const out2 = 'C:/Users/lenovo/WorkBuddy/2026-10-23-17-22-54/shot-dashboard-configured.png';
await page.screenshot({ path: out2 });
console.log('已保存', out2);

const info = await page.evaluate(() => {
  const q = (id) => document.getElementById(id);
  const gate = q('key-gate');
  const empty = q('chat-empty');
  const avatar = q('pet-avatar');
  const chatAvatar = q('chat-avatar');
  const log = q('chat-log');
  return {
    keyGateVisible: gate ? !gate.hidden : null,
    keyGateTitle: gate?.querySelector('.key-gate-title')?.textContent ?? null,
    keyGateButtons: Array.from(gate?.querySelectorAll('.key-gate-btn') ?? []).map((b) => b.textContent),
    chatEmptyVisible: empty ? !empty.hidden : null,
    suggestions: Array.from(document.querySelectorAll('.chat-suggestion')).map((b) => b.textContent),
    petAvatarSrc: avatar?.getAttribute('src')?.slice(0, 50) ?? null,
    chatAvatarSrc: chatAvatar?.getAttribute('src')?.slice(0, 50) ?? null,
    statusText: q('companion-status-text')?.textContent ?? null,
    configCollapsed: q('config-body')?.classList.contains('collapsed') ?? null,
    chatLogHeight: log?.getBoundingClientRect().height ?? null,
    hasChatPanel: Boolean(q('chat-panel')),
  };
});
console.log(JSON.stringify(info, null, 2));
console.log('控制台错误:', errors.length ? errors.slice(0, 5) : '无');

await browser.close();
