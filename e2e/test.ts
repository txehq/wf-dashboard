import { test as base } from '@playwright/test';

// 其余导出与 @playwright/test 相同；test 换成下面带检查的一个
export * from '@playwright/test';

// React 在开发模式下把列表 key 的问题写到浏览器控制台：重复的 key 会让兄弟元素被合并或重复渲染。
// 每个用例的浏览器上下文中出现这类报错时用例失败（所有 e2e 都从这里导入 test，eslint 禁止直接用 @playwright/test 的 test）
const reactKeyError =
  /Encountered two children with the same key|Each child in a list should have a unique "key" prop/;

export const test = base.extend<{ reactKeyErrors: undefined }>({
  reactKeyErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      context.on('console', (message) => {
        if (message.type() === 'error' && reactKeyError.test(message.text())) {
          errors.push(`${message.page()?.url() ?? '(没有页面)'}：${message.text()}`);
        }
      });
      await use(undefined);
      if (errors.length > 0) {
        throw new Error(`浏览器控制台有 React key 报错：\n${errors.join('\n')}`);
      }
    },
    { auto: true },
  ],
});
