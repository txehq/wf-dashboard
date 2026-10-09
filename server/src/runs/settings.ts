import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { defaultModels, setModels } from '../llm/client.js';

const ModelName = z.string().trim().min(1);

export const Settings = z.strictObject({
  runConcurrency: z.int().min(1).max(32),
  maxUserTurns: z.int().min(1).max(1000),
  defaultRepeats: z.int().min(1).max(50),
  // gateway 上的模型名
  models: z.strictObject({ simulatedUser: ModelName, judge: ModelName, stageCheck: ModelName }),
});
export type Settings = z.infer<typeof Settings>;

export function defaultSettings(): Settings {
  return {
    runConcurrency: config.runConcurrency,
    maxUserTurns: config.maxUserTurns,
    defaultRepeats: config.defaultRepeats,
    models: defaultModels(),
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
