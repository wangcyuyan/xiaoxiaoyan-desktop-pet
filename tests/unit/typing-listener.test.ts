import test from 'node:test';
import assert from 'node:assert/strict';
import { TypingListener } from '../../src/main/typing-listener';

function hasUiohook(): boolean {
  try {
    require('uiohook-napi');
    return true;
  } catch {
    return false;
  }
}

test('typing listener reports disabled settings explicitly', () => {
  const listener = new TypingListener();
  assert.deepEqual(listener.start(false, () => {}), { enabled: false, reason: 'disabled-by-settings' });
  listener.stop();
});

test('typing listener enables when native provider is available, fails closed otherwise', () => {
  const listener = new TypingListener();
  const status = listener.start(true, () => {});
  if (hasUiohook()) {
    assert.equal(status.enabled, true);
    assert.equal(status.reason, 'ok');
  } else {
    assert.deepEqual(status, { enabled: false, reason: 'not-available' });
  }
  listener.stop();
});
