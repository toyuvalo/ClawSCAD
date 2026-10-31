// main/finder/adapters/makerworld.js — MakerWorld (Bambu Lab), read-only.
//
// Verified 2026-10-31, one request each, no account:
//   GET api.bambulab.com/v1/search-service/select/design2?keyword=&limit=&offset=
//   GET api.bambulab.com/v1/design-service/design/{id}
// both with `User-Agent: BambuStudio/01.10.00.00`.
//
// Download is NOT here and cannot be: the file link comes from an endpoint that
// answers 401 without a Bambu account token. This app holds no such token, so
// the adapter says so (`needs-login`) and the UI offers "Open on MakerWorld".
'use strict';

const { FinderError } = require('../errors.js');
const { normalizeMakerWorldHit, normalizeMakerWorldDetail } = require('../normalize.js');

const API = 'https://api.bambulab.com';
const USER_AGENT = 'BambuStudio/01.10.00.00';
const LABEL = 'MakerWorld';

function createMakerWorldAdapter({ http }) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

  async function search(query, { limit = 24, offset = 0 } = {}) {
    const url =
      `${API}/v1/search-service/select/design2?keyword=${encodeURIComponent(query)}` +
      `&limit=${Math.max(1, Math.min(60, limit | 0))}&offset=${Math.max(0, offset | 0)}`;
    const body = await http.json('makerworld', url, { headers, label: LABEL });
    const hits = body && Array.isArray(body.hits) ? body.hits : null;
    if (!hits) throw new FinderError('parse', `${LABEL} sent a search answer this app does not understand.`, { site: 'makerworld' });
    return {
      total: Number.isFinite(Number(body.total)) ? Number(body.total) : null,
      items: hits.map(normalizeMakerWorldHit).filter(Boolean),
    };
  }

  async function detail(id) {
    if (!/^\d{1,12}$/.test(String(id))) throw new FinderError('bad-request', 'That is not a MakerWorld model number.');
    const body = await http.json('makerworld', `${API}/v1/design-service/design/${id}`, { headers, label: LABEL });
    const out = normalizeMakerWorldDetail(body);
    if (!out) throw new FinderError('not-found', `${LABEL} has no model ${id}.`, { site: 'makerworld' });
    return out;
  }

  async function download() {
    throw new FinderError('needs-login', 'MakerWorld downloads need a Bambu account login. Open the model on MakerWorld instead.', {
      site: 'makerworld',
    });
  }

  return { id: 'makerworld', label: LABEL, search, detail, download };
}

module.exports = { createMakerWorldAdapter, USER_AGENT };
