// lfg 与 ic 的阶段列表与说明，依据 Spikes/Stage Markers 第 1.4 与 2.1 节

export const LFG_STAGES = ['interview', 'research', 'plan', 'ticketing'] as const;
export type LfgStage = (typeof LFG_STAGES)[number];

export const LFG_STAGE_DESCRIPTIONS: Record<LfgStage, string> = {
  interview: '访谈用户，确定边界，写出 Brief.md。',
  research: '本地与网上调研，写出 Research.md（或 System Design.md）。',
  plan: '起草并评审实施计划，锁定后改写 Research.md 的 Plan 一节。',
  ticketing: '对照 Linear 拆分工单并建单，写出 Tickets.md，停在 dispatch gate。',
};

export const IC_STAGES = [
  'claim',
  'readiness',
  'implement',
  'acceptance',
  'open-pr',
  'fix-pr',
  'ready-for-review',
] as const;
export type IcStage = (typeof IC_STAGES)[number];

// 给 Haiku 的一句说明（每条不超过 60 字）
export const IC_STAGE_DESCRIPTIONS: Record<IcStage, string> = {
  claim: '认领工单：指派给自己、改为 In Progress、发认领评论，读完工单与文档，发布需求清单评论。',
  readiness: '运行 wf readiness 检查本机工具链、服务和凭据，必要时修复，得出 ready 或 NOT READY。',
  implement: '建 worktree 和分支，逐条需求写代码与测试并提交，跑完整测试和 Codex 评审，回写清单。',
  acceptance:
    '在真实界面或命令行逐条验证验收标准并截图，生成验收报告并用 wf publish-artifact 发布。',
  'open-pr':
    '推送分支，写 PR 正文并用 gh image 放截图，建草稿 PR，把链接评论到工单，请求首次 review。',
  'fix-pr': '后台运行 watch_pr.py 监视 review 和 CI，逐条处置 finding，修复失败检查后推送。',
  'ready-for-review':
    '核对 review 线程全部解决、CI 全绿、清单全部勾选，执行 gh pr ready，工单移到 review 状态。',
};
