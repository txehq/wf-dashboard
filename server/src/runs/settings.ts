import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { defaultModels, setModels } from '../llm/client.js';
import { efforts, modelAliases } from '../variants/models.js';

const ModelName = z.string().trim().min(1);

// txehq 组织级的自托管 runner 对新建仓库可用（Contracts 第 13 节，Reports/W28 实测）
export const DEFAULT_COPY_RUNNER_LABELS = ['arc-linux-dind'];

export const Settings = z.strictObject({
  runConcurrency: z.int().min(1).max(32),
  maxUserTurns: z.int().min(1).max(1000),
  defaultRepeats: z.int().min(1).max(50),
  // gateway 上的模型名
  models: z.strictObject({ simulatedUser: ModelName, judge: ModelName }),
  // 副本仓库中可用的自托管 runner 标签；在它之前保存的设置读出为默认值
  copyRunnerLabels: z
    .array(z.string().trim().min(1))
    .refine((labels) => new Set(labels).size === labels.length, '标签不能重复')
    .default(DEFAULT_COPY_RUNNER_LABELS),
  // 被测 agent 的 --model（别名，由 settings.json env 解析为 gateway 模型名）与 --effort：发起 batch、
  // 新建交互与 resume 时的默认值（Contracts 16.5）；在它之前保存的设置读出为默认值
  agentModel: z.enum(modelAliases).default('opus'),
  agentEffort: z.enum(efforts).default('high'),
});
export type Settings = z.infer<typeof Settings>;

export function defaultSettings(): Settings {
  return {
    runConcurrency: config.runConcurrency,
    maxUserTurns: config.maxUserTurns,
    defaultRepeats: config.defaultRepeats,
    models: defaultModels(),
    copyRunnerLabels: DEFAULT_COPY_RUNNER_LABELS,
    agentModel: 'opus',
    agentEffort: 'high',
  };
}

const ROW_ID = 1;

// 设置保存在数据库；修改后立即生效：模型写入 llm/client 的 models，并通知监听者（队列据此调整并发）
export function createSettingsStore(db: Db) {
  const row = db.select().from(settingsTable).where(eq(settingsTable.id, ROW_ID)).get();
  let current: Settings = row === undefined ? defaultSettings() : Settings.parse(row.value);
  setModels(current.models);
  const listeners = new Set<(settings: Settings) => void>();
  return {
    get(): Settings {
      return current;
    },
    set(next: Settings): Settings {
      current = Settings.parse(next);
      db.insert(settingsTable)
        .values({ id: ROW_ID, value: current, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settingsTable.id,
          set: { value: current, updatedAt: new Date() },
        })
        .run();
      setModels(current.models);
      for (const listener of listeners) listener(current);
      return current;
    },
    onChange(listener: (settings: Settings) => void) {
      listeners.add(listener);
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
