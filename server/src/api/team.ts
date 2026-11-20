import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { SettingsStore } from '../runs/settings.js';
import { prTimingsView } from '../team/pr-timings.js';
import { Days, loadTeamData, type TeamData, teamIssueRows, teamStats } from '../team/stats.js';
import type { TeamSync } from '../team/sync.js';
import {
  IsoDay,
  TeamIssues,
  TeamPrTimings,
  TeamStats,
  TeamSyncState,
  TeamSyncView,
} from '../team/views.js';
import { HttpError } from '../variants/errors.js';

// Linear stats (Contracts 37.5). Days are counted in the teamStatsTimezone setting; from and to default to the last 30
// days. people is a comma-separated list of person keys (a Linear user id or "unassigned"), empty for everyone
const DEFAULT_DAYS = 30;
const CACHE_MS = 60_000;

const keys = z
  .string()
  .optional()
  .transform((s) => (s === undefined || s === '' ? [] : s.split(',')));

const Range = z.object({ from: IsoDay.optional(), to: IsoDay.optional() });

export const teamRoutes: FastifyPluginCallbackZod<{
  db: Db;
  team: string;
  // The repo of the PR timings (37.6)
  timedRepo: string;
  sync: TeamSync;
  settings: SettingsStore;
  now?: () => number;
}> = (app, { db, team, timedRepo, sync, settings, now = Date.now }, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const selection = (query: z.infer<typeof Range>) => {
    const zone = settings.get().teamStatsTimezone;
    const days = new Days(zone);
    const to = query.to ?? days.of(now());
    const from = query.from ?? days.add(to, 1 - DEFAULT_DAYS);
    if (from > to) throw new HttpError(400, `from ${from} is after to ${to}`);
    return { zone, from, to };
  };

  // Loading every issue takes about a second: what was loaded is kept until the sync saves again or a minute passes
  // (started intervals of open issues end at "now")
  let cache: { saves: number; at: number; data: TeamData } | null = null;
  const data = () => {
    const t = now();
    if (cache?.saves !== sync.saves() || t - cache.at > CACHE_MS) {
      cache = { saves: sync.saves(), at: t, data: loadTeamData(db, t) };
    }
    return cache.data;
  };

  app.get(
    '/api/team/stats',
    {
      schema: {
        querystring: Range.extend({ people: keys }),
        response: { 200: TeamStats },
      },
    },
    (request) =>
      teamStats(data(), team, { ...selection(request.query), people: request.query.people }, now()),
  );

  app.get(
    '/api/team/issues',
    {
      schema: {
        querystring: Range.extend({
          person: z.string().min(1).optional(),
          people: keys,
          day: IsoDay.optional(),
          doneNotClosed: z.literal('1').optional(),
        }),
        response: { 200: TeamIssues },
      },
    },
    (request) => {
      const { person, people, day, doneNotClosed } = request.query;
      const range = selection(request.query);
      if (day !== undefined && (day < range.from || day > range.to)) {
        throw new HttpError(400, `day ${day} is outside ${range.from}..${range.to}`);
      }
      return {
        issues: teamIssueRows(data(), {
          ...range,
          people: person === undefined ? people : [person],
          day: day ?? null,
          doneNotClosed: doneNotClosed === '1',
        }),
      };
    },
  );

  // txe PR timings (37.6): day narrows the PR list to one day of the range; the summary and the days cover the range
  app.get(
    '/api/team/prs',
    {
      schema: {
        querystring: Range.extend({ people: keys, day: IsoDay.optional() }),
        response: { 200: TeamPrTimings },
      },
    },
    (request) => {
      const { people, day } = request.query;
      const range = selection(request.query);
      if (day !== undefined && (day < range.from || day > range.to)) {
        throw new HttpError(400, `day ${day} is outside ${range.from}..${range.to}`);
      }
      return prTimingsView(db, data(), timedRepo, { ...range, people }, day ?? null);
    },
  );

  app.get('/api/team/sync', { schema: { response: { 200: TeamSyncState } } }, () => ({
    latest: sync.latest(),
    lastSucceeded: sync.lastSucceeded(),
  }));

  // 409 with the reason while a sync runs
  app.post('/api/team/sync', { schema: { response: { 202: TeamSyncView } } }, (_request, reply) => {
    const { view } = sync.begin();
    reply.code(202);
    return view;
  });

  done();
};
