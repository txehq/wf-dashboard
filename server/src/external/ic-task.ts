// Contracts 第 6 节中 ic task 被 external/ 与 grading/ 用到的字段；合并时统一到 tasks/ 的 schema
export interface IcTask {
  id: string;
  // task 目录的绝对路径，task.yaml 中的相对路径都相对于它
  dir: string;
  title: string;
  ticket: { title: string; body: string; acceptanceCriteria: string[] };
  // path：相对 task 目录的 git bundle；commit：推送到 main 的固定 commit
  repo: { path: string; commit: string };
  hiddenTests: {
    dir: string;
    // {junitPath} 由评分时的 JUnit 输出路径替换
    command: string;
    // 相对 checkout 根目录的文件路径（JUnit classname）→ 测试名
    manifest: Record<string, string[]>;
  };
}
