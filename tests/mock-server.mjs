// Mock OpenAI 兼容服务器：验证伴侣模块的完整闭环（不消耗真实额度）
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    console.log(`[MOCK] ${req.method} ${req.url}`);
    console.log(`[MOCK] model=${parsed.model} messages=${parsed.messages?.length} effort=${parsed.reasoning_effort}`);
    const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    console.log(`[MOCK] 用户输入: ${lastUser.slice(0, 60)}`);
    const reply = `（Mock回复）我收到了你说「${lastUser.slice(0, 20)}」。`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-1',
      model: parsed.model ?? 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 64 },
    }));
  });
});

server.listen(18777, () => console.log('[MOCK] 监听 http://127.0.0.1:18777'));
