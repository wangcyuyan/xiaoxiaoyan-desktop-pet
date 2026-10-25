import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDataLines,
  extractDelta,
  extractError,
  isSseResponse,
  SseParser,
} from '../../src/main/companion/sse';

/**
 * SSE 解析回归测试。
 *
 * 背景：桌宠原本只支持非流式 JSON。为了连本机 DSH 桥接
 * （只提供 SSE），加了流式解析 —— 这部分必须单独测透，
 * 因为流式响应的边界情况很多：分片、注释行、[DONE]、错误帧。
 */

test('提取 data 行：忽略注释行与非 data 行', () => {
  const chunk = [
    ': 这是注释',
    'event: message',
    'data: {"a":1}',
    '',
    'data: {"b":2}',
  ].join('\n');
  assert.deepEqual(extractDataLines(chunk), ['{"a":1}', '{"b":2}']);
});

test('data 后的单个空格要去掉', () => {
  assert.deepEqual(extractDataLines('data:{"x":1}'), ['{"x":1}']);
  assert.deepEqual(extractDataLines('data: {"x":1}'), ['{"x":1}']);
});

test('提取增量文本：chat.completion.chunk 形状', () => {
  const frame = { choices: [{ index: 0, delta: { content: '你好' } }] };
  assert.equal(extractDelta(frame), '你好');
});

test('提取增量文本：兼容 text 字段', () => {
  assert.equal(extractDelta({ choices: [{ text: 'abc' }] }), 'abc');
});

test('没有文本的帧返回空串', () => {
  assert.equal(extractDelta({ choices: [{ delta: {} }] }), '');
  assert.equal(extractDelta({ choices: [] }), '');
  assert.equal(extractDelta(null), '');
  assert.equal(extractDelta('not-an-object'), '');
});

test('提取错误信息', () => {
  assert.equal(extractError({ error: { message: 'boom' } }), 'boom');
  assert.equal(extractError({ choices: [{ error: { message: 'bad' } }] }), 'bad');
  assert.equal(extractError({ choices: [{ delta: { content: 'x' } }] }), undefined);
});

test('Content-Type 判定 SSE', () => {
  assert.equal(isSseResponse('text/event-stream'), true);
  assert.equal(isSseResponse('text/event-stream; charset=utf-8'), true);
  assert.equal(isSseResponse('application/json'), false);
  assert.equal(isSseResponse(null), false);
});

test('解析器：多帧累积成完整文本', () => {
  const parser = new SseParser();
  parser.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
  parser.push('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
  assert.equal(parser.text, '你好');
  assert.equal(parser.isFinished, false);
});

test('解析器：收到 [DONE] 即结束', () => {
  const parser = new SseParser();
  parser.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  parser.push('data: [DONE]\n\n');
  assert.equal(parser.isFinished, true);
  assert.equal(parser.done, true);
  assert.equal(parser.text, 'hi');
});

test('解析器：分片到达时先缓存半行', () => {
  const parser = new SseParser();
  // 第一片只到一半，没有换行
  parser.push('data: {"choices":[{"delta":{"cont');
  assert.equal(parser.text, '', '不完整的行不应产出文本');
  // 第二片补完
  parser.push('ent":"好"}}]}\n\n');
  assert.equal(parser.text, '好');
});

test('解析器：遇到错误帧记录错误但继续解析', () => {
  const parser = new SseParser();
  parser.push('data: {"error":{"message":"上游炸了"}}\n\n');
  assert.equal(parser.error, '上游炸了');
});

test('解析器：非法 JSON 的 data 行被忽略（心跳等）', () => {
  const parser = new SseParser();
  parser.push('data: ping\n\n');
  parser.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  assert.equal(parser.error, undefined);
  assert.equal(parser.text, 'ok');
});

test('解析器：flush 处理末尾没有换行的残留', () => {
  const parser = new SseParser();
  parser.push('data: {"choices":[{"delta":{"content":"尾巴"}}]}');
  assert.equal(parser.text, '', '还没 flush 应为空');
  parser.flush();
  assert.equal(parser.text, '尾巴');
});

test('解析器：结束后不再接受新数据', () => {
  const parser = new SseParser();
  parser.push('data: [DONE]\n\n');
  parser.push('data: {"choices":[{"delta":{"content":"多的"}}]}\n\n');
  assert.equal(parser.text, '');
});
