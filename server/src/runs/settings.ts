import { eq } from 'drizzle-orm';
import { IANAZone } from 'luxon';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { defaultModels, setModels } from '../llm/client.js';
import { efforts, modelAliases } from '../variants/models.js';

const ModelName = z.string().trim().min(1);

// The txehq organisation's self-hosted runners are available to new repos (Contracts section 13, measured in Reports/W28)
export const DEFAULT_COPY_RUNNER_LABELS = ['arc-linux-dind'];

export const DEFAULT_TEAM_STATS_TIMEZONE = 'Asia/Shanghai';

export const Settings = z.strictObject({
  runConcurrency: z.int().min(1).max(32),
  maxUserTurns: z.int().min(1).max(1000),
  defaultRepeats: z.int().min(1).max(50),
  // Model names on the gateway
  models: z.strictObject({ simulatedUser: ModelName, judge: ModelName }),
  // Self-hosted runner labels available in copied repos; settings saved before this field read as the default
  copyRunnerLabels: z
    .array(z.string().trim().min(1))
    .refine((labels) => new Set(labels).size === labels.length, 'Labels must be unique')
    .default(DEFAULT_COPY_RUNNER_LABELS),
  // The agent under test's --model (an alias that settings.json env resolves to a gateway model name) and --effort:
  // defaults when starting a batch, a new Live item or a resume (Contracts 16.5); settings saved before this field read
  // as the default
  agentModel: z.enum(modelAliases).default('opus'),
  agentEffort: z.enum(efforts).default('high'),
  // Day boundaries of the Linear stats (Contracts 37.1), an IANA timezone
  teamStatsTimezone: z
    .string()
    .refine((zone) => IANAZone.isValidZone(zone), 'Not an IANA timezone')
    .default(DEFAULT_TEAM_STATS_TIMEZONE),
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
    teamStatsTimezone: DEFAULT_TEAM_STATS_TIMEZONE,
  };
}

const ROW_ID = 1;

// Settings are stored in the database and take effect on change: models go into llm/client's models and listeners
// are notified (the queue adjusts its concurrency)
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
