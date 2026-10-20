import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './test.js';
import { e2eVaultDir } from './vault.js';

// 环境检查的 vault 一项写出位置与来源（Contracts 第 30 节）：e2e 的服务端以 MAGI_VAULT=.work/e2e/vault 启动
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

test('环境检查中 vault 一项写出路径与来源', async ({ page }) => {
  fs.mkdirSync(path.join(e2eVaultDir, 'Project Magi Eval'), { recursive: true });
  await page.goto('/sessions');
  const status = page.getByTestId('environment-status');
  await expect(status).toHaveText(/环境：|环境检查失败/, { timeout: 60_000 });
  await status.click();
  const dialog = page.getByTestId('environment-dialog');
  // 绕过缓存：上面建出的 Project Magi Eval/ 计入这次检查
  const recheck = dialog.getByRole('button', { name: '重新检查' });
  await recheck.click();
  await expect(recheck).toBeEnabled({ timeout: 60_000 });
  const vault = dialog.getByTestId('env-check-vault');
  await expect(vault.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await vault.getByRole('button').click();
  await expect(vault.getByTestId('env-detail')).toHaveText(
    new RegExp(
      `^${e2eVaultDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（来自 MAGI_VAULT），Project Magi Eval/ 可写，Features/ 下 \\d+ 个目录$`,
    ),
  );
  for (const size of sizes) {
    await page.setViewportSize(size);
    await vault.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `.work/screenshots/w93-env-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
});
