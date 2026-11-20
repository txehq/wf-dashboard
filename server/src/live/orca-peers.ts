import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { liveSessions, sessions } from '../db/schema.js';
import { isDirectory, pathExists, statOf } from '../dirs/exists.js';
import type { RemoteHost } from '../remote/hosts.js';
import { sshScript } from '../remote/ssh.js';

// Cross-session messages in session records (Contracts 40.1): another Claude session's message reaches a session as a
// user record with origin.kind peer, naming the sender by its session name. The receivers' jsonl are read
// incrementally; a sender is matched to a Live item through the session files Claude Code keeps per process
// (~/.claude/sessions/<pid>.json, with the name and the sessionId) on the receiver's machine

export interface PeerMessage {
  id: string;
  // The Live item whose session received it, and the SSH host that session runs on (null for this machine)
  receiverLiveId: string;
  receiverHostId: string | null;
  fromName: string;
  // The subagent that sent it, when a subagent did (its record sits under its parent session's)
  fromAgent: string | null;
  // The sender's Live item; null when its name matches no session file or no item
  fromLiveId: string | null;
  body: string;
  at: number;
}

const AnyRecord = z.looseObject({
  type: z.string(),
  origin: z.looseObject({ kind: z.string() }).nullish(),
});

const PeerRecord = z.looseObject({
  uuid: z.string(),
  timestamp: z.string(),
  origin: z.looseObject({
    kind: z.literal('peer'),
    msg_id: z.string().optional(),
    name: z.string(),
    body: z.string(),
    senderTaskId: z.string().optional(),
  }),
});

const SessionFile = z.looseObject({
  sessionId: z.string().optional(),
  name: z.string().optional(),
  nameSince: z.number().optional(),
});
type SessionFile = z.infer<typeof SessionFile>;

// One receiver's jsonl as read so far: the byte offset of the first line not read yet and the messages before it
interface Scan {
  offset: number;
  messages: Omit<PeerMessage, 'receiverLiveId' | 'receiverHostId' | 'fromLiveId'>[];
}

// A session's jsonl can run to hundreds of megabytes: it is read in pieces of this size
const CHUNK = 8 * 1024 * 1024;

function scanLine(line: string, scan: Scan): void {
  // Most lines are model requests and tool output; only a line that names a peer origin is parsed
  if (!line.includes('"peer"')) return;
  const raw: unknown = JSON.parse(line);
  const any = AnyRecord.parse(raw);
  if (any.type !== 'user' || any.origin?.kind !== 'peer') return;
  const record = PeerRecord.parse(raw);
  scan.messages.push({
    id: record.origin.msg_id ?? record.uuid,
    fromName: record.origin.name,
    fromAgent: record.origin.senderTaskId ?? null,
    body: record.origin.body,
    at: Date.parse(record.timestamp),
  });
}

// The peer messages in the complete lines of file from offset on; the last line counts only once it ends
async function scanFrom(file: string, scan: Scan): Promise<void> {
  const { size } = await stat(file);
  if (size < scan.offset) {
    scan.offset = 0;
    scan.messages = [];
  }
  if (size === scan.offset) return;
  const handle = await open(file, 'r');
  let carry = Buffer.alloc(0);
  let at = scan.offset;
  while (at < size) {
    const piece = Buffer.alloc(Math.min(CHUNK, size - at));
    const { bytesRead: read } = await handle.read(piece, 0, piece.length, at);
    at += read;
    const data = Buffer.concat([carry, piece.subarray(0, read)]);
    const end = data.lastIndexOf(0x0a);
    if (end === -1) {
      carry = data;
      continue;
    }
    for (const line of data.subarray(0, end).toString('utf8').split('\n')) scanLine(line, scan);
    // offset is where carry starts, so it moves past every byte of the lines just read
    scan.offset += end + 1;
    carry = data.subarray(end + 1);
  }
  await handle.close();
}

// sessionId by session name: the most recently named file wins when a name was reused
function namesOf(files: SessionFile[]): Map<string, string> {
  const names = new Map<string, { sessionId: string; since: number }>();
  for (const f of files) {
    if (f.name === undefined || f.sessionId === undefined) continue;
    const since = f.nameSince ?? 0;
    const known = names.get(f.name);
    if (known === undefined || known.since < since) {
      names.set(f.name, { sessionId: f.sessionId, since });
    }
  }
  return new Map([...names].map(([name, v]) => [name, v.sessionId]));
}

export function createPeerReader(deps: { db: Db; localHome: string }) {
  const { db } = deps;
  const scans = new Map<string, Scan>();
  // This machine's session files by path, kept while their modification time is unchanged
  const localFiles = new Map<string, { mtimeMs: number; file: SessionFile }>();

  async function localNames(): Promise<Map<string, string>> {
    const dir = path.join(deps.localHome, '.claude/sessions');
    const present = new Set<string>();
    if (await isDirectory(dir)) {
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        // A process that exited meanwhile has removed its file
        const info = await statOf(file);
        if (info === null) continue;
        present.add(file);
        const { mtimeMs } = info;
        if (localFiles.get(file)?.mtimeMs === mtimeMs) continue;
        localFiles.set(file, {
          mtimeMs,
          file: SessionFile.parse(JSON.parse(await readFile(file, 'utf8'))),
        });
      }
    }
    for (const file of localFiles.keys()) if (!present.has(file)) localFiles.delete(file);
    return namesOf([...localFiles.values()].map((v) => v.file));
  }

  async function remoteNames(host: RemoteHost): Promise<Map<string, string>> {
    const out = await sshScript(host.target, 'claude-sessions.sh', [host.home]);
    return namesOf(
      out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => SessionFile.parse(JSON.parse(line))),
    );
  }

  return {
    // Peer messages received by these Live items' Claude sessions, oldest first. hosts are the SSH hosts the items
    // run on, whose session files name the senders there
    async read(liveIds: string[], hosts: (hostId: string) => RemoteHost | null) {
      if (liveIds.length === 0) return [];
      const listed = db
        .select({
          liveId: liveSessions.id,
          hostId: liveSessions.hostId,
          file: sessions.filePath,
        })
        .from(liveSessions)
        .innerJoin(sessions, eq(sessions.id, liveSessions.claudeSessionId))
        .where(inArray(liveSessions.id, liveIds))
        .all()
        .filter((r) => r.file.endsWith('.jsonl'));
      const present = await Promise.all(listed.map((r) => pathExists(r.file)));
      const receivers = listed.filter((_, i) => present[i]);
      const names = new Map<string | null, Map<string, string>>();
      const out: PeerMessage[] = [];
      for (const r of receivers) {
        let scan = scans.get(r.file);
        if (scan === undefined) {
          scan = { offset: 0, messages: [] };
          scans.set(r.file, scan);
        }
        await scanFrom(r.file, scan);
        if (scan.messages.length === 0) continue;
        let named = names.get(r.hostId);
        if (named === undefined) {
          const host = r.hostId === null ? null : hosts(r.hostId);
          named =
            r.hostId === null
              ? await localNames()
              : host === null
                ? new Map()
                : await remoteNames(host);
          names.set(r.hostId, named);
        }
        for (const m of scan.messages) {
          const sessionId = named.get(m.fromName);
          const from =
            sessionId === undefined
              ? undefined
              : db
                  .select({ id: liveSessions.id })
                  .from(liveSessions)
                  .where(eq(liveSessions.claudeSessionId, sessionId))
                  .get();
          out.push({
            ...m,
            receiverLiveId: r.liveId,
            receiverHostId: r.hostId,
            fromLiveId: from?.id ?? null,
          });
        }
      }
      return out.sort((a, b) => a.at - b.at);
    },
  };
}

export type PeerReader = ReturnType<typeof createPeerReader>;
