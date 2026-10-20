---
tags: [magi-eval, research]
created: 2026-10-09
---

# Research：课堂用的网页计算器

依据 [[Brief]]。

## 1. 表达式求值

| 做法 | 说明 | 结论 |
|---|---|---|
| `eval` / `Function` | 直接执行字符串，浮点误差与安全问题都在 | 不用 |
| 手写调度场算法 | 优先级与括号可控，但要自己处理百分号、一元负号 | 备选 |
| `mathjs` | 成熟的表达式解析，支持 `BigNumber` 配置 | **采用** |

浮点数：IEEE 754 双精度无法精确表示 0.1，`0.1 + 0.2 === 0.30000000000000004`（MDN Number 文档）。mathjs 设置 `number: 'BigNumber'` 后用 decimal.js 计算。

## 2. 离线

mathjs 以 npm 包引入，用 Vite 打包进本地文件，不走 CDN。mathjs 为 Apache-2.0 许可。

## 3. 拆分

1. 求值核心：解析、计算、错误位置。测试：单元测试覆盖四则、括号、百分号、乘方、平方根。
2. 界面：屏幕按钮与键盘输入。
3. 历史记录：localStorage。
4. 投影模式。

## 4. 风险

- 浮点精度：用 BigNumber 解决。
