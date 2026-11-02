// main/finder/bambu-token.js — token resolver for Bambu Cloud / MakerWorld.
//
// Resolves token from BAMBU_CLOUD_TOKEN env var, or fetches it via SSH from OneCLI.
// Caches token in memory for 1 hour.
// Drops cache on 401/403.
// Never logs, prints, writes, or exposes the token value.
//
// 0.8.3: the SSH fetch is async (execFile, no shell). The old execSync froze the
// whole web server for up to 12 s on every cache miss. Concurrent callers share
// one in-flight fetch.
'use strict';

const { execFile } = require('child_process');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SSH_TIMEOUT_MS = 12000;
const SSH_ARGS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=8',
  'dvlce@10.0.0.79',
  '~/bin/onecli-reveal.sh bambu-cloud-token',
];

let cachedToken = null;
let cachedExpiresAt = 0;
let inflight = null;

/**
 * Default runner: `ssh <args>` without a shell, resolves stdout.
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf-8', timeout: SSH_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/**
 * Resolves the Bambu Cloud token.
 * Priority: in-memory cache -> env.BAMBU_CLOUD_TOKEN -> OneCLI over SSH.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {()=>number} [opts.now]
 * @param {(file: string, args: string[])=>Promise<string>|string} [opts.exec]
 * @returns {Promise<string|null>} token or null if unresolvable
 */
async function resolveBambuToken({ env = process.env, now = Date.now, exec = execFileText } = {}) {
  const currentTime = now();
  if (cachedToken && currentTime < cachedExpiresAt) {
    return cachedToken;
  }

  // 1. Check environment variable
  const envToken = env && env.BAMBU_CLOUD_TOKEN ? String(env.BAMBU_CLOUD_TOKEN).trim() : '';
  if (envToken) {
    cachedToken = envToken;
    cachedExpiresAt = currentTime + CACHE_TTL_MS;
    return cachedToken;
  }

  // 2. Fetch from OneCLI over SSH (one fetch at a time)
  if (!inflight) {
    inflight = (async () => {
      try {
        const output = await exec('ssh', SSH_ARGS.slice());
        const fetched = output ? String(output).trim() : '';
        if (fetched) {
          cachedToken = fetched;
          cachedExpiresAt = now() + CACHE_TTL_MS;
          return cachedToken;
        }
      } catch {
        // Intentionally suppressed: never log or expose token retrieval details
      }
      return null;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Drop the in-memory token cache (called on 401/403 or for testing).
 */
function dropBambuTokenCache() {
  cachedToken = null;
  cachedExpiresAt = 0;
}

module.exports = {
  resolveBambuToken,
  dropBambuTokenCache,
  CACHE_TTL_MS,
};
