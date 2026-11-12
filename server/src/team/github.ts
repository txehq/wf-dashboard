import { z } from 'zod';
import { ghResult } from '../external/github.js';

// GitHub reads of the stats sync (Contracts 37.2): the PRs an issue's attachments link to

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export interface PrRef {
  // https://github.com/<owner>/<repo>/pull/<n>, without a trailing /files or #anchor
  url: string;
  repo: string;
  number: number;
}

export function prRef(url: string): PrRef | null {
  const match = PR_URL.exec(url);
  if (match === null) return null;
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) return null;
  return {
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    repo: `${owner}/${repo}`,
    number: Number(number),
  };
}

// Only the fields the stats use, so a PR's title and body are never read
const PR_JQ =
  '{id, state, draft, merged_at, closed_at, additions, deletions, created_at, user: {login: .user.login}}';

export function prArgs(ref: PrRef): string[] {
  return ['api', `repos/${ref.repo}/pulls/${String(ref.number)}`, '--jq', PR_JQ];
}

const Pr = z.object({
  id: z.number(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged_at: z.iso.datetime().nullable(),
  closed_at: z.iso.datetime().nullable(),
  additions: z.number(),
  deletions: z.number(),
  created_at: z.iso.datetime(),
  user: z.object({ login: z.string() }),
});
export type Pr = z.infer<typeof Pr>;

// A PR that does not exist or cannot be read is recorded with gh's text and left out of the counts; any other failure
// (network, authentication, a 403 for the rate limit) fails the sync, and the next sync reads the PR again
export type PrRead = { ok: true; pr: Pr } | { ok: false; error: string };

export function prReadFrom(
  ref: PrRef,
  result: { exitCode: number; stdout: string; stderr: string },
): PrRead {
  if (result.exitCode === 0) return { ok: true, pr: Pr.parse(JSON.parse(result.stdout)) };
  if (/\(HTTP 40[34]\)/.test(result.stderr) && !/rate limit/i.test(result.stderr)) {
    return {
      ok: false,
      error: [result.stderr.trim(), result.stdout.trim()].filter((s) => s !== '').join('\n'),
    };
  }
  throw new Error(
    `gh ${prArgs(ref).join(' ')} exit code ${String(result.exitCode)}: ${result.stderr.trim()}`,
  );
}

export async function readPr(ref: PrRef): Promise<PrRead> {
  return prReadFrom(ref, await ghResult(prArgs(ref)));
}
