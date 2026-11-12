import { z } from 'zod';
import { models, parseStructured } from '../src/llm/client.js';

// Check whether the default models of both roles are currently available on the gateway: tsx scripts/probe-models.ts
for (const role of ['simulatedUser', 'judge'] as const) {
  const model = models[role];
  const started = performance.now();
  const result = await parseStructured({
    model,
    system: 'Output JSON only.',
    user: 'Answer {"ok": true}',
    schema: z.object({ ok: z.boolean() }),
    maxTokens: 64,
  });
  const ms = Math.round(performance.now() - started);
  console.log(role, model, JSON.stringify(result.value), `${String(ms)}ms`);
}
