// main/finder/cache.js — a TTL cache with two layers: a Map in memory and one
// small JSON file per key on disk (under app userData / the web state dir).
//
// Why both: the memory layer makes a repeated search instant inside a session;
// the file layer means a restart, or a site that is down, does not lose the last
// good answer. An EXPIRED file entry is still readable with `allowStale`, which
// is how the UI can say "showing results from 3 hours ago" instead of nothing.
//
// File names are the sha1 of the key, never the key itself — a search term is
// untrusted text and must not become a path.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createCache({
  dir,
  now = () => Date.now(),
  maxMemory = 200,
  maxFiles = 400,
} = {}) {
  /** @type {Map<string, {savedAt:number, ttlMs:number, value:any}>} */
  const memory = new Map();

  const fileFor = (key) => (dir ? path.join(dir, crypto.createHash('sha1').update(String(key)).digest('hex') + '.json') : null);

  function describe(entry, key) {
    const ageMs = Math.max(0, now() - entry.savedAt);
    return { key, value: entry.value, savedAt: entry.savedAt, ageMs, stale: ageMs > entry.ttlMs };
  }

  /**
   * @returns {{value:any, savedAt:number, ageMs:number, stale:boolean, key:string}|null}
   *   null when there is no entry, or the entry is expired and allowStale is off.
   */
  function get(key, { allowStale = false } = {}) {
    let entry = memory.get(key);
    if (!entry) {
      const file = fileFor(key);
      if (file) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
          if (parsed && parsed.key === key && typeof parsed.savedAt === 'number') {
            entry = { savedAt: parsed.savedAt, ttlMs: Number(parsed.ttlMs) || 0, value: parsed.value };
            memory.set(key, entry);
          }
        } catch {
          /* missing or corrupt file: treat as a miss */
        }
      }
    }
    if (!entry) return null;
    const info = describe(entry, key);
    if (info.stale && !allowStale) return null;
    return info;
  }

  function set(key, value, ttlMs) {
    const entry = { savedAt: now(), ttlMs: Number(ttlMs) || 0, value };
    memory.set(key, entry);
    if (memory.size > maxMemory) memory.delete(memory.keys().next().value);
    const file = fileFor(key);
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ key, savedAt: entry.savedAt, ttlMs: entry.ttlMs, value }));
      fs.renameSync(tmp, file);
      prune();
    } catch {
      /* a cache that cannot write is just a smaller cache */
    }
  }

  /** Keep the newest `maxFiles` entries; delete the rest. */
  function prune() {
    if (!dir) return;
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const full = path.join(dir, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        });
      if (files.length <= maxFiles) return;
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files.slice(0, files.length - maxFiles)) fs.rmSync(f.full, { force: true });
    } catch {
      /* best effort */
    }
  }

  function clearMemory() {
    memory.clear();
  }

  return { get, set, prune, clearMemory, _memory: memory };
}

module.exports = { createCache };
