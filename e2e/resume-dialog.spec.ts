import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { z } from 'zod';
import { sessionLines } from '../server/test/helpers/session-copies.js';
import { resumeDialogDir, resumeDialogHome, resumeDialogProjectsDir } from './services.js';

// resume 对话框（Contracts 14.5）：打开时就说明将要做什么。四个 session 都在同一个来源目录中，以"本机配置"resume；
// 目标配置是服务端的 WFD_LOCAL_HOME（.work/ 下）。claude 是基础档会报错的替身，进程立即退出
const source = path.join(resumeDialogProjectsDir, '-w49-resume');
const cwd = path.join(resumeDialogDir, 'cwd');
const shots = '.work/screenshots';
const extra = ['还记得暗号吗？', '记得，青蛙-47。'];

const ids = { copy: randomUUID(), sync: randomUUID(), diverged: randomUUID(), gone: randomUUID() };

// 目标配置（本机配置）中的另一份
function targetCopy(id: string, content: string) {
  const file = path.join(
    resumeDialogHome,
    '.claude',
    'projects',
    `l-old-${id.slice(0, 6)}`,
    `${id}.jsonl`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const Item = z.object({ id: z.string(), claudeSessionId: z.string() });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  for (const id of Object.values(ids)) {
    fs.writeFileSync(path.join(source, `${id}.jsonl`), sessionLines(id, cwd, extra));
  }
  targetCopy(ids.sync, sessionLines(ids.sync, cwd));
  targetCopy(
    ids.diverged,
    sessionLines(ids.diverged, cwd, ['换个话题：今天几号？', '今天是 10 月 13 日。']),
  );
  expect((await request.put('/api/sources', { data: { paths: [source] } })).status()).toBe(200);
  // 导入后再移走一份：session 文件不在了
  fs.renameSync(path.join(source, `${ids.gone}.jsonl`), path.join(resumeDialogDir, 'moved.jsonl'));
  const imported = await request.post('/api/live/import', {
    data: { sessionIds: Object.values(ids) },
  });
  expect(imported.status()).toBe(201);
});

async function openDialog(page: Page, sessionId: string) {
  const items = z.array(Item).parse(await (await page.request.get('/api/live')).json());
  const item = items.find((i) => i.claudeSessionId === sessionId);
  if (item === undefined) throw new Error(`session ${sessionId} 不在交互区`);
  await page.goto(`/live?item=${item.id}`);
  await page.getByTestId('live-idle').getByTestId('resume-open').click();
  const dialog = page.getByTestId('resume-dialog');
  await expect(dialog.getByTestId('resume-variant')).toHaveValue('local');
  return dialog;
}

test('打开时说明将要做什么：复制、先同步最新内容、分叉时两个按钮、不能 resume 的原因；没有原始的 409 文字', async ({
  page,
}) => {
  const copy = await openDialog(page, ids.copy);
  await expect(copy.getByTestId('resume-plan')).toHaveAttribute('data-action', 'copy');
  await expect(copy.getByTestId('resume-plan')).toContainText('先把 session 复制进这个配置');
  // 本机配置不传 model 与 effort：不显示这两项
  await expect(copy.getByTestId('resume-model')).toHaveCount(0);
  await expect(copy.getByTestId('resume-confirm')).toBeEnabled();
  await copy.getByRole('button', { name: '取消' }).click();

  const sync = await openDialog(page, ids.sync);
  await expect(sync.getByTestId('resume-plan')).toHaveAttribute('data-action', 'sync');
  await expect(sync.getByTestId('resume-plan')).toContainText('先用最新的内容覆盖它');
  await expect(sync.getByTestId('resume-confirm')).toBeEnabled();
  await page.screenshot({ path: `${shots}/w49-plan-sync.png` });
  await sync.getByRole('button', { name: '取消' }).click();

  const diverged = await openDialog(page, ids.diverged);
  const plan = diverged.getByTestId('resume-plan');
  await expect(plan).toHaveAttribute('data-action', 'diverged');
  await expect(plan).toContainText('记得，青蛙-47。');
  await expect(plan).toContainText('今天是 10 月 13 日。');
  await expect(diverged.getByTestId('resume-use-latest')).toHaveText('以最新的为准继续');
  await expect(diverged.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(diverged.getByTestId('resume-confirm')).toHaveCount(0);
  await page.screenshot({ path: `${shots}/w49-plan-diverged.png` });
  await diverged.getByRole('button', { name: '取消' }).click();

  const gone = await openDialog(page, ids.gone);
  await expect(gone.getByTestId('resume-plan')).toHaveAttribute('data-action', 'blocked');
  await expect(gone.locator('[data-problem="file-missing"]')).toContainText('已经不在了');
  await expect(gone.getByTestId('resume-confirm')).toBeDisabled();
  await expect(gone).not.toContainText('409');
  await expect(gone).not.toContainText('已从');
  await page.screenshot({ path: `${shots}/w49-plan-blocked.png` });
});

test('分叉时"以最新的为准继续"：这个配置中的那份改名保留，再接着运行', async ({ page }) => {
  const dialog = await openDialog(page, ids.diverged);
  await dialog.getByTestId('resume-use-latest').click();
  await expect(dialog).toHaveCount(0);
  const kept = fs
    .readdirSync(
      path.join(resumeDialogHome, '.claude', 'projects', `l-old-${ids.diverged.slice(0, 6)}`),
    )
    .filter((f) => f.startsWith(`${ids.diverged}.jsonl.diverged-`));
  expect(kept).toHaveLength(1);
});
