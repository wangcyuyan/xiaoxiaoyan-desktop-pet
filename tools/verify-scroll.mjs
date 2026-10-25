// 验证小屋页面上下滚动是否真的可用
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

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

await page.goto('http://127.0.0.1:3000/dashboard_window/index.html', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2000);

const before = await page.evaluate(() => {
  const sc = document.querySelector('.content-scroll');
  if (!sc) return { error: '找不到 .content-scroll' };
  return {
    scrollHeight: sc.scrollHeight,
    clientHeight: sc.clientHeight,
    scrollTop: sc.scrollTop,
    canScroll: sc.scrollHeight > sc.clientHeight,
    overflowY: getComputedStyle(sc).overflowY,
  };
});
console.log('滚动前:', JSON.stringify(before));

// 模拟真实鼠标滚轮
await page.mouse.move(260, 400);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(600);

const after = await page.evaluate(() => {
  const sc = document.querySelector('.content-scroll');
  return {
    scrollTop: sc?.scrollTop ?? -1,
    lastVisible: (() => {
      const items = Array.from(document.querySelectorAll('.section-title'));
      const visible = items.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      return visible.map((el) => el.textContent.trim().slice(0, 12));
    })(),
  };
});
console.log('滚轮后:', JSON.stringify(after));

// 直接设置 scrollTop 验证可滚动性
const programmatic = await page.evaluate(() => {
  const sc = document.querySelector('.content-scroll');
  if (!sc) return { ok: false };
  sc.scrollTop = sc.scrollHeight;
  return { ok: sc.scrollTop > 0, scrollTop: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
});
console.log('编程滚动:', JSON.stringify(programmatic));

// 底部内容是否可达
const bottom = await page.evaluate(() => {
  const sc = document.querySelector('.content-scroll');
  if (!sc) return { ok: false };
  sc.scrollTop = sc.scrollHeight;
  const last = document.querySelector('#config-group');
  const r = last?.getBoundingClientRect();
  return {
    ok: Boolean(last && r && r.bottom <= window.innerHeight + 2),
    lastSectionVisible: r ? r.bottom <= window.innerHeight + 2 : false,
    scrollTop: sc.scrollTop,
  };
});
console.log('底部可达:', JSON.stringify(bottom));

// ── 顺便检查另外两个窗口的滚动 ──
for (const role of ['reminder_window', 'pet_window']) {
  const info = await page.evaluate(async (roleName) => {
    const frame = document.querySelector(`iframe[src*="${roleName}"]`);
    return { hasFrame: Boolean(frame) };
  }, role);
  console.log(`${role}:`, JSON.stringify(info));
}

await browser.close();
