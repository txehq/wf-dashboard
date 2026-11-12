import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { type ServerRelease, type VscodePlatform, vscodeFetch } from './release.js';

export interface DownloadProgress {
  phase: 'downloading' | 'extracting';
  received: number | null;
  total: number | null;
}

// The server package cache (Contracts 32.1): <serversDir>/<commit>/<platform>/ holds the extracted package
// (bin/, node, out/, ...)
export function packageDir(serversDir: string, commit: string, platform: VscodePlatform): string {
  return path.join(serversDir, commit, platform);
}

// The whole directory is renamed into place after extraction, so it is complete once it exists
export function hasPackage(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'product.json'));
}

// Download, verify by sha256 and extract the server package; returns the package directory. Processes downloading
// the same package at once (several tests, two dashboards) each work in their own staging directory; the first
// to move it into place wins
export async function ensurePackage(options: {
  serversDir: string;
  release: ServerRelease;
  platform: VscodePlatform;
  onProgress: (progress: DownloadProgress) => void;
  log: (line: string) => void;
}): Promise<string> {
  const { serversDir, release, platform, onProgress, log } = options;
  const dir = packageDir(serversDir, release.version, platform);
  if (hasPackage(dir)) return dir;
  const staging = path.join(path.dirname(dir), `.${platform}-${randomUUID()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const archive = path.join(staging, path.basename(new URL(release.url).pathname));
    await downloadVerified({
      url: release.url,
      sha256: release.sha256hash,
      file: archive,
      onProgress,
      log,
    });
    onProgress({ phase: 'extracting', received: null, total: null });
    const extracted = path.join(staging, 'extracted');
    fs.mkdirSync(extracted);
    // macOS tar (bsdtar) extracts zip as well and keeps the executable bits
    await execa('tar', ['-xf', archive, '-C', extracted]);
    const inner = path.join(extracted, `vscode-server-${platform}-web`);
    if (!hasPackage(inner)) {
      throw new Error(
        `${release.url} has no vscode-server-${platform}-web/product.json after extraction`,
      );
    }
    if (!hasPackage(dir)) fs.renameSync(inner, dir);
    return dir;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// Each chunk of the response body
const Chunk = z.instanceof(Uint8Array);

// Resuming (Contracts 32.1): downloading through this machine's proxy, the peer closes the connection midway
// (about 67 MB each time in practice); continue from the bytes already downloaded with HTTP Range, and fail with
// the last error after this many resumes. After the whole file is down, verify sha256 and download it again once
// on a mismatch
export const MAX_RESUMES = 30;
const RESUME_DELAY_MS = 1_000;
const WHOLE_ATTEMPTS = 2;

export interface DownloadOptions {
  url: string;
  sha256: string;
  file: string;
  onProgress: (progress: DownloadProgress) => void;
  // One line per resume, with the bytes downloaded, and on a sha256 mismatch
  log: (line: string) => void;
  maxResumes?: number;
}

// The connection was closed mid-transfer: undici's fetch throws TypeError terminated while reading the body and
// TypeError fetch failed before the response headers. Only these two resume; other errors are thrown as they are
function connectionClosed(error: unknown): error is TypeError {
  return (
    error instanceof TypeError &&
    (error.message === 'terminated' || error.message === 'fetch failed')
  );
}

function describe(error: TypeError): string {
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${error.message}${cause}`;
}

// Content-Range: bytes <start>-<end>/<total>
const CONTENT_RANGE = /^bytes (\d+)-\d+\/(\d+)$/;

// Request once from offset and append the body to file; returns the error when the connection was closed, null
// when the download is complete
async function fetchFrom(
  url: string,
  file: string,
  offset: number,
  state: { received: number; total: number | null },
  onProgress: (progress: DownloadProgress) => void,
): Promise<TypeError | null> {
  const headers: Record<string, string> = offset === 0 ? {} : { range: `bytes=${String(offset)}-` };
  const out = fs.createWriteStream(file, { flags: 'a' });
  const closed = async (): Promise<TypeError | null> => {
    const response = await vscodeFetch(url, { headers });
    if (response.body === null) throw new Error(`Download failed: ${url} has no body`);
    if (offset === 0) {
      if (response.status !== 200) {
        throw new Error(`Download failed: ${url} returned ${String(response.status)}`);
      }
      const length = response.headers.get('content-length');
      state.total = length === null ? null : Number(length);
    } else {
      const range = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '');
      if (response.status !== 206 || range?.[1] === undefined || Number(range[1]) !== offset) {
        throw new Error(
          `Resume failed: ${url} requested from byte ${String(offset)}, returned ${String(response.status)} with Content-Range ${String(response.headers.get('content-range'))}`,
        );
      }
      state.total = Number(range[2]);
    }
    onProgress({ phase: 'downloading', received: state.received, total: state.total });
    for await (const value of response.body) {
      const chunk = Chunk.parse(value);
      state.received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress({ phase: 'downloading', received: state.received, total: state.total });
    }
    return null;
  };
  const result = await closed().then(
    (done) => done,
    (error: unknown) => {
      if (connectionClosed(error)) return error;
      throw error;
    },
  );
  await new Promise<void>((resolve, reject) => {
    out.end((error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return result;
}

// Download the whole file, resuming from the bytes already downloaded whenever the connection is closed; returns
// the number of resumes
async function downloadResuming(options: DownloadOptions): Promise<number> {
  const { url, file, onProgress, log } = options;
  const maxResumes = options.maxResumes ?? MAX_RESUMES;
  fs.writeFileSync(file, '');
  const state: { received: number; total: number | null } = { received: 0, total: null };
  for (let resumes = 0; ; resumes++) {
    const closed = await fetchFrom(url, file, state.received, state, onProgress);
    // A body that ends short of Content-Length is a closed connection as well
    const short = closed === null && state.total !== null && state.received < state.total;
    if (closed === null && !short) return resumes;
    const reason =
      closed === null ? `body ended at byte ${String(state.received)}` : describe(closed);
    const progress = `${String(state.received)} / ${String(state.total)} bytes downloaded`;
    if (resumes >= maxResumes) {
      throw new Error(
        `Download of ${url} incomplete after ${String(resumes)} resumes, ${progress}: ${reason}`,
      );
    }
    log(`Resume ${String(resumes + 1)}: ${url} ${progress} (${reason})`);
    await new Promise((r) => setTimeout(r, RESUME_DELAY_MS));
  }
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(Chunk.parse(chunk));
  return hash.digest('hex');
}

// Download to file and verify by sha256
export async function downloadVerified(options: DownloadOptions) {
  const { url, sha256, file, log } = options;
  for (let whole = 1; ; whole++) {
    const started = Date.now();
    const resumes = await downloadResuming(options);
    const digest = await fileSha256(file);
    const summary = `${String(fs.statSync(file).size)} bytes, ${String(resumes)} resumes, ${String(Math.round((Date.now() - started) / 1000))} s`;
    if (digest === sha256) {
      log(`Downloaded ${url}: ${summary}`);
      return;
    }
    const mismatch = `sha256 mismatch for ${url}: expected ${sha256}, got ${digest} (${summary})`;
    if (whole >= WHOLE_ATTEMPTS) {
      throw new Error(`${mismatch}; the whole file was downloaded ${String(whole)} times`);
    }
    log(`${mismatch}; downloading the whole file again`);
  }
}
