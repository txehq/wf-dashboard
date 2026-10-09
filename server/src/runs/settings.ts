import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';

export const Settings = z.strictObject({
  runConcurrency: z.int().min(1).max(32),
  maxUserTurns: z.int().min(1).max(1000),
  defaultRepeats: z.int().min(1).max(50),
});
export type Settings = z.infer<typeof Settings>;

export const defaultSettings: Settings = {
  runConcurrency: config.runConcurrency,
  maxUserTurns: config.maxUserTurns,
  defaultRepeats: config.defaultRepeats,
};

// 设置保存在 data/settings.json；修改后通知监听者（队列据此立即调整并发）
export function createSettingsStore(file: string) {
  let current: Settings = fs.existsSync(file)
    ? Settings.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    : defaultSettings;
  const listeners = new Set<(settings: Settings) => void>();
  return {
    get(): Settings {
      return current;
    },
    set(next: Settings): Settings {
      current = Settings.parse(next);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
      for (const listener of listeners) listener(current);
      return current;
    },
    onChange(listener: (settings: Settings) => void) {
      listeners.add(listener);
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
