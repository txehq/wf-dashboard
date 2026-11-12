// Model aliases and efforts selectable at run time (Contracts 16.5); no module dependencies, web uses them via shared schemas such as live/views
export const modelAliases = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ModelAlias = (typeof modelAliases)[number];

export const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof efforts)[number];
