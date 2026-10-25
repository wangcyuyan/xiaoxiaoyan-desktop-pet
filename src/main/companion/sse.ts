/**
 * OpenAI 兼容流式响应（SSE）解析
 *
 * 背景：
 *   桌宠原本只支持非流式的 JSON 响应（`choices[0].message.content`）。
 *   但走本机 DSH 桥接时，对端只提供 SSE（Server-Sent Events，服务器推送事件流）
 *   —— 逐块推送 `data: {...}`，最后以 `data: [DONE]` 收尾。
 *
 *   这一模块把 SSE 还原成完整文本。
 *
 * SSE 格式要点：
 *   - 事件之间用空行分隔
 *   - 每行以 `data: ` 开头（冒号后可有一个空格）
 *   - 注释行以 `:` 开头，直接忽略
 *   - 多行 data 会被拼起来（用 \n 连接）
 *   - `[DONE]` 表示流结束
 */

/**
 * 从一段 SSE 文本里取出所有 data 负载。
 * @returns 数组，元素是 data 行的内容（`[DONE]` 也包含在内）
 */
export function extractDataLines(chunk: string): string[] {
  const results: string[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    // 注释行与事件名行都不是数据
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    // "data:" 后可有一个空格，去掉它
    let payload = line.slice(5);
    if (payload.startsWith(' ')) payload = payload.slice(1);
    results.push(payload);
  }
  return results;
}

/**
 * 从一个 OpenAI SSE 帧里取出增量文本。
 *
 * 支持两种形状：
 *   1. chat.completion.chunk —— `choices[0].delta.content`
 *   2. 兼容式 —— `choices[0].text`
 *
 * @returns 增量文本；该帧没有文本时返回空串
 */
export function extractDelta(frame: unknown): string {
  if (typeof frame !== 'object' || frame === null) return '';
  const choices = (frame as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const choice = choices[0] as { delta?: { content?: unknown }; text?: unknown };
  const deltaContent = choice.delta?.content;
  if (typeof deltaContent === 'string') return deltaContent;
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

/**
 * 从一个 OpenAI SSE 帧里取出错误信息（若有）。
 */
export function extractError(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined;
  const error = (frame as { error?: { message?: unknown } }).error;
  if (error && typeof error.message === 'string') return error.message;
  const choices = (frame as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as { error?: { message?: unknown } };
    if (choice.error && typeof choice.error.message === 'string') return choice.error.message;
  }
  return undefined;
}

/**
 * 增量解析 SSE 流。
 *
 * 用法：
 *   const parser = new SseParser();
 *   for await (const chunk of response.body) {
 *     const { text, error, done } = parser.push(decoder.decode(chunk, { stream: true }));
 *     if (text) accumulate(text);
 *     if (error) throw new Error(error);
 *     if (done) break;
 *   }
 */
export class SseParser {
  private buffer = '';
  private finished = false;

  /** 本次推送产出的完整文本 */
  text = '';
  /** 本次推送发现的错误 */
  error: string | undefined;
  /** 流是否已结束 */
  done = false;

  /**
   * 喂入一段原始数据。
   * @returns 本次新增的文本（累积到 this.text）
   */
  push(chunk: string): string {
    if (this.finished) return '';
    this.buffer += chunk;

    // 只处理完整的行，末尾可能是不完整的半行，留到下次
    const lastNewline = this.buffer.lastIndexOf('\n');
    if (lastNewline < 0) return '';
    const consumable = this.buffer.slice(0, lastNewline);
    this.buffer = this.buffer.slice(lastNewline + 1);

    let delta = '';
    for (const payload of extractDataLines(consumable)) {
      if (payload === '[DONE]') {
        this.finished = true;
        this.done = true;
        continue;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(payload);
      } catch {
        // 不是合法 JSON 的数据行，忽略（心跳、注释等）
        continue;
      }
      const error = extractError(frame);
      if (error !== undefined) {
        this.error = error;
        continue;
      }
      delta += extractDelta(frame);
    }

    this.text += delta;
    return delta;
  }

  /** 流是否已经收到 [DONE] */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * 收尾：处理残留缓冲（某些服务端最后一行不带换行）。
   */
  flush(): string {
    if (this.finished || this.buffer.length === 0) return '';
    const payload = extractDataLines(this.buffer);
    this.buffer = '';
    let delta = '';
    for (const item of payload) {
      if (item === '[DONE]') {
        this.finished = true;
        this.done = true;
        continue;
      }
      try {
        const frame = JSON.parse(item);
        const error = extractError(frame);
        if (error !== undefined) {
          this.error = error;
          continue;
        }
        delta += extractDelta(frame);
      } catch {
        // 忽略
      }
    }
    this.text += delta;
    return delta;
  }
}

/**
 * 判断一个响应体是否 SSE 流。
 * 通过 Content-Type 判断。
 */
export function isSseResponse(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes('text/event-stream');
}
