// main/finder/adapters/thingiverse.js — Thingiverse REST API.
// Pinned doc: E:\Claude\raw\clippings\2026-10-31-thingiverse-api-openapi.yaml
'use strict';

const { FinderError } = require('../errors.js');
const { normalizeThingiverseHit, normalizeThingiverseDetail } = require('../normalize.js');

const API_BASE = 'https://api.thingiverse.com';
const LABEL = 'Thingiverse';
const ENV_VAR = 'THINGIVERSE_API_TOKEN';
const USER_AGENT = 'ClawSCAD-FindPrint/0.8 (personal use; github.com/toyuvalo/ClawSCAD)';

function parseModelId(id) {
  const s = String(id || '').trim();
  const m = /^thingiverse:(\d{1,12})$/i.exec(s);
  if (m) return m[1];
  if (/^\d{1,12}$/.test(s)) return s;
  return null;
}

function parseFileId(id) {
  const s = String(id || '').trim();
  if (/^\d{1,12}$/.test(s)) return s;
  return null;
}

function isThingiverseFileUrl(link) {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' && (u.hostname === 'thingiverse.com' || u.hostname.endsWith('.thingiverse.com'));
  } catch {
    return false;
  }
}

function createThingiverseAdapter({ http, env = process.env } = {}) {
  const token = env && env[ENV_VAR];
  const hasKey = Boolean(token);

  if (!hasKey) {
    const unavailable = () =>
      new FinderError('needs-key', `${LABEL} needs an API key, which this app does not have yet.`, { site: 'thingiverse' });
    return {
      id: 'thingiverse',
      label: LABEL,
      available: false,
      reason: 'needs-key',
      envVar: ENV_VAR,
      async search() {
        throw unavailable();
      },
      async detail() {
        throw unavailable();
      },
      async download() {
        throw unavailable();
      },
      async downloadLink() {
        throw unavailable();
      },
    };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };

  async function search(query, { limit = 24, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(60, limit | 0));
    const page = Math.floor(Math.max(0, offset | 0) / lim) + 1;
    const url = `${API_BASE}/search/${encodeURIComponent(String(query))}/?type=things&page=${page}&per_page=${lim}`;
    const data = await http.json('thingiverse', url, { headers, label: LABEL });
    if (!data || !Array.isArray(data.hits)) {
      throw new FinderError('parse', `${LABEL} sent a search answer this app does not understand.`, { site: 'thingiverse' });
    }
    return {
      total: Number.isFinite(Number(data.total)) ? Number(data.total) : null,
      items: data.hits.map(normalizeThingiverseHit).filter(Boolean),
    };
  }

  async function detail(rawId) {
    const id = parseModelId(rawId);
    if (!id) throw new FinderError('bad-request', 'That is not a Thingiverse model number.');
    const thingUrl = `${API_BASE}/things/${id}`;
    const filesUrl = `${API_BASE}/things/${id}/files`;

    const [thing, files] = await Promise.all([
      http.json('thingiverse', thingUrl, { headers, label: LABEL }),
      http.json('thingiverse', filesUrl, { headers, label: LABEL }).catch(() => []),
    ]);

    const out = normalizeThingiverseDetail(thing, Array.isArray(files) ? files : []);
    if (!out) throw new FinderError('not-found', `${LABEL} has no model ${id}.`, { site: 'thingiverse' });
    return out;
  }

  async function downloadLink(rawThingId, rawFileId) {
    const thingId = parseModelId(rawThingId);
    const fileId = parseFileId(rawFileId);
    if (!thingId || !fileId) throw new FinderError('bad-request', 'That is not a Thingiverse file number.');

    const filesUrl = `${API_BASE}/things/${thingId}/files`;
    const files = await http.json('thingiverse', filesUrl, { headers, label: LABEL }).catch(() => []);
    let link = null;
    if (Array.isArray(files)) {
      const match = files.find((f) => String(f.id) === fileId);
      if (match) {
        link = match.direct_url || match.download_url;
      }
    }
    if (!link) {
      link = `${API_BASE}/files/${fileId}/download`;
    }
    if (!isThingiverseFileUrl(link)) {
      throw new FinderError('blocked', `${LABEL} sent a download link on an unexpected host, so it was not followed.`, { site: 'thingiverse' });
    }
    return link;
  }

  return { id: 'thingiverse', label: LABEL, available: true, search, detail, downloadLink };
}

module.exports = { createThingiverseAdapter, isThingiverseFileUrl, USER_AGENT, API_BASE };
