// 评分用的 vitest 配置：由 dashboard 放在 checkout 之外，checkout 中的 vite / vitest 配置与 setupFiles 都不加载；
// 命令在 checkout 中运行，root 取当前目录，JUnit 的 classname 才是相对 checkout 根目录的路径
export default {
  root: process.cwd(),
  test: {
    include: ['test/hidden/**/*.hidden.test.{js,ts}'],
  },
};
