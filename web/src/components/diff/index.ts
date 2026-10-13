// 共用的 diff 显示（Contracts 21.3）：分析报告的修改建议、variant 页面的对比、Codex 保存前的改动预览
export { DiffCounts, DiffFileCard, DiffHunks, DiffView } from './diff-view';
export {
  type ChangeBlock,
  countChanges,
  type DiffFile,
  type DiffStatus,
  hunksOfBlocks,
  parseUnifiedDiff,
} from './model';
export { useDiffViewType } from './view-type';
export { DiffViewTypeToggle } from './view-type-toggle';
