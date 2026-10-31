// main/finder/adapters/printables.js — Printables (Prusa Research), anonymous.
//
// Verified 2026-10-31, one request each, no account, no cookies:
//   POST https://api.printables.com/graphql/        (the www. host answers 403)
//     searchPrints2(query, limit, offset) { totalCount items { ... } }
//     print(id) { stls gcodes slas otherFiles images license { ... } ... }
//     getDownloadLink(id, printId, fileType: stl, source: model_detail)
//       { ok errors output { link count ttl } }       -> a files.printables.com URL
// Introspection is switched off on the server, so these field names were found
// by probing, not read from a schema. `searchPrints2` has `totalCount`, not
// `total` (the pinned research note had it wrong).
//
// The file link points at files.printables.com. We refuse any other host: the
// link comes out of a JSON answer, and following an arbitrary URL from one is
// how a download feature becomes a request-forgery tool.
'use strict';

const { FinderError } = require('../errors.js');
const { normalizePrintablesHit, normalizePrintablesDetail } = require('../normalize.js');

const GRAPHQL = 'https://api.printables.com/graphql/';
const LABEL = 'Printables';
const USER_AGENT = 'ClawSCAD-FindPrint/0.8 (personal use; github.com/toyuvalo/ClawSCAD)';

const SEARCH_QUERY = `query Search($q: String!, $limit: Int, $offset: Int) {
  searchPrints2(query: $q, limit: $limit, offset: $offset) {
    totalCount
    items {
      id name slug likesCount downloadCount
      license { id name abbreviation }
      user { id publicUsername }
      images { filePath }
    }
  }
}`;

const DETAIL_QUERY = `query Detail($id: ID!) {
  print(id: $id) {
    id name slug summary description datePublished likesCount downloadCount
    tags { name }
    category { id name }
    user { id publicUsername avatarFilePath }
    license { id name abbreviation content disallowRemixing }
    stls { id name fileSize filePreviewPath folder note order }
    gcodes { id name fileSize }
    slas { id name fileSize }
    otherFiles { id name fileSize }
    images { filePath rotation }
  }
}`;

const isId = (v) => /^\d{1,12}$/.test(String(v));

function parseModelId(id) {
  const s = String(id || '').trim();
  const m = /^printables:(\d{1,12})$/i.exec(s);
  if (m) return m[1];
  if (/^\d{1,12}$/.test(s)) return s;
  return null;
}

/** A download link is accepted only if it is https on a printables.com host. */
function isPrintablesFileUrl(link) {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' && (u.hostname === 'printables.com' || u.hostname.endsWith('.printables.com'));
  } catch {
    return false;
  }
}

function createPrintablesAdapter({ http }) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' };

  async function gql(query, variables) {
    const body = await http.json('printables', GRAPHQL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      label: LABEL,
    });
    if (body && Array.isArray(body.errors) && body.errors.length && !body.data) {
      throw new FinderError('parse', `${LABEL} rejected the request: ${String(body.errors[0].message || 'unknown error').slice(0, 160)}`, {
        site: 'printables',
      });
    }
    if (!body || !body.data) throw new FinderError('parse', `${LABEL} sent an answer this app does not understand.`, { site: 'printables' });
    return body.data;
  }

  async function search(query, { limit = 24, offset = 0 } = {}) {
    const data = await gql(SEARCH_QUERY, {
      q: String(query),
      limit: Math.max(1, Math.min(60, limit | 0)),
      offset: Math.max(0, offset | 0),
    });
    const list = data.searchPrints2;
    if (!list || !Array.isArray(list.items)) {
      throw new FinderError('parse', `${LABEL} sent a search answer this app does not understand.`, { site: 'printables' });
    }
    return {
      total: Number.isFinite(Number(list.totalCount)) ? Number(list.totalCount) : null,
      items: list.items.map(normalizePrintablesHit).filter(Boolean),
    };
  }

  async function detail(rawId) {
    const id = parseModelId(rawId);
    if (!id) throw new FinderError('bad-request', 'That is not a Printables model number.');
    const data = await gql(DETAIL_QUERY, { id: String(id) });
    const out = data.print ? normalizePrintablesDetail(data.print) : null;
    if (!out) throw new FinderError('not-found', `${LABEL} has no model ${id}.`, { site: 'printables' });
    return out;
  }

  /**
   * Asks for a short-lived link to ONE file. Ids are digits-only (checked here)
   * and the enum values are literals, so nothing user-typed reaches the query.
   * @returns {Promise<string>} the https link on a printables.com host
   */
  async function downloadLink(rawPrintId, rawFileId) {
    const printId = parseModelId(rawPrintId);
    const fileId = String(rawFileId || '').trim();
    if (!printId || !isId(fileId)) throw new FinderError('bad-request', 'That is not a Printables file number.');
    const query =
      `mutation { getDownloadLink(id: "${fileId}", printId: "${printId}", fileType: stl, source: model_detail) ` +
      `{ ok errors { field messages } output { link count ttl } } }`;
    const data = await gql(query);
    const r = data.getDownloadLink;
    if (!r || !r.ok || !r.output || typeof r.output.link !== 'string') {
      const why = r && Array.isArray(r.errors) && r.errors[0] && Array.isArray(r.errors[0].messages) ? r.errors[0].messages[0] : null;
      throw new FinderError('needs-login', `${LABEL} would not give a download link${why ? ` (${String(why).slice(0, 120)})` : ''}. The file may need a login.`, {
        site: 'printables',
      });
    }
    if (!isPrintablesFileUrl(r.output.link)) {
      throw new FinderError('blocked', `${LABEL} sent a download link on an unexpected host, so it was not followed.`, { site: 'printables' });
    }
    return r.output.link;
  }

  return { id: 'printables', label: LABEL, search, detail, downloadLink };
}

module.exports = { createPrintablesAdapter, isPrintablesFileUrl, USER_AGENT, GRAPHQL };
