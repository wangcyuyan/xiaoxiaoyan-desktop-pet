import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson, readValidatedJson } from '../../src/main/persistence';
import { parseSettings } from '../../src/main/data-validation';
import type { Settings } from '../../src/shared/contracts';

const defaults: Settings = {
  edgeSnap: true,
  alwaysOnTop: true,
  typingReaction: false,
  clickThrough: false,
  petScale: 1,
};

test('atomic JSON persistence round-trips without temporary files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-persistence-'));
  try {
    const file = path.join(directory, 'settings.json');
    await atomicWriteJson(file, defaults);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), defaults);
    assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid persisted data is backed up and defaults are restored', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-corrupt-'));
  try {
    const file = path.join(directory, 'settings.json');
    await writeFile(file, '{"edgeSnap":"yes"}', 'utf8');
    assert.deepEqual(await readValidatedJson(file, defaults, parseSettings), defaults);
    const names = await readdir(directory);
    assert.equal(names.includes('settings.json'), false);
    assert.equal(names.some((name) => name.startsWith('settings.json.') && name.endsWith('.corrupt')), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing persistence files use defaults without a corrupt backup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-missing-'));
  try {
    const file = path.join(directory, 'settings.json');
    assert.deepEqual(await readValidatedJson(file, defaults, parseSettings), defaults);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('v2 设置字段（气泡字号/不透明度/锁位/TTS/快捷键）：旧存档不带也能读，带了必须合法', () => {
  // 旧存档（v1 字段）—— 不带新字段，解析成功且不产生新键
  const legacy = parseSettings({ ...defaults });
  assert.equal('bubbleScale' in legacy, false);
  assert.equal('lockPosition' in legacy, false);

  // 新字段全部合法
  const modern = parseSettings({
    ...defaults,
    bubbleScale: 1.5,
    windowOpacity: 0.6,
    lockPosition: true,
    ttsEnabled: true,
    hotkeyChatEnabled: false,
  });
  assert.equal(modern.bubbleScale, 1.5);
  assert.equal(modern.windowOpacity, 0.6);
  assert.equal(modern.lockPosition, true);
  assert.equal(modern.ttsEnabled, true);
  assert.equal(modern.hotkeyChatEnabled, false);

  // 边界外一律拒绝
  assert.throws(() => parseSettings({ ...defaults, bubbleScale: 0.2 }), /bubbleScale/);
  assert.throws(() => parseSettings({ ...defaults, bubbleScale: 4 }), /bubbleScale/);
  assert.throws(() => parseSettings({ ...defaults, windowOpacity: 0.05 }), /windowOpacity/);
  assert.throws(() => parseSettings({ ...defaults, lockPosition: 'yes' }), /lockPosition/);
});
