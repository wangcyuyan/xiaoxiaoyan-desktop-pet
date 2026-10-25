import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET,
  budgetProfile,
  dropOldestToFit,
  excerpt,
  isWorkRequest,
  packSegments,
  redact,
  trimToBudget,
} from '../../src/main/companion/budget';

/**
 * 上下文预算回归测试。
 *
 * 背景：桌宠早期把「最近 N 轮 + 全部长期记忆」原样塞进提示词，
 * 每条都没有长度上限。长期使用后单次请求的上下文持续膨胀 ——
 * 社区里叫它「算力消耗指数级增长」。
 *
 * 这里锁住三件事：
 *   1. 每一层都有上限，且超限时丢的是最旧的内容
 *   2. 当前这条用户输入永远不被挤掉
 *   3. 凭据不会漏进上下文
 */

test('单条文本裁剪后不超过上限', () => {
  const long = '啊'.repeat(5000);
  assert.ok(excerpt(long, 100).length <= 100);
  assert.ok(redact(long, 100).length <= 100);
});

test('excerpt 保留头尾 —— 结论在头、落点在尾', () => {
  const text = `HEAD${'中'.repeat(500)}TAIL`;
  const out = excerpt(text, 100);
  assert.ok(out.startsWith('HEAD'), '头部应保留');
  assert.ok(out.endsWith('TAIL'), '尾部应保留');
  assert.ok(out.includes('已截短'));
});

test('凭据脱敏：常见密钥格式必须被替换', () => {
  const cases = [
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'ds-0123456789abcdefghijklmnop',
    'Bearer abcdefghijklmnopqrst',
    'api_key: mysecretvalue123',
    'password = hunter2hunter2',
    '密钥：abcdef123456',
  ];
  for (const secret of cases) {
    const out = redact(`前面 ${secret} 后面`);
    assert.ok(!out.includes(secret.split(/[ :=：]/)[0]!.length > 6 ? secret.slice(0, 12) : secret),
      `未脱敏: ${secret}`);
    assert.ok(out.includes('已隐藏凭据'), `未标记脱敏: ${secret}`);
  }
});

test('脱敏不会误伤普通文本', () => {
  const normal = '今天好累啊，我想去吃碗面。';
  assert.equal(redact(normal), normal);
});

test('按预算裁剪条目：总量与单条都受限', () => {
  const items = Array.from({ length: 50 }, (_, i) => `事实${i}${'x'.repeat(100)}`);
  const kept = trimToBudget(items, 500, 120, (item) => item);
  assert.ok(kept.length < items.length, '应丢弃部分条目');
  const total = kept.reduce((sum, item) => sum + item.length, 0);
  assert.ok(total <= 500, `总量 ${total} 超出预算 500`);
  for (const item of kept) {
    assert.ok(item.length <= 120, '单条应被裁到上限内');
  }
});

test('packSegments 按优先级装填，高优先级一定进得来', () => {
  const result = packSegments(['高优先级内容', '中优先级内容', '低优先级内容'], 10);
  assert.ok(result.text.includes('高优先级内容'), '高优先级必须保留');
  assert.ok(result.text.length <= 10, '总量不得超过预算');
});

test('溢出时丢最旧的，但永远保住当前输入', () => {
  const messages = [
    { role: 'system', content: '系统提示'.repeat(50) },
    { role: 'user', content: '很久以前说的话'.repeat(50) },
    { role: 'assistant', content: '很久以前的回答'.repeat(50) },
    { role: 'user', content: '我现在说的话' },
  ];
  const result = dropOldestToFit(messages, 500);
  assert.ok(result.messages.length < messages.length, '应丢弃旧消息');
  const last = result.messages[result.messages.length - 1];
  assert.equal(last?.content, '我现在说的话', '当前输入必须保留');
});

test('闲聊与正事走不同预算档', () => {
  const casual = budgetProfile('今天好累');
  const work = budgetProfile('帮我修复这个项目的输入框');
  assert.ok(casual.historyChars < work.historyChars, '闲聊历史预算应更省');
  assert.ok(casual.maxTokens < work.maxTokens, '闲聊输出上限应更省');
  assert.ok(casual.recentTurns < work.recentTurns, '闲聊轮数应更少');
});

test('正事判定：常见工作词能识别，日常闲聊不会误判', () => {
  assert.ok(isWorkRequest('帮我看看这个 bug'));
  assert.ok(isWorkRequest('运行一下测试'));
  assert.ok(!isWorkRequest('今天天气不错'));
  assert.ok(!isWorkRequest('在吗'));
  assert.ok(!isWorkRequest('我有点困'));
});

test('预算常量本身是合理的量级', () => {
  assert.ok(BUDGET.inputChars >= BUDGET.historyChars + BUDGET.memoryChars,
    '总预算应容得下历史与记忆');
  assert.ok(BUDGET.casualMaxTokens < BUDGET.replyMaxTokens,
    '闲聊档应比普通档省');
  assert.ok(BUDGET.memoryItemChars <= BUDGET.memoryChars);
});
