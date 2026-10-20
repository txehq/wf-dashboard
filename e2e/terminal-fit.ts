import { expect, type Page } from './test.js';

// 终端的最后一行完整可见（W80）。替身命令在 STAND_IN_STATUS_LINE=1 时整屏重画，最后一行是
// `底部状态行 <列>x<行>`（尺寸是替身从 PTY 读到的）：
// - 前端 xterm.js 的行数与 PTY 的行数相同，最后一行就是状态行；
// - 最后一行的底边在终端容器（xterm.js 按它算行数，超出的部分被裁掉）、窗口之内，底边上方一像素处最上面的是这个终端；
// - 页面没有滚动条。
// 窗口与布局变化后，终端在下一帧重新计算行数，PTY 收到新尺寸后替身重画：等到全部成立
export async function expectLastRowVisible(page: Page) {
  const terminal = page.getByTestId('live-terminal');
  await expect(terminal).toHaveAttribute('data-connection', 'open');
  await expect(async () => {
    const state = await terminal.evaluate((container) => {
      const rows = [...container.querySelectorAll('.xterm-rows > div')];
      const row = rows.at(-1);
      const xterm = container.querySelector('.xterm');
      if (row === undefined || xterm === null) throw new Error('终端还没有行');
      const box = row.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + 4, box.bottom - 1);
      const scroller = document.scrollingElement;
      if (scroller === null) throw new Error('没有 scrollingElement');
      return {
        frontRows: rows.length,
        lastText: row.textContent.replaceAll(' ', ' '),
        rowBottom: box.bottom,
        containerBottom: container.getBoundingClientRect().bottom,
        windowBottom: window.innerHeight,
        // 行所在的一层不参与命中：这一点最上面的是这个终端（xterm-screen），没有被别的元素盖住或裁掉
        covered: xterm.contains(hit) ? null : (hit?.outerHTML.slice(0, 120) ?? 'nothing'),
        pageOverflow: scroller.scrollHeight - scroller.clientHeight,
      };
    });
    const m = /底部状态行 \d+x(\d+)/.exec(state.lastText);
    expect(m?.[1], `最后一行：${state.lastText}`).toBe(String(state.frontRows));
    expect(state.rowBottom).toBeLessThanOrEqual(state.containerBottom);
    expect(state.rowBottom).toBeLessThanOrEqual(state.windowBottom);
    expect(state.covered).toBeNull();
    expect(state.pageOverflow).toBe(0);
  }).toPass({ timeout: 5000 });
}
