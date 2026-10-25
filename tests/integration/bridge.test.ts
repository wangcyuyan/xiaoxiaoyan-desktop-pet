import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBridgeModel } from '../../src/main/companion/bridge';

/**
 * 桥接模型选择回归测试。
 *
 * 背景：桌宠接本机 DSH 桥接后，模型列表里带 provider 前缀
 * （如 "trae/deepseek-v4.1-flash"）。
 *
 * v1.1.2 起策略为「智力优先」：Trae 通道（零成本）内 Pro 档先于
 * Flash 档 —— 用户实测反馈 Flash 轻量档明显降智，且 Pro 走积分
 * 同样零成本，智力体验优先于省积分。
 */

test('Trae 通道内没有 Pro 时才挑 Flash', () => {
  const models = [
    'deepseek-official/deepseek-v4-pro',
    'trae/deepseek-v4.1-flash',
    'trae/glm-5.2',
  ];
  assert.equal(pickBridgeModel(models), 'trae/deepseek-v4.1-flash');
});

test('有 Pro 时挑 Pro（智力优先，含大小写不敏感）', () => {
  const models = ['deepseek-official/deepseek-flash-x', 'deepseek-official/deepseek-v4-pro'];
  assert.equal(pickBridgeModel(models), 'deepseek-official/deepseek-v4-pro');
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
