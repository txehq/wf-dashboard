import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { LiveDetail } from '../../src/live/views.js';
import { createWorkflows } from '../../src/workflows/index.js';
import { type LiveServer, startLiveServer, until } from './harness.js';

// Contracts 14.2、16.7：没有评测类型的 workflow 在 isolated 环境只建空的 workspace，初始消息为 /<workflow id> <问题>；
// variant 必须属于所选的 workflow。基础档 PATH 中的 claude 记下调用后退出，这里只看启动参数与工作目录
let server: LiveServer;
const created: string[] = [];

beforeAll(async () => {
  server = await startLiveServer();
}, 600_000);

afterAll(async () => {
  for (const id of created) {
    fs.rmSync(server.variants.layout(id).dir, { recursive: true, force: true });
  }
  await server.close();
});

test(
  'myreview（没有评测类型）：isolated 只建空的 workspace，初始消息 /myreview <问题>；别的 workflow 的 variant 400',
  { timeout: 600_000 },
  async () => {
    const workflows = createWorkflows({ db: server.db, variants: server.variants });
    // 从空白新建：第一个 variant"初稿"是骨架，用自有管理器构建（Contracts 18.5、18.6）
    workflows.create({
      id: 'myreview',
      name: '我的 review',
      description: '',
      definition: {
        id: 'myreview',
        name: '我的 review',
        stages: [{ id: 'scan' }, { id: 'fix', repeatable: true, allowInside: ['scan'] }],
      },
    });
    const variant = server.variants.list().find((v) => v.workflowId === 'myreview');
    if (variant === undefined) throw new Error('myreview 没有 variant');
    created.push(variant.id);
    await server.variants.build(variant.id);

    const wrong = await server.request('POST', '/api/live', {
      workflow: 'myreview',
      input: '审一下这个仓库',
      variantId: server.variant.id,
      environment: 'isolated',
      cwd: null,
      driver: 'human',
    });
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.text)).toMatchObject({
      message: `variant ${server.variant.name} 属于 workflow lfg，不是 myreview 的 variant`,
    });

    const live = await server.api<LiveDetail>('POST', '/api/live', {
      workflow: 'myreview',
      input: '审一下这个仓库',
      variantId: variant.id,
      environment: 'isolated',
      cwd: null,
      driver: 'human',
    });
    const done = await until('进程退出', 30_000, async () => {
      const d = await server.detail(live.id);
      return d.status === 'exited' ? d : null;
    });
    expect(done.workflow).toBe('myreview');
    expect(done.title).toBe('/myreview 审一下这个仓库');
    expect(done.repo).toBeNull();
    const start = done.events.find((e) => e.kind === 'start')?.payload;
    expect(start?.initial).toBe('/myreview 审一下这个仓库');
    expect(start?.argv).toEqual(expect.arrayContaining(['/myreview 审一下这个仓库']));
    // 空的 workspace：没有副本仓库
    expect(done.cwd.endsWith(path.join(live.id, 'workspace'))).toBe(true);
    expect(fs.readdirSync(done.cwd)).toEqual([]);
  },
);
