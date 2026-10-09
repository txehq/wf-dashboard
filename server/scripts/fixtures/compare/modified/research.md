---
tags: [magi-eval, research]
created: 2026-10-09
---

# Research：课堂用的网页计算器

依据 [[Brief]]。每条建议附出处。

## 1. 表达式求值与十进制计算

| 做法 | 说明 | 结论 |
|---|---|---|
| `eval` / `Function` | 执行任意字符串；浮点误差 | 不用 |
| 手写调度场算法 + `decimal.js` | 优先级、一元负号、百分号、√ 都可控；错误位置可以精确到字符 | **采用** |
| `mathjs`（BigNumber 模式） | 功能全，但包体 170 KB（min+gz），错误位置只给到 token | 备选 |

为什么不能用浮点数：IEEE 754 双精度无法精确表示 0.1（MDN, *Number — Number encoding*）；`0.1 + 0.2` 得到 `0.30000000000000004`。`decimal.js` 按十进制运算，`Decimal.set({ precision: 20, rounding: ROUND_HALF_UP })` 后再按 10 位小数与 12 位有效数字格式化（decimal.js API 文档 `toSignificantDigits`、`toDecimalPlaces`）。

## 2. 离线与许可证

- `decimal.js` 以 npm 包引入，Vite 构建时打进 `dist/assets/*.js`；构建产物不引用任何外部 URL（`vite build` 的 `build.assetsInlineLimit` 与 `base: './'` 让 `index.html` 可以直接双击打开）。
- 许可证：decimal.js 为 MIT（仓库 LICENCE.md）。
- 字体用系统字体（微软雅黑），不加载网络字体。

## 3. Windows 7 上的 Chrome 109

- Chrome 109 是支持 Windows 7 的最后一个版本（Google Chrome 帮助中心公告，2023-01）。
- Vite 默认构建目标是 `baseline-widely-available`，包含 Chrome 109 之后的语法；设置 `build.target: ['chrome109']`（Vite 文档 *build.target*）。
- 验证：在 Chrome 109 便携版中打开 `dist/index.html`。

## 4. 投影可读性

- 投影距离 8–10 米时正文至少 32px，结果区 64px 以上（W3C *Making Content Usable*；学校多媒体教室设计规范）。
- 投影模式切换 `font-size` 根变量，所有尺寸用 `rem`，按钮同步放大。

## 5. 拆分

| 部分 | 内容 | 测试计划 | 验收 |
|---|---|---|---|
| 求值核心 | 词法、解析、十进制计算、格式化、错误位置 | Vitest 单元测试 + 老师的 10 道题 | 10 道题全对 |
| 界面与键盘 | 按钮、键盘、算式显示、错误高亮 | Playwright | 按钮与键盘都能完成 10 道题 |
| 历史记录 | 最近 20 条，localStorage，清空 | Playwright（刷新后检查） | 刷新后仍在，清空后为空 |
| 投影模式 | 根字号切换 | Playwright 截图 | 字号放大 2 倍 |

## 6. 风险

- 浮点精度：全部运算走 decimal.js，格式化集中在一处。
- 旧版浏览器兼容：构建目标固定 chrome109，CI 中用 Chrome 109 跑一次 e2e。
- 离线：CI 检查构建产物中不出现 `http://` 或 `https://`。
