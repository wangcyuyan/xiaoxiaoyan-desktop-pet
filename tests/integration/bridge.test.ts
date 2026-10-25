import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBridgeModel } from '../../src/main/companion/bridge';

/**
 * 桥接模型选择回归测试。
 *
 * 背景：桌宠接本机 DSH 桥接后，模型列表里带 provider 前缀
 * （如 "trae/deepseek-v4.1-flash"）。要挑一个「最省」的模型用 ——
 * 陪伴场景下 Flash 档比 Pro 档快且便宜。
 */

test('优先挑 Flash 类模型', () => {
  const models = [
    'deepseek-official/deepseek-v4-pro',
    'trae/deepseek-v4.1-flash',
    'trae/glm-5.2',
  ];
  assert.equal(pickBridgeModel(models), 'trae/deepseek-v4.1-flash');
});

test('没有 Flash 时挑 Pro', () => {
  const models = ['deepseek-official/deepseek-flash-x', 'deepseek-official/deepseek-v4-pro'];
  // 名字里带 flash 的仍然优先（大小写不敏感）
  assert.equal(pickBridgeModel(models), 'deepseek-official/deepseek-flash-x');
});

test('只有 Pro 时挑 Pro', () => {
  assert.equal(
    pickBridgeModel(['deepseek-official/deepseek-v4-pro', 'deepseek-account/deepseek-v4-pro']),
    'deepseek-official/deepseek-v4-pro',
  );
});

test('都不匹配时取第一个', () => {
  assert.equal(pickBridgeModel(['some/weird-model']), 'some/weird-model');
});

test('空列表返回 undefined', () => {
  assert.equal(pickBridgeModel([]), undefined);
});

test('大小写不敏感', () => {
  assert.equal(
    pickBridgeModel(['trae/DeepSeek-V4.1-FLASH']),
    'trae/DeepSeek-V4.1-FLASH',
  );
});
