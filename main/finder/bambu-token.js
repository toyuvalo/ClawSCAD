// main/finder/bambu-token.js — token resolver for Bambu Cloud / MakerWorld.
//
// Resolves token from BAMBU_CLOUD_TOKEN env var, or fetches it via SSH from OneCLI.
// Caches token in memory for 1 hour.
// Drops cache on 401/403.
// Never logs, prints, writes, or exposes the token value.
'use strict';

const { execSync } = require('child_process');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedToken = null;
let cachedExpiresAt = 0;

/**
 * Resolves the Bambu Cloud token.
 * Priority: in-memory cache -> env.BAMBU_CLOUD_TOKEN -> OneCLI over SSH.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {()=>number} [opts.now]
 * @param {(cmd: string, options: any)=>string} [opts.exec]
 * @returns {string|null} token or null if unresolvable
 */
function resolveBambuToken({ env = process.env, now = Date.now, exec = execSync } = {}) {
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

  // 2. Fetch from OneCLI over SSH
  try {
    const cmd = 'ssh -o BatchMode=yes -o ConnectTimeout=8 dvlce@10.0.0.79 "~/bin/onecli-reveal.sh bambu-cloud-token"';
    const output = exec(cmd, {
      encoding: 'utf-8',
      timeout: 12000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const fetched = output ? String(output).trim() : '';
    if (fetched) {
      cachedToken = fetched;
      cachedExpiresAt = currentTime + CACHE_TTL_MS;
      return cachedToken;
    }
  } catch {
    // Intentionally suppressed: never log or expose token retrieval details
  }

  return null;
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
