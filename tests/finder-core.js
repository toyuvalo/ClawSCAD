#!/usr/bin/env node
/**
 * Standalone harness for Find & Print core modules (main/finder/*).
 *
 * Exercises rate-limiter, cache, http, normalize, adapters, and the createFinder
 * aggregator offline using recorded fixtures.
 *
 * Run: node tests/finder-core.js
 */

'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { FinderError } = require('../main/finder/errors.js');
const { createRateLimiter } = require('../main/finder/rate-limiter.js');
const { createCache } = require('../main/finder/cache.js');
const { createHttp } = require('../main/finder/http.js');
const {
  htmlToText,
  parseLicence,
  interleave,
  normalizePrintablesHit,
  normalizePrintablesDetail,
  SITES,
} = require('../main/finder/normalize.js');
const {
  createPrintablesAdapter,
  isPrintablesFileUrl,
  GRAPHQL: PR_GRAPHQL,
} = require('../main/finder/adapters/printables.js');
const {
  createThingiverseAdapter,
  createMyMiniFactoryAdapter,
  createCults3dAdapter,
} = require('../main/finder/adapters/key-stubs.js');
const { createFinder, SEARCH_TTL_MS } = require('../main/finder/index.js');
const { createFixtureFetch } = require('../main/finder/fixture-fetch.js');

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'finder');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL — ${name}`);
    console.log(`  ${err.message}`);
  }
}

(async () => {
  // ── 1. rate-limiter.js ───────────────────────────────────────────────────

  await check('rate-limiter: waits on same key are >= minIntervalMs apart with fake clock/sleep', async () => {
    let nowMs = 1000;
    const sleeps = [];
    const limiter = createRateLimiter({
      minIntervalMs: 500,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    const d1 = await limiter.wait('siteA');
    assert.strictEqual(d1, 0, 'first call should not delay');
    assert.strictEqual(sleeps.length, 0);

    const d2 = await limiter.wait('siteA');
    assert.strictEqual(d2, 500, 'second call should wait minIntervalMs');
    assert.strictEqual(sleeps.length, 1);
    assert.strictEqual(sleeps[0], 500);

    // After waiting, next slot is at nowMs (1500), so third immediate wait delays 500
    const d3 = await limiter.wait('siteA');
    assert.strictEqual(d3, 500);
    assert.strictEqual(sleeps.length, 2);
  });

  await check('rate-limiter: two calls issued in the same tick get distinct slots', async () => {
    let nowMs = 5000;
    const sleeps = [];
    const limiter = createRateLimiter({
      minIntervalMs: 1000,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    // Synchronously dispatch two calls in the same tick
    const p1 = limiter.wait('siteB');
    const p2 = limiter.wait('siteB');

    const [d1, d2] = await Promise.all([p1, p2]);
    assert.strictEqual(d1, 0, 'first concurrent call should take immediate slot');
    assert.strictEqual(d2, 1000, 'second concurrent call should be allocated next slot');
    assert.strictEqual(limiter._last.get('siteB'), 6000, 'last slot reserved should be at t + minIntervalMs');
  });

  await check('rate-limiter: different keys do not delay each other', async () => {
    let nowMs = 10000;
    const sleeps = [];
    const limiter = createRateLimiter({
      minIntervalMs: 2000,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    await limiter.wait('key1');
    const dOther = await limiter.wait('key2');
    assert.strictEqual(dOther, 0, 'call on different key should not wait');
    assert.strictEqual(sleeps.length, 0);
  });

  // ── 2. cache.js ──────────────────────────────────────────────────────────

  await check('cache: get/set/TTL expiry with injected clock and allowStale', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-cache-'));
    try {
      let nowMs = 1000;
      const cache = createCache({ dir: tmpDir, now: () => nowMs });

      cache.set('item-1', { text: 'hello' }, 500);

      // Fresh hit
      const fresh = cache.get('item-1');
      assert.ok(fresh);
      assert.deepStrictEqual(fresh.value, { text: 'hello' });
      assert.strictEqual(fresh.stale, false);
      assert.strictEqual(fresh.ageMs, 0);

      // Advance within TTL
      nowMs = 1300;
      const withinTtl = cache.get('item-1');
      assert.ok(withinTtl);
      assert.strictEqual(withinTtl.stale, false);
      assert.strictEqual(withinTtl.ageMs, 300);

      // Advance past TTL (expiry)
      nowMs = 1600;
      const expiredDefault = cache.get('item-1');
      assert.strictEqual(expiredDefault, null, 'expired entry must return null by default');

      const expiredStale = cache.get('item-1', { allowStale: true });
      assert.ok(expiredStale, 'allowStale must return expired entry');
      assert.strictEqual(expiredStale.stale, true);
      assert.strictEqual(expiredStale.ageMs, 600);
      assert.deepStrictEqual(expiredStale.value, { text: 'hello' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('cache: a second createCache on the same dir sees the first one\'s file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-cache-'));
    try {
      let nowMs = 2000;
      const cache1 = createCache({ dir: tmpDir, now: () => nowMs });
      cache1.set('shared-key', { persisted: 42 }, 1000);

      // New cache instance without shared memory
      const cache2 = createCache({ dir: tmpDir, now: () => nowMs });
      const hit = cache2.get('shared-key');
      assert.ok(hit, 'cache2 should read the persisted file');
      assert.deepStrictEqual(hit.value, { persisted: 42 });
      assert.strictEqual(hit.stale, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('cache: file names are hex hashes (a key like "../../x" never becomes a path)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-cache-'));
    try {
      const cache = createCache({ dir: tmpDir });
      const traversalKey = '../../sneaky/traversal/key';
      cache.set(traversalKey, { safe: true }, 5000);

      const files = fs.readdirSync(tmpDir);
      assert.strictEqual(files.length, 1);
      assert.match(files[0], /^[0-9a-f]{40}\.json$/, 'file name must be 40-char sha1 hex hash');

      const expectedHash = crypto.createHash('sha1').update(traversalKey).digest('hex') + '.json';
      assert.strictEqual(files[0], expectedHash);

      const readBack = cache.get(traversalKey);
      assert.deepStrictEqual(readBack.value, { safe: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('cache: corrupt file is treated as a miss', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-cache-'));
    try {
      const cache = createCache({ dir: tmpDir });
      const key = 'corrupt-entry';
      const hashFile = path.join(tmpDir, crypto.createHash('sha1').update(key).digest('hex') + '.json');
      fs.writeFileSync(hashFile, 'NOT_VALID_JSON{{{');

      const res = cache.get(key);
      assert.strictEqual(res, null, 'corrupt file should safely resolve to null (miss)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── 3. http.js ───────────────────────────────────────────────────────────

  await check('http: timeout maps to FinderError code "timeout"', async () => {
    const fetchImpl = async () => {
      const err = new Error('abort');
      err.name = 'AbortError';
      throw err;
    };
    const http = createHttp({ fetchImpl });
    await assert.rejects(
      () => http.request('site', 'https://example.com'),
      (err) => err instanceof FinderError && err.code === 'timeout'
    );
  });

  await check('http: network throw maps to FinderError code "network"', async () => {
    const fetchImpl = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    };
    const http = createHttp({ fetchImpl });
    await assert.rejects(
      () => http.request('site', 'https://example.com'),
      (err) => err instanceof FinderError && err.code === 'network'
    );
  });

  await check('http: statuses 401, 403, 404, 429 (+retry-after), 500 map to expected codes', async () => {
    const makeHttp = (status, headers = {}) =>
      createHttp({
        fetchImpl: async () => ({
          ok: false,
          status,
          headers: { get: (h) => headers[h.toLowerCase()] || null },
        }),
      });

    await assert.rejects(
      () => makeHttp(401).request('site', 'https://example.com'),
      (err) => err instanceof FinderError && err.code === 'needs-login' && err.extra.status === 401
    );

    await assert.rejects(
      () => makeHttp(403).request('site', 'https://example.com'),
      (err) => err instanceof FinderError && err.code === 'blocked' && err.extra.status === 403
    );

    await assert.rejects(
      () => makeHttp(404).request('site', 'https://example.com'),
      (err) => err instanceof FinderError && err.code === 'not-found' && err.extra.status === 404
    );

    await assert.rejects(
      () => makeHttp(429, { 'retry-after': '45' }).request('site', 'https://example.com'),
      (err) =>
        err instanceof FinderError &&
        err.code === 'rate-limited' &&
        err.extra.status === 429 &&
        err.extra.retryAfter === '45'
    );

    await assert.rejects(
      () => makeHttp(500).request('site', 'https://example.com'),
      (err) => err instanceof FinderError && err.code === 'http' && err.extra.status === 500
    );
  });

  await check('http: non-JSON body maps to FinderError code "parse"', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body>Error: Service Unavailable</body></html>',
    });
    const http = createHttp({ fetchImpl });
    await assert.rejects(
      () => http.json('site', 'https://example.com'),
      (err) => err instanceof FinderError && err.code === 'parse'
    );
  });

  await check('http: limiter is awaited before fetch (order of events)', async () => {
    const order = [];
    const limiter = {
      wait: async (key) => {
        order.push(`limit:${key}`);
      },
    };
    const fetchImpl = async () => {
      order.push('fetch');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    };
    const http = createHttp({ fetchImpl, limiter });
    await http.json('mysite', 'https://example.com');
    assert.deepStrictEqual(order, ['limit:mysite', 'fetch'], 'limiter must be awaited before fetch');
  });

  await check('http: error.toJSON() has code+message and no stack', async () => {
    const err = new FinderError('test-code', 'Person-facing error message', { site: 'mw', extraNum: 123 });
    const json = err.toJSON();
    assert.strictEqual(json.code, 'test-code');
    assert.strictEqual(json.message, 'Person-facing error message');
    assert.strictEqual(json.site, 'mw');
    assert.strictEqual(json.extraNum, 123);
    assert.strictEqual(json.stack, undefined);
    assert.strictEqual('stack' in json, false);
  });

  // ── 4. normalize.js ──────────────────────────────────────────────────────

  await check('normalize: htmlToText strips tags, scripts, attributes, decodes entities, caps length, never returns tags', async () => {
    const sample =
      '<h1>Title</h1>' +
      '<p>Para 1 &amp; &lt;b&gt;bold&lt;/b&gt;.</p>' +
      '<script>alert("evil")</script>' +
      '<style>.bad { color: red; }</style>' +
      '<ul><li>Item 1</li><li>Item 2</li></ul>' +
      '<a href="http://example.com" onclick="hack()">Link &quot;quoted&quot;</a>';
    const text = htmlToText(sample);
    assert.ok(!text.includes('<script>'), 'script tag must be removed');
    assert.ok(!text.includes('alert'), 'script content must be removed');
    assert.ok(!text.includes('<style>'), 'style tag must be removed');
    assert.ok(!text.includes('.bad'), 'style content must be removed');
    assert.ok(!text.includes('<a '), 'anchor tag must be removed');
    assert.ok(!text.includes('onclick'), 'attribute must be removed');
    assert.ok(text.includes('Para 1 & <b>bold</b>.'), 'entities must be decoded');
    assert.ok(text.includes('\n- Item 1\n- Item 2'), 'list items formatted with bullets');
    assert.ok(text.includes('Link "quoted"'), 'quot entity decoded');

    // XSS payloads
    const xss = '<img src=x onerror=alert(1)><svg onload="alert(2)"><iframe src="javascript:alert(3)"></iframe>';
    const clean = htmlToText(xss);
    assert.ok(!clean.includes('<img'), 'no img tag');
    assert.ok(!clean.includes('<svg'), 'no svg tag');
    assert.ok(!clean.includes('<iframe'), 'no iframe tag');
    assert.ok(!clean.includes('<'), 'cleaned output must never return HTML tags');

    // Length capping
    const longHtml = '<p>' + 'word '.repeat(300) + '</p>';
    const capped = htmlToText(longHtml, 50);
    assert.ok(capped.length <= 60);
    assert.ok(capped.endsWith('...'));
  });

  await check('normalize: parseLicence handles CC variants, ShareAlike, NoDerivs, Standard Digital, CC0, GPL, unknown, null', async () => {
    const p1 = parseLicence('Creative Commons — Attribution  — Noncommercial');
    assert.strictEqual(p1.label, 'CC BY-NC');
    assert.strictEqual(p1.remix, 'yes');
    assert.strictEqual(p1.commercial, 'no');

    const p2 = parseLicence('Creative Commons — Attribution — ShareAlike — Noncommercial — NoDerivatives');
    assert.strictEqual(p2.label, 'CC BY-NC-SA-ND');
    assert.strictEqual(p2.remix, 'no');
    assert.strictEqual(p2.commercial, 'no');

    const p3 = parseLicence('Standard Digital File License');
    assert.strictEqual(p3.label, 'Standard Digital File License');
    assert.strictEqual(p3.remix, 'no');
    assert.strictEqual(p3.commercial, 'no');

    const p4 = parseLicence('CC0');
    assert.strictEqual(p4.label, 'CC0');
    assert.strictEqual(p4.remix, 'yes');
    assert.strictEqual(p4.commercial, 'yes');

    const p5 = parseLicence('Public Domain');
    assert.strictEqual(p5.label, 'CC0');
    assert.strictEqual(p5.remix, 'yes');
    assert.strictEqual(p5.commercial, 'yes');

    const p6 = parseLicence('GPL-3.0');
    assert.strictEqual(p6.label, 'GPL');
    assert.strictEqual(p6.remix, 'yes');
    assert.strictEqual(p6.commercial, 'yes');

    const p7 = parseLicence('Some In-House Bespoke License');
    assert.strictEqual(p7.label, 'Some In-House Bespoke License');
    assert.strictEqual(p7.remix, 'unknown');
    assert.strictEqual(p7.commercial, 'unknown');

    const p8 = parseLicence(null);
    assert.strictEqual(p8.label, null);
    assert.strictEqual(p8.name, null);
    assert.strictEqual(p8.remix, 'unknown');
    assert.strictEqual(p8.commercial, 'unknown');
  });

  await check('normalize: interleave round-robins across lists and drops duplicate ids', async () => {
    const list1 = [
      { id: '1', title: 'one' },
      { id: '2', title: 'two' },
      { id: '3', title: 'three' },
    ];
    const list2 = [
      { id: '2', title: 'two-dup' },
      { id: '4', title: 'four' },
      { id: '5', title: 'five' },
    ];
    const list3 = [
      { id: '1', title: 'one-dup' },
      { id: '6', title: 'six' },
    ];

    const merged = interleave([list1, list2, list3]);
    const ids = merged.map((m) => m.id);
    assert.deepStrictEqual(ids, ['1', '2', '6', '3', '4', '5']);
  });

  await check('normalize: normalizers check field-by-field against recorded fixtures', async () => {
    const prSearchRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'printables-search.json'), 'utf-8'));
    const prDetailRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'printables-detail.json'), 'utf-8'));

    // Printables search hit
    const prHit = normalizePrintablesHit(prSearchRaw.data.searchPrints2.items[0]);
    assert.ok(prHit);
    assert.strictEqual(typeof prHit.id, 'string');
    assert.strictEqual(prHit.site, 'printables');
    assert.strictEqual(prHit.siteId, '543553');
    assert.match(prHit.url, /^https:\/\/www\.printables\.com\/model\/543553-/);
    assert.match(prHit.cover, /^https:\/\//);
    assert.strictEqual(typeof prHit.likes, 'number');
    assert.strictEqual(typeof prHit.downloads, 'number');
    assert.strictEqual(prHit.licence, 'CC BY-NC');
    assert.strictEqual(prHit.author, 'Pred');
    assert.strictEqual(prHit.authorUrl, 'https://www.printables.com/@Pred');
    // no field is ever the string "undefined" or the value undefined
    for (const [k, v] of Object.entries(prHit)) {
      assert.notStrictEqual(v, undefined, k);
      assert.notStrictEqual(v, 'undefined', k);
    }

    // Printables detail
    const prDetail = normalizePrintablesDetail(prDetailRaw.data.print);
    assert.ok(prDetail);
    assert.strictEqual(prDetail.site, 'printables');
    assert.strictEqual(prDetail.download.available, true);
    assert.ok(Array.isArray(prDetail.files) && prDetail.files.length > 0);

    const hinge = prDetail.files.find((f) => f.name.endsWith('.3mf'));
    assert.ok(hinge);
    assert.strictEqual(hinge.printable, true);
    assert.strictEqual(hinge.downloadable, true);
    assert.strictEqual(hinge.reason, null);

    const cube = prDetail.files.find((f) => f.name === 'cube-20mm.stl');
    assert.ok(cube);
    assert.strictEqual(cube.printable, true);
    assert.strictEqual(cube.downloadable, true);

    const f3d = prDetail.files.find((f) => f.name.endsWith('.f3d'));
    assert.ok(f3d);
    assert.strictEqual(f3d.printable, false);
    assert.strictEqual(f3d.downloadable, false);
    assert.ok(f3d.reason);
    assert.strictEqual(f3d.reasonShort, 'STL and 3MF only');

    const step = prDetail.files.find((f) => f.name.endsWith('.step'));
    assert.ok(step);
    assert.strictEqual(step.printable, false);
    assert.strictEqual(step.downloadable, false);
    assert.ok(step.reason);

    const gcode = prDetail.files.find((f) => f.name.endsWith('.gcode'));
    assert.ok(gcode);
    assert.strictEqual(gcode.printable, false);
    assert.strictEqual(gcode.downloadable, false);
    assert.ok(gcode.reason);
  });

  // ── 5. adapters ──────────────────────────────────────────────────────────

  await check('scope: Printables is the only live site, and the app never presents itself as another program', async () => {
    assert.deepStrictEqual(Object.keys(SITES).sort(), ['cults3d', 'myminifactory', 'printables', 'thingiverse']);
    let captured = null;
    const http = {
      json: async (site, url, opts) => {
        captured = { site, url, opts };
        return { data: { searchPrints2: { totalCount: 0, items: [] } } };
      },
    };
    await createPrintablesAdapter({ http }).search('x');
    const ua = captured.opts.headers['User-Agent'];
    assert.ok(ua.startsWith('ClawSCAD'), `User-Agent should name this app, got ${ua}`);
    assert.ok(!/bambu|prusa|mozilla|chrome/i.test(ua), `User-Agent must not imitate another program: ${ua}`);
  });

  await check('adapters: printables search is GraphQL POST with variables and digits-only id validation', async () => {
    let capturedGql = null;
    const http = {
      json: async (site, url, opts) => {
        capturedGql = { site, url, opts };
        return { data: { searchPrints2: { totalCount: 0, items: [] } } };
      },
    };
    const pr = createPrintablesAdapter({ http });
    await pr.search('hex box', { limit: 15, offset: 30 });

    assert.ok(capturedGql);
    assert.strictEqual(capturedGql.site, 'printables');
    assert.strictEqual(capturedGql.url, 'https://api.printables.com/graphql/');
    assert.ok(!capturedGql.url.includes('www.printables.com'), 'must not query www.printables.com');
    assert.strictEqual(capturedGql.opts.method, 'POST');

    const parsedBody = JSON.parse(capturedGql.opts.body);
    assert.strictEqual(parsedBody.variables.q, 'hex box');
    assert.strictEqual(parsedBody.variables.limit, 15);
    assert.strictEqual(parsedBody.variables.offset, 30);

    // Non-digit id throws bad-request BEFORE any fetch is made
    let fetchCount = 0;
    const httpNoFetch = {
      json: async () => {
        fetchCount++;
      },
    };
    const prGuard = createPrintablesAdapter({ http: httpNoFetch });

    await assert.rejects(
      () => prGuard.detail('abc_not_digits'),
      (err) => err instanceof FinderError && err.code === 'bad-request'
    );
    assert.strictEqual(fetchCount, 0, 'detail must validate id before calling fetch');

    await assert.rejects(
      () => prGuard.downloadLink('bad_print_id', '12345'),
      (err) => err instanceof FinderError && err.code === 'bad-request'
    );
    await assert.rejects(
      () => prGuard.downloadLink('12345', 'bad_file_id'),
      (err) => err instanceof FinderError && err.code === 'bad-request'
    );
    assert.strictEqual(fetchCount, 0, 'downloadLink must validate ids before calling fetch');
  });

  await check('adapters: printables downloadLink validates host via isPrintablesFileUrl and refuses non-printables hosts', async () => {
    assert.strictEqual(isPrintablesFileUrl('https://files.printables.com/fixture/9990001'), true);
    assert.strictEqual(isPrintablesFileUrl('https://printables.com/media/file.stl'), true);
    assert.strictEqual(isPrintablesFileUrl('https://files.printables.com.evil.com/x'), false);
    assert.strictEqual(isPrintablesFileUrl('http://files.printables.com/x'), false);
    assert.strictEqual(isPrintablesFileUrl('ftp://files.printables.com/x'), false);
    assert.strictEqual(isPrintablesFileUrl('not-a-url'), false);

    const httpMalicious = {
      json: async () => ({
        data: {
          getDownloadLink: {
            ok: true,
            output: { link: 'https://files.printables.com.evil.com/fake.stl' },
          },
        },
      }),
    };
    const prMalicious = createPrintablesAdapter({ http: httpMalicious });
    await assert.rejects(
      () => prMalicious.downloadLink('543553', '9990001'),
      (err) => err instanceof FinderError && err.code === 'blocked'
    );
  });

  await check('adapters: Thingiverse, MyMiniFactory and Cults3D are stubs that say "needs API key" and never fetch', async () => {
    const stubs = [
      ['thingiverse', 'Thingiverse', createThingiverseAdapter],
      ['myminifactory', 'MyMiniFactory', createMyMiniFactoryAdapter],
      ['cults3d', 'Cults3D', createCults3dAdapter],
    ];
    for (const [id, label, make] of stubs) {
      const s = make({ env: {} });
      assert.strictEqual(s.id, id);
      assert.strictEqual(s.available, false);
      assert.strictEqual(s.reason, 'needs-key');
      for (const call of [() => s.search('test'), () => s.detail('123'), () => s.download()]) {
        await assert.rejects(call, (err) => {
          assert.ok(err instanceof FinderError);
          assert.strictEqual(err.code, 'needs-key');
          assert.ok(err.message.includes(label) && err.message.includes('API key'), err.message);
          return true;
        });
      }
    }
  });

  await check('adapters: a stub whose key is set still refuses, and says the support is not built', async () => {
    const s = createMyMiniFactoryAdapter({ env: { MYMINIFACTORY_API_KEY: 'sekret-value-123' } });
    await assert.rejects(
      () => s.search('a'),
      (err) => err.code === 'needs-key' && /not built yet/.test(err.message) && !err.message.includes('sekret-value-123') // the key value is never echoed
    );
  });

  // ── 6. index.js createFinder aggregator ──────────────────────────────────

  await check('finder: a default search asks Printables only, and nothing else is ever contacted', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const calls = [];
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR, { calls }),
        minIntervalMs: 0,
      });

      const res = await finder.search({ query: 'gridfinity' });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.items.length, 3);
      assert.ok(res.items.every((i) => i.site === 'printables'));
      assert.deepStrictEqual(Object.keys(res.sites), ['printables']);
      assert.strictEqual(res.sites.printables.status, 'ok');
      assert.ok(calls.length > 0);
      assert.ok(calls.every((c) => new URL(c.url).hostname === 'api.printables.com'), JSON.stringify(calls.map((c) => c.url)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: "fail-pr zzz" reports the Printables failure as a status with code "blocked", not as a crash', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
      });

      const res = await finder.search({ query: 'fail-pr zzz' });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.sites.printables.status, 'error');
      assert.strictEqual(res.sites.printables.error.code, 'blocked');
      assert.deepStrictEqual(res.items, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: a failing stub never hides Printables results when both are asked for', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
      });

      const res = await finder.search({ query: 'gridfinity', sites: ['printables', 'thingiverse', 'myminifactory', 'cults3d'] });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.items.length, 3);
      assert.strictEqual(res.sites.printables.status, 'ok');
      for (const id of ['thingiverse', 'myminifactory', 'cults3d']) {
        assert.strictEqual(res.sites[id].status, 'unavailable', id);
        assert.strictEqual(res.sites[id].error.code, 'needs-key', id);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: "zzempty" search returns items [] and count 0', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
      });

      const res = await finder.search({ query: 'zzempty' });
      assert.strictEqual(res.ok, true);
      assert.deepStrictEqual(res.items, []);
      assert.strictEqual(res.sites.printables.count, 0);
      assert.strictEqual(res.sites.printables.status, 'ok');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: empty, whitespace, and control-character queries return bad-request', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
      });

      for (const badQ of ['', '   ', '\t\n\r', '\u0000\u0007\u001f']) {
        const res = await finder.search({ query: badQ });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error.code, 'bad-request');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: query longer than 200 chars is cut', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
      });

      const longQ = 'a'.repeat(250);
      const res = await finder.search({ query: longQ });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.query.length, 200);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: sites:["thingiverse"] reports status "unavailable"; unknown and removed sites are ignored', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const calls = [];
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR, { calls }),
        minIntervalMs: 0,
      });

      const resTv = await finder.search({ query: 'gridfinity', sites: ['thingiverse'] });
      assert.strictEqual(resTv.ok, true);
      assert.strictEqual(resTv.sites.thingiverse.status, 'unavailable');
      assert.strictEqual(calls.length, 0, 'a stub must not make a request');

      const resIgnored = await finder.search({ query: 'gridfinity', sites: ['printables', 'makerworld', 'nonexistent_site'] });
      assert.strictEqual(resIgnored.ok, true);
      assert.deepStrictEqual(Object.keys(resIgnored.sites), ['printables']);

      // only names that are not sites at all: refused, nothing requested
      const before = calls.length;
      const none = await finder.search({ query: 'gridfinity', sites: ['makerworld'] });
      assert.strictEqual(none.ok, false);
      assert.strictEqual(none.error.code, 'bad-request');
      assert.strictEqual(calls.length, before);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: second identical search is served from cache without extra fetch', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const calls = [];
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR, { calls }),
        minIntervalMs: 0,
      });

      const res1 = await finder.search({ query: 'gridfinity' });
      assert.strictEqual(res1.ok, true);
      const callCountAfterFirst = calls.length;
      assert.ok(callCountAfterFirst > 0);

      const res2 = await finder.search({ query: 'gridfinity' });
      assert.strictEqual(res2.ok, true);
      assert.strictEqual(calls.length, callCountAfterFirst, 'fetch count must remain unchanged for cached query');
      assert.strictEqual(res2.sites.printables.cached, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: after fetch starts failing, an EXPIRED cache entry is served as status "stale"', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      let shouldFail = false;
      const fixture = createFixtureFetch(FIXTURES_DIR);
      const fetchImpl = async (...args) => {
        if (shouldFail) throw new Error('network unreachable');
        return fixture(...args);
      };

      let nowMs = 1000;
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl,
        minIntervalMs: 0,
        now: () => nowMs,
      });

      // 1. Initial success
      const res1 = await finder.search({ query: 'gridfinity' });
      assert.strictEqual(res1.ok, true);
      assert.strictEqual(res1.sites.printables.status, 'ok');
      assert.strictEqual(res1.sites.printables.cached, false);

      // 2. Advance time past SEARCH_TTL_MS and enable failure
      nowMs += SEARCH_TTL_MS + 10000;
      shouldFail = true;

      const resStale = await finder.search({ query: 'gridfinity' });
      assert.strictEqual(resStale.ok, true);
      assert.strictEqual(resStale.sites.printables.status, 'stale');
      assert.strictEqual(resStale.sites.printables.stale, true);
      assert.strictEqual(resStale.sites.printables.cached, true);
      assert.ok(resStale.items.length > 0, 'stale items should still be returned');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: page/limit become offset in the adapter request', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const calls = [];
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR, { calls }),
        minIntervalMs: 0,
      });

      await finder.search({ query: 'gridfinity', page: 2, limit: 10 });
      // page 2 * limit 10 = offset 20
      const call = calls.find((c) => c.method === 'POST' && c.url.includes('api.printables.com') && /searchPrints2/.test(c.body || ''));
      assert.ok(call);
      const vars = JSON.parse(call.body).variables;
      assert.strictEqual(vars.limit, 10);
      assert.strictEqual(vars.offset, 20);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: detail() for printables 543553 is ok, then served from cache', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
      });

      const dPr = await finder.detail({ site: 'printables', id: '543553' });
      assert.strictEqual(dPr.ok, true);
      assert.strictEqual(dPr.cached, false);
      assert.strictEqual(dPr.detail.siteId, '543553');

      const dPrCached = await finder.detail({ site: 'printables', id: '543553' });
      assert.strictEqual(dPrCached.ok, true);
      assert.strictEqual(dPrCached.cached, true);

      // a removed or unknown site is refused, not looked up
      const gone = await finder.detail({ site: 'makerworld', id: '1685835' });
      assert.strictEqual(gone.ok, false);
      assert.strictEqual(gone.error.code, 'bad-request');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: detail() of id "404" returns not-found', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
      });

      const res = await finder.detail({ site: 'printables', id: '404' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error.code, 'not-found');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: download() for a stub site says needs-key, and for an unknown site is refused', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
      });

      const res = await finder.download({ site: 'thingiverse', id: '763622', fileId: '1' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error.code, 'needs-key');
      const gone = await finder.download({ site: 'makerworld', id: '1685835', fileId: '1' });
      assert.strictEqual(gone.ok, false);
      assert.strictEqual(gone.error.code, 'unsupported');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await check('finder: printing=false reports print.available false and printerStatus desktop-only', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-finder-'));
    try {
      const finder = createFinder({
        cacheDir: tmpDir,
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        minIntervalMs: 0,
        printing: false,
      });

      const caps = finder.capabilities();
      assert.strictEqual(caps.ok, true);
      assert.strictEqual(caps.print.available, false);
      assert.ok(caps.print.reason);

      const status = await finder.printerStatus();
      assert.strictEqual(status.ok, false);
      assert.strictEqual(status.error.code, 'desktop-only');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
