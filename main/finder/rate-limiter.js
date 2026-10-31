// main/finder/rate-limiter.js — at most one request per `minIntervalMs` per key.
//
// The sites we query are other people's servers. The rule is one request per
// second per site, no exceptions, so the limiter sits in front of every outbound
// call (search, detail, download-link and the file fetch itself).
//
// `wait(key)` RESERVES the next slot synchronously and then sleeps until it, so
// two callers that arrive in the same tick get slots one interval apart instead
// of both seeing "nothing happened recently" and firing together. Clock and sleep
// are injectable so the tests never wait for real time.
'use strict';

function createRateLimiter({
  minIntervalMs = 1000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** @type {Map<string, number>} key -> start time of the last reserved slot */
  const last = new Map();

  async function wait(key = 'default') {
    const t = now();
    const prev = last.get(key);
    const slot = prev === undefined ? t : Math.max(t, prev + minIntervalMs);
    last.set(key, slot);
    const delay = slot - t;
    if (delay > 0) await sleep(delay);
    return delay;
  }

  return { wait, minIntervalMs, _last: last };
}

module.exports = { createRateLimiter };
