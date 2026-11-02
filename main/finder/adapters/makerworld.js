// main/finder/adapters/makerworld.js — MakerWorld (Bambu Lab) adapter.
//
// Search and detail endpoints use User-Agent: BambuStudio/01.10.00.00 (no login needed).
// Download uses token resolver from main/finder/bambu-token.js with Bearer token auth.
// Validates file download host against *.bblmw.com.
'use strict';

const { FinderError, asFinderError } = require('../errors.js');
const { normalizeMakerWorldHit, normalizeMakerWorldDetail } = require('../normalize.js');
const { resolveBambuToken, dropBambuTokenCache } = require('../bambu-token.js');

const API = 'https://api.bambulab.com';
const USER_AGENT = 'BambuStudio/01.10.00.00';
const LABEL = 'MakerWorld';

function parseModelId(id) {
  const s = String(id || '').trim();
  const m = /^makerworld:(\d{1,12})$/i.exec(s);
  if (m) return m[1];
  if (/^\d{1,12}$/.test(s)) return s;
  return null;
}

function parseInstanceId(id) {
  const s = String(id || '').trim();
  if (/^\d{1,12}$/.test(s)) return s;
  return null;
}

/** A download link is accepted only if it is https on makerworld.bblmw.com or *.bblmw.com */
function isMakerWorldFileUrl(link) {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' && (u.hostname === 'makerworld.bblmw.com' || u.hostname.endsWith('.bblmw.com'));
  } catch {
    return false;
  }
}

function createMakerWorldAdapter({ http, env, tokenResolver = resolveBambuToken }) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

  async function search(query, { limit = 24, offset = 0 } = {}) {
    const url =
      `${API}/v1/search-service/select/design2?keyword=${encodeURIComponent(query)}` +
      `&limit=${Math.max(1, Math.min(60, limit | 0))}&offset=${Math.max(0, offset | 0)}`;
    const body = await http.json('makerworld', url, { headers, label: LABEL });
    const hits = body && Array.isArray(body.hits) ? body.hits : null;
    if (!hits) {
      throw new FinderError('parse', `${LABEL} sent a search answer this app does not understand.`, { site: 'makerworld' });
    }
    return {
      total: Number.isFinite(Number(body.total)) ? Number(body.total) : null,
      items: hits.map(normalizeMakerWorldHit).filter(Boolean),
    };
  }

  async function detail(rawId) {
    const id = parseModelId(rawId);
    if (!id) throw new FinderError('bad-request', 'That is not a MakerWorld model number.');
    const body = await http.json('makerworld', `${API}/v1/design-service/design/${id}`, { headers, label: LABEL });
    const out = normalizeMakerWorldDetail(body);
    if (!out) throw new FinderError('not-found', `${LABEL} has no model ${id}.`, { site: 'makerworld' });
    return out;
  }

  /**
   * Resolves download URL for a 3MF print profile instance.
   *
   * @param {string} rawModelId
   * @param {string} rawInstanceId
   * @returns {Promise<string>}
   */
  async function downloadLink(rawModelId, rawInstanceId) {
    const instanceId = parseInstanceId(rawInstanceId);
    if (!instanceId) throw new FinderError('bad-request', 'That is not a MakerWorld instance number.');

    const token = tokenResolver({ env });
    if (!token) {
      throw new FinderError('needs-login', 'MakerWorld login expired or missing — the agent refreshes bambu-cloud-token', {
        site: 'makerworld',
      });
    }

    const authHeaders = {
      ...headers,
      Authorization: `Bearer ${token}`,
    };

    let body;
    try {
      body = await http.json('makerworld', `${API}/v1/design-service/instance/${instanceId}/f3mf?type=download`, {
        headers: authHeaders,
        label: LABEL,
      });
    } catch (err) {
      const e = asFinderError(err);
      if (e.code === 'needs-login' || err.status === 401 || err.status === 403 || e.status === 401 || e.status === 403 || e.code === 'blocked') {
        dropBambuTokenCache();
        throw new FinderError('needs-login', 'MakerWorld login expired or missing — the agent refreshes bambu-cloud-token', {
          site: 'makerworld',
        });
      }
      throw err;
    }

    if (body && (body.code === 1 || body.error === 'Please log in to download models.')) {
      dropBambuTokenCache();
      throw new FinderError('needs-login', 'MakerWorld login expired or missing — the agent refreshes bambu-cloud-token', {
        site: 'makerworld',
      });
    }

    if (!body || typeof body.url !== 'string') {
      throw new FinderError('parse', `${LABEL} sent a download answer this app does not understand.`, { site: 'makerworld' });
    }

    if (!isMakerWorldFileUrl(body.url)) {
      throw new FinderError('blocked', `${LABEL} sent a download link on an unexpected host, so it was not followed.`, { site: 'makerworld' });
    }

    return body.url;
  }

  return { id: 'makerworld', label: LABEL, available: true, search, detail, downloadLink };
}

module.exports = {
  createMakerWorldAdapter,
  isMakerWorldFileUrl,
  USER_AGENT,
  API,
};
