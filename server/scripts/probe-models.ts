import { z } from 'zod';
import { models, parseStructured } from '../src/llm/client.js';

// 检查 gateway 上三个默认模型当前是否可用：tsx scripts/probe-models.ts
for (const role of ['simulatedUser', 'judge', 'stageCheck'] as const) {
  const model = models[role];
  const started = performance.now();
  const result = await parseStructured({
    model,
    system: '只输出 JSON。',
    user: '回答 {"ok": true}',
    schema: z.object({ ok: z.boolean() }),
    maxTokens: 64,
  });
  const ms = Math.round(performance.now() - started);
  console.log(role, model, JSON.stringify(result.value), `${String(ms)}ms`);
}
