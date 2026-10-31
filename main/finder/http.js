// main/finder/http.js — the one door every outbound request goes through.
//
// It does four things and nothing else: waits for the rate limiter, enforces a
// timeout, turns every failure into a FinderError whose message a person can act
// on, and caps how much it will read. `fetch` is injectable: production passes
// the global, tests pass a recorded-fixture fetch, and CLAWSCAD_FINDER_FIXTURES
// swaps in main/finder/fixture-fetch.js so the whole app can run offline.
'use strict';

const { FinderError } = require('./errors.js');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function createHttp({ fetchImpl, limiter, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));

  /**
   * @param {string} site     rate-limit key and the name used in messages
   * @param {string} url
   * @param {object} [opts]   { method, headers, body, as: 'json'|'response', label, timeoutMs }
   */
  async function request(site, url, opts = {}) {
    const label = opts.label || site;
    if (limiter) await limiter.wait(opts.rateKey || site);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || timeoutMs);
    let res;
    try {
      res = await doFetch(url, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body,
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
        throw new FinderError('timeout', `${label} did not answer in time. Try again in a moment.`, { site });
      }
      throw new FinderError('network', `Could not reach ${label}. Check the network connection.`, { site });
    }

    if (!res.ok) {
      clearTimeout(timer);
      throw statusError(site, label, res.status, res.headers && res.headers.get && res.headers.get('retry-after'));
    }

    if (opts.as === 'response') {
      // The caller streams the body, so the timer must keep covering it; the
      // caller clears it through `release()` when it is done.
      res.release = () => clearTimeout(timer);
      return res;
    }

    try {
      const text = await res.text();
      if (text.length > MAX_JSON_BYTES) {
        throw new FinderError('too-large', `${label} sent a response that is too large to read.`, { site });
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new FinderError('parse', `${label} sent something that is not valid JSON.`, { site });
      }
    } catch (err) {
      if (err instanceof FinderError) throw err;
      if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
        throw new FinderError('timeout', `${label} stopped answering part way through.`, { site });
      }
      throw new FinderError('network', `The connection to ${label} dropped.`, { site });
    } finally {
      clearTimeout(timer);
    }
  }

  return { request, json: (site, url, opts) => request(site, url, { ...opts, as: 'json' }) };
}

function statusError(site, label, status, retryAfter) {
  if (status === 401) return new FinderError('needs-login', `${label} wants a login for this.`, { site, status });
  if (status === 403) {
    return new FinderError('blocked', `${label} refused the request (403). Its bot protection may be blocking this app.`, {
      site,
      status,
    });
  }
  if (status === 404) return new FinderError('not-found', `${label} has no such item (404).`, { site, status });
  if (status === 429) {
    return new FinderError('rate-limited', `${label} says we are asking too often (429). Wait a minute and try again.`, {
      site,
      status,
      retryAfter: retryAfter || null,
    });
  }
  return new FinderError('http', `${label} had a problem (HTTP ${status}). Try again in a minute.`, { site, status });
}

module.exports = { createHttp, MAX_JSON_BYTES, DEFAULT_TIMEOUT_MS };
