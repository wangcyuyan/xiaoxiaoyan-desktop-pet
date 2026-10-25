import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentHeartbeatSlot, HEARTBEAT_SLOTS, localDateKey } from '../../src/main/companion/persona';

test('心跳去重：key 格式为 日期:slotId 时能正确拦截', () => {
  const today = localDateKey();
  const fired = new Set<string>();
  const now = new Date();
  now.setHours(10, 15, 0, 0); // 上午时段

  const first = currentHeartbeatSlot(now, fired, today);
  assert.ok(first, '第一次应该能触发');
  assert.equal(first.id, 'morning');

  // 引擎的存法：日期:slotId
  fired.add(`${today}:${first.id}`);

  const second = currentHeartbeatSlot(now, fired, today);
  assert.equal(second, undefined, '修复后：已触发的时段不应再次返回');
});

test('心跳去重：不同日期互不影响', () => {
  const fired = new Set<string>();
  fired.add('2026-10-23:morning');
  const now = new Date();
  now.setHours(10, 15, 0, 0);
  const slot = currentHeartbeatSlot(now, fired, '2026-10-24');
  assert.ok(slot, '换一天应该能再次触发');
  assert.equal(slot.id, 'morning');
});

test('心跳时段共 7 个且都有合理的时间', () => {
  assert.equal(HEARTBEAT_SLOTS.length, 7);
  const ids = HEARTBEAT_SLOTS.map((slot) => slot.id);
  assert.deepEqual(ids, ['dawn', 'morning', 'noon', 'afternoon', 'evening', 'night', 'late']);
  for (const slot of HEARTBEAT_SLOTS) {
    assert.ok(slot.hour >= 0 && slot.hour <= 23, `${slot.id} 小时越界`);
    assert.ok(slot.minute >= 0 && slot.minute <= 59, `${slot.id} 分钟越界`);
  }
});

test('深夜时段跨天：凌晨能命中 late', () => {
  const fired = new Set<string>();
  const d = new Date();
  d.setHours(2, 0, 0, 0);
  const slot = currentHeartbeatSlot(d, fired, localDateKey(d));
  assert.ok(slot, '凌晨应命中某个时段');
  assert.equal(slot.id, 'late');
});

test('本地日期 key 格式正确', () => {
  const key = localDateKey(new Date(2026, 9, 23));
  assert.equal(key, '2026-10-23');
});

test('90 分钟窗口外的时段不误触发', () => {
  const fired = new Set<string>();
  // 下午 18:05 —— 下午时段（16:20）的窗口是 90 分钟，此时已过
  const d = new Date();
  d.setHours(18, 5, 0, 0);
  const slot = currentHeartbeatSlot(d, fired, localDateKey(d));
  // 18:05 距离 16:20 是 105 分钟，超窗；距离 19:00 还没到
  assert.equal(slot, undefined, '窗口外不应触发');
});
