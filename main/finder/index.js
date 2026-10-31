// main/finder/index.js — Find & Print, assembled.
//
// createFinder() is the whole feature as plain functions with no Electron in it.
// The desktop app wires it to IPC (main/model-finder.js); web/server.js wires the
// same object to REST routes. Both get identical behaviour because there is one
// implementation.
//
// Results shape (what the renderer sees):
//   search()  { ok, query, page, limit, items[], sites:{ <site>:{ status, count, total,
//               cached, stale, ageMs, error } } }   one site failing never hides another.
//   detail()  { ok, detail }
//   everything that can fail returns { ok:false, error:{ code, message } } — it does
//   not throw across the process boundary.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { FinderError, asFinderError } = require('./errors.js');
const { createRateLimiter } = require('./rate-limiter.js');
const { createCache } = require('./cache.js');
const { createHttp } = require('./http.js');
const { interleave, SITES } = require('./normalize.js');
const { createPrintablesAdapter, USER_AGENT: PRINTABLES_UA } = require('./adapters/printables.js');
const { createThingiverseAdapter, createMyMiniFactoryAdapter, createCults3dAdapter } = require('./adapters/key-stubs.js');
const { downloadModelFile } = require('./download.js');
const { openInClawscad } = require('./checkpoint.js');
const { createRunner } = require('./runner.js');
const { createSlicer } = require('./slicer.js');
const { createPrinter } = require('./printer.js');

const SEARCH_TTL_MS = 15 * 60 * 1000;
const DETAIL_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SITES = ['printables'];
const MAX_QUERY = 200;
const MAX_JOBS = 30;

const DESKTOP_ONLY = 'Printing needs the desktop app: the web build cannot reach the printer on your network.';

function fail(err) {
  const e = asFinderError(err);
  return { ok: false, error: e.toJSON() };
}

function cleanQuery(q) {
  // eslint-disable-next-line no-control-regex
  return String(q == null ? '' : q).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

/**
 * @param {object} opts
 * @param {string} [opts.cacheDir]      directory for the TTL file cache
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {object} [opts.runner]        { run, start } — real or fixture
 * @param {boolean} [opts.printing]     desktop only: slicing + printer
 * @param {object} [opts.env]
 * @param {object} [opts.config]        { slicer:{}, printer:{} } path overrides
 */
function createFinder({ cacheDir, fetchImpl, runner, printing = false, env = process.env, now = () => Date.now(), sleep, minIntervalMs = 1000, config = {}, userAgent } = {}) {
  const limiter = createRateLimiter({ minIntervalMs, now, sleep });
  const cache = createCache({ dir: cacheDir, now });
  const http = createHttp({ fetchImpl, limiter });
  const adapters = {
    printables: createPrintablesAdapter({ http }),
    thingiverse: createThingiverseAdapter({ env }),
    myminifactory: createMyMiniFactoryAdapter({ env }),
    cults3d: createCults3dAdapter({ env }),
  };

  // Tool locations: constants in slicer.js / printer.js, overridable per machine.
  const fromEnv = (map) => Object.fromEntries(Object.entries(map).filter(([, name]) => env && env[name]).map(([key, name]) => [key, env[name]]));
  const slicerConfig = { ...fromEnv({ bambuStudio: 'CLAWSCAD_BAMBU_STUDIO', presetDir: 'CLAWSCAD_P1S_PRESETS', assertStaged: 'CLAWSCAD_ASSERT_STAGED', python: 'CLAWSCAD_PYTHON' }), ...config.slicer };
  const printerConfig = { ...fromEnv({ bambuCtl: 'CLAWSCAD_BAMBU_CTL', python: 'CLAWSCAD_PYTHON' }), ...config.printer };

  const theRunner = runner || createRunner();
  const slicer = printing ? createSlicer({ runner: theRunner, config: slicerConfig, now, sleep }) : null;
  const printer = printing ? createPrinter({ runner: theRunner, config: printerConfig, now }) : null;

  // ── jobs (slicing and printing are minutes long; the UI polls these) ────
  const jobs = new Map();
  function startJob(kind, work) {
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, kind, status: 'running', stage: '', log: [], result: null, error: null, startedAt: now(), endedAt: null };
    jobs.set(id, job);
    while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
    const note = (m) => {
      job.stage = String(m);
      job.log.push(String(m));
      if (job.log.length > 200) job.log.shift();
    };
    (async () => {
      try {
        job.result = await work(note, job);
        job.status = 'done';
      } catch (err) {
        job.error = asFinderError(err).toJSON();
        job.status = 'error';
      } finally {
        job.endedAt = now();
      }
    })();
    return job;
  }
  const publicJob = (j) => ({ id: j.id, kind: j.kind, status: j.status, stage: j.stage, log: j.log.slice(-40), result: j.result, error: j.error, startedAt: j.startedAt, endedAt: j.endedAt });

  // ── search ─────────────────────────────────────────────────────────────

  function describeSites() {
    return Object.values(SITES).map((s) => {
      const a = adapters[s.id];
      return { id: s.id, label: s.label, available: a.available !== false, reason: a.available === false ? a.reason : null };
    });
  }

  async function searchSite(site, query, page, limit) {
    const adapter = adapters[site];
    const offset = page * limit;
    const key = `search|${site}|${query.toLowerCase()}|${offset}|${limit}`;
    const hit = cache.get(key);
    if (hit) return { items: hit.value.items, status: { status: 'ok', count: hit.value.items.length, total: hit.value.total, cached: true, stale: false, ageMs: hit.ageMs } };
    try {
      const out = await adapter.search(query, { limit, offset });
      cache.set(key, { items: out.items, total: out.total }, SEARCH_TTL_MS);
      return { items: out.items, status: { status: 'ok', count: out.items.length, total: out.total, cached: false, stale: false, ageMs: 0 } };
    } catch (err) {
      const e = asFinderError(err);
      if (e.code === 'needs-key' || e.code === 'needs-login') {
        return { items: [], status: { status: 'unavailable', count: 0, total: null, error: e.toJSON() } };
      }
      const old = cache.get(key, { allowStale: true });
      if (old) {
        return { items: old.value.items, status: { status: 'stale', count: old.value.items.length, total: old.value.total, cached: true, stale: true, ageMs: old.ageMs, error: e.toJSON() } };
      }
      return { items: [], status: { status: 'error', count: 0, total: null, error: e.toJSON() } };
    }
  }

  async function search({ query, sites, page = 0, limit = 24 } = {}) {
    const q = cleanQuery(query);
    if (!q) return fail(new FinderError('bad-request', 'Type something to search for.'));
    const wanted = (Array.isArray(sites) && sites.length ? sites : DEFAULT_SITES).filter((s) => Object.prototype.hasOwnProperty.call(adapters, s));
    if (!wanted.length) return fail(new FinderError('bad-request', 'Pick at least one site.'));
    const pg = Math.max(0, Math.min(200, Number(page) | 0));
    const lim = Math.max(1, Math.min(48, Number(limit) | 0 || 24));
    const results = await Promise.all(wanted.map(async (site) => [site, await searchSite(site, q, pg, lim)]));
    const siteStatus = {};
    for (const [site, r] of results) siteStatus[site] = r.status;
    return { ok: true, query: q, page: pg, limit: lim, items: interleave(results.map(([, r]) => r.items)), sites: siteStatus };
  }

  // ── detail ─────────────────────────────────────────────────────────────

  async function getDetail(site, id) {
    const adapter = adapters[site];
    if (!adapter || typeof adapter.detail !== 'function') throw new FinderError('bad-request', 'Unknown site.');
    const key = `detail|${site}|${id}`;
    const hit = cache.get(key);
    if (hit) return { detail: hit.value, cached: true, stale: false };
    try {
      const detail = await adapter.detail(String(id));
      cache.set(key, detail, DETAIL_TTL_MS);
      return { detail, cached: false, stale: false };
    } catch (err) {
      const old = cache.get(key, { allowStale: true });
      if (old && asFinderError(err).code !== 'not-found') return { detail: old.value, cached: true, stale: true };
      throw err;
    }
  }

  async function detail({ site, id } = {}) {
    try {
      const r = await getDetail(String(site), String(id));
      return { ok: true, detail: r.detail, cached: r.cached, stale: r.stale };
    } catch (err) {
      return fail(err);
    }
  }

  // ── files ──────────────────────────────────────────────────────────────

  async function download({ workspaceDir, site, id, fileId } = {}) {
    try {
      if (site !== 'printables') {
        const a = adapters[site];
        if (a && typeof a.download === 'function') await a.download();
        throw new FinderError('unsupported', 'This site does not allow downloads from this app.');
      }
      const { detail: d } = await getDetail('printables', String(id));
      return await downloadModelFile({ adapter: adapters.printables, http, workspaceDir, detail: d, fileId, userAgent: userAgent || PRINTABLES_UA });
    } catch (err) {
      return fail(err);
    }
  }

  async function open({ workspaceDir, site, id, path: relPath, addCheckpoint } = {}) {
    try {
      const { detail: d } = await getDetail(String(site), String(id));
      return openInClawscad({ workspaceDir, detail: d, relPath, addCheckpoint });
    } catch (err) {
      return fail(err);
    }
  }

  // ── printing (desktop only) ─────────────────────────────────────────────

  function capabilities() {
    if (!printing) return { ok: true, print: { available: false, reason: DESKTOP_ONLY }, sites: describeSites() };
    const gaps = [...slicer.missing(), ...printer.available()];
    return {
      ok: true,
      print: { available: gaps.length === 0, reason: gaps.length ? `Not set up on this computer. Missing: ${gaps.join('; ')}.` : null },
      sites: describeSites(),
    };
  }

  const needPrinting = () => {
    if (!printing) throw new FinderError('desktop-only', DESKTOP_ONLY);
  };

  async function printerStatus({ fresh } = {}) {
    try {
      needPrinting();
      return await printer.status({ fresh: Boolean(fresh) });
    } catch (err) {
      return fail(err);
    }
  }

  async function printerSnapshot({ workspaceDir } = {}) {
    try {
      needPrinting();
      return await printer.snapshot({ outDir: path.join(workspaceDir, 'renders', 'finder', 'snapshots') });
    } catch (err) {
      return fail(err);
    }
  }

  /** Slice the chosen file for the chosen AMS slot. Returns a job to poll. */
  async function printPrepare({ workspaceDir, site, id, path: relPath, mapping } = {}) {
    try {
      needPrinting();
      const running = [...jobs.values()].find((j) => j.kind === 'slice' && j.status === 'running');
      if (running) throw new FinderError('busy', 'A model is already being sliced. Wait for it to finish.');
      const { detail: d } = await getDetail(String(site), String(id));
      const job = startJob('slice', async (note) => {
        note('Reading the printer');
        const s = await printer.status({});
        const tray = s.trays.find((t) => t.mapping === Number(mapping));
        if (!tray || tray.empty) throw new FinderError('bad-request', 'That AMS slot is empty. Pick a slot with filament in it.');
        const out = await slicer.slice({ workspaceDir, detail: d, relPath, trayType: tray.type, onProgress: note });
        return { ...out, mapping: tray.mapping, slot: tray.slot, trayColor: tray.color, title: d.title };
      });
      return { ok: true, jobId: job.id };
    } catch (err) {
      return fail(err);
    }
  }

  /** Start the print from a finished slice job. The only call that moves the printer. */
  async function printStart({ workspaceDir, prepareJobId, bedClear, snapshotToken } = {}) {
    try {
      needPrinting();
      const prep = jobs.get(String(prepareJobId));
      if (!prep || prep.kind !== 'slice' || prep.status !== 'done' || !prep.result) {
        throw new FinderError('not-found', 'Slice the model first.');
      }
      const running = [...jobs.values()].find((j) => j.kind === 'print' && j.status === 'running');
      if (running) throw new FinderError('busy', 'A print is already being started.');
      printer.checkConfirmation({ bedClear, snapshotToken }); // refuse at once, before any job exists
      const abs = path.join(workspaceDir, prep.result.gcode3mf);
      const job = startJob('print', async (note) => {
        note('Checking the printer');
        const r = await printer.start({
          gcode3mf: abs,
          rendersDir: path.join(workspaceDir, 'renders', 'finder'),
          mapping: prep.result.mapping,
          name: prep.result.name,
          bedClear,
          snapshotToken,
          onLine: note,
        });
        if (!r.started) throw new FinderError('printer', 'The printer did not reach RUNNING. Look at the printer before trying again.', { output: r.output });
        note('Printing');
        return { started: true, output: r.output };
      });
      return { ok: true, jobId: job.id };
    } catch (err) {
      return fail(err);
    }
  }

  function job(jobId) {
    const j = jobs.get(String(jobId));
    return j ? { ok: true, job: publicJob(j) } : fail(new FinderError('not-found', 'That job is gone.'));
  }

  return {
    search,
    detail,
    download,
    open,
    capabilities,
    printerStatus,
    printerSnapshot,
    printPrepare,
    printStart,
    job,
    describeSites,
    // exposed for tests
    _adapters: adapters,
    _cache: cache,
    _limiter: limiter,
    _slicer: slicer,
    _printer: printer,
  };
}

/**
 * The environment-aware constructor both entry points use. With
 * CLAWSCAD_FINDER_FIXTURES set, nothing real is reachable: sites are answered from
 * recorded files and the slicer / printer tools are replaced by a fake that
 * starts no process.
 */
function createFinderFromEnv({ cacheDir, printing, env = process.env, now } = {}) {
  const fixtures = env.CLAWSCAD_FINDER_FIXTURES;
  if (!fixtures) return createFinder({ cacheDir, printing, env, now });
  const { createFixtureFetch } = require('./fixture-fetch.js');
  const { createFixtureRunner } = require('./fixture-runner.js');
  const dir = path.resolve(fixtures);
  // Tests may shorten the one-per-second rule; production never reads this.
  const raw = env.CLAWSCAD_FINDER_MIN_INTERVAL_MS;
  const minIntervalMs = raw !== undefined && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 1000;
  return createFinder({
    cacheDir,
    printing,
    env,
    now,
    fetchImpl: createFixtureFetch(dir),
    runner: createFixtureRunner(dir, { env }),
    minIntervalMs,
    config: {
      slicer: { bambuStudio: path.join(dir, 'bambu-studio.fixture'), presetDir: path.join(dir, 'presets'), assertStaged: path.join(dir, 'assert_staged.py'), settleMs: 0, pollMs: 5 },
      printer: { bambuCtl: path.join(dir, 'bambu_ctl.py') },
    },
  });
}

module.exports = { createFinder, createFinderFromEnv, cleanQuery, SEARCH_TTL_MS, DETAIL_TTL_MS, DESKTOP_ONLY, DEFAULT_SITES };
