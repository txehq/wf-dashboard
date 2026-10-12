import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, expect, test } from 'vitest';
import { sessionsRoutes } from '../src/api/sessions.js';
import { displayUserText, sessionTitle } from '../src/api/user-text.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { writeSessionPrefix } from './helpers/session-prefix.js';
import { SAMPLES } from './stages/samples.js';

// 真实 session：dashboard 发起的 ic run（首条用户消息是 /ic TXE-3764 的 slash 命令），
// 以及 f0aca373 中途以 /superpowers:brainstorming 带多行参数开始一段：只取到这条消息（第 595 行）与之后的
// 第一条回复为止（37 MB 中的前 1.7 MB）
const icRun = path.join(
  config.repoRoot,
  'server/test/fixtures/runs/40f6915a-cd31-4312-866c-dcb377515c42.jsonl',
);
const brainstormArgs = '你觉得这个lfg的skill如何';
const workDir = path.join(config.repoRoot, '.work', 'test-user-text', randomUUID());
const projectsDir = path.join(workDir, 'projects');
const slug = '-eval-run';
mkdirSync(path.join(projectsDir, slug), { recursive: true });
cpSync(icRun, path.join(projectsDir, slug, path.basename(icRun)));
writeSessionPrefix(SAMPLES.icPrs, path.join(projectsDir, slug), brainstormArgs);

const db = openDatabase(path.join(workDir, 'db.sqlite'), config.migrationsDir);
const app = Fastify();
await app.register(sessionsRoutes, {
  prefix: '/api',
  db,
  dirs: { projectsDir, variantsDir: path.join(workDir, 'variants') },
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function get<T>(url: string) {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

test('slash 命令的标记显示为命令名加参数', () => {
  const lfg =
    '<command-message>lfg</command-message>\n<command-name>/lfg</command-name>\n<command-args>做一个计算器\n\nProduct: Magi Eval</command-args>';
  expect(displayUserText(lfg)).toBe('/lfg 做一个计算器\n\nProduct: Magi Eval');
  expect(sessionTitle(lfg)).toBe('/lfg 做一个计算器');
  // 参数为空的命令只显示命令名
  expect(
    displayUserText(
      '<command-message>skills</command-message>\n            <command-name>/skills</command-name>\n            <command-args></command-args>',
    ),
  ).toBe('/skills');
  // 普通消息与只是提到标记的消息不变
  expect(displayUserText('读一下这个项目')).toBe('读一下这个项目');
  const mention = '标题里出现 <command-name>/lfg</command-name> 这样的标记';
  expect(displayUserText(mention)).toBe(mention);
});

test('列表标题与请求明细中的用户条目（真实 session）', async () => {
  const put = await app.inject({
    method: 'PUT',
    url: '/api/sources',
    payload: { paths: [path.join(projectsDir, slug)] },
  });
  expect(put.json()).toMatchObject({ imported: { files: 2, changedSessions: 2 } });
  const { sessions } = await get<{ sessions: { id: string; title: string | null }[] }>(
    '/api/sessions',
  );
  const ic = sessions.find((s) => s.id === path.basename(icRun, '.jsonl'));
  expect(ic?.title).toBe('/ic TXE-3764');

  const { items } = await get<{ items: { kind: string; text?: string }[] }>(
    `/api/sessions/${path.basename(icRun, '.jsonl')}/requests`,
  );
  expect(items.find((i) => i.kind === 'user')?.text).toBe('/ic TXE-3764');

  const f0 = await get<{ items: { kind: string; text?: string }[] }>(
    `/api/sessions/${path.basename(SAMPLES.icPrs, '.jsonl')}/requests`,
  );
  const brainstorm = f0.items.find(
    (i) => i.kind === 'user' && i.text?.startsWith('/superpowers:brainstorming '),
  );
  expect(brainstorm?.text).toContain(brainstormArgs);
  expect(f0.items.some((i) => i.kind === 'user' && i.text?.includes('<command-name>'))).toBe(false);
});
