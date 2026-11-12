import os from 'node:os';
import { EnvHttpProxyAgent, fetch, type RequestInit } from 'undici';
import { z } from 'zod';
import { platformOfUname, type VscodePlatform } from './views.js';

export { platformOfUname, VscodePlatform } from './views.js';

export function localPlatform(): VscodePlatform {
  const platform = platformOfUname(`${os.type()} ${os.machine()}`);
  if (platform === null) {
    throw new Error(
      `No VS Code for the Web server package for this machine (${os.type()} ${os.machine()})`,
    );
  }
  return platform;
}

// The update API's answer: url is the server package (zip on darwin, tar.gz on linux), version is the commit,
// sha256hash verifies the download
export const ServerRelease = z.object({
  url: z.url(),
  version: z.string().regex(/^[0-9a-f]{40}$/),
  productVersion: z.string().min(1),
  sha256hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ServerRelease = z.infer<typeof ServerRelease>;

// Downloads go through this machine's proxy environment variables (https_proxy, no_proxy, ...)
const dispatcher = new EnvHttpProxyAgent();

export function vscodeFetch(url: string, init: Omit<RequestInit, 'dispatcher'> = {}) {
  return fetch(url, { ...init, dispatcher });
}

// The server package of the latest VS Code stable (Contracts 32.1)
export async function latestRelease(platform: VscodePlatform): Promise<ServerRelease> {
  const url = `https://update.code.visualstudio.com/api/update/server-${platform}-web/stable/latest`;
  const response = await vscodeFetch(url);
  if (response.status !== 200) {
    throw new Error(
      `Looking up the latest VS Code failed: ${url} returned ${String(response.status)}`,
    );
  }
  return ServerRelease.parse(await response.json());
}
