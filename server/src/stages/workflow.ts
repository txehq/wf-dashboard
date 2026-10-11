// lfg 与 ic 的阶段列表，依据 Spikes/Stage Markers 第 1.4 与 2.1 节

export const LFG_STAGES = ['interview', 'research', 'plan', 'ticketing'] as const;
export type LfgStage = (typeof LFG_STAGES)[number];

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
