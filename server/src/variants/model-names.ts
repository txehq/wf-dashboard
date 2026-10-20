// 运行时可选的模型别名与 effort（Contracts 16.5）；不依赖其他模块，web 经 live/views 等共用的 schema 引用
export const modelAliases = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ModelAlias = (typeof modelAliases)[number];

export const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof efforts)[number];
