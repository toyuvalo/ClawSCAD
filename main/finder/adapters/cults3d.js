// main/finder/adapters/cults3d.js — Cults3D GraphQL API.
// Pinned doc: E:\Claude\raw\clippings\2026-10-31-cults3d-graphql-api.md
'use strict';

const { FinderError } = require('../errors.js');
const { normalizeCults3dHit, normalizeCults3dDetail } = require('../normalize.js');

const GRAPHQL = 'https://cults3d.com/graphql';
const LABEL = 'Cults3D';
const ENV_VAR = 'CULTS3D_API_KEY';
const ENV_USER = 'CULTS3D_USERNAME';
const USER_AGENT = 'ClawSCAD-FindPrint/0.8 (personal use; github.com/toyuvalo/ClawSCAD)';

const SEARCH_QUERY = `query SearchCreations($query: String!, $limit: Int, $offset: Int) {
  creationsSearchBatch(query: $query, limit: $limit, offset: $offset) {
    total
    results {
      id
      name(locale: EN)
      slug
      shortUrl
      url(locale: EN)
      illustrationImageUrl
      likesCount
      downloadsCount
      viewsCount
      license {
        name(locale: EN)
      }
      creator {
        nick
        shortUrl
      }
    }
  }
}`;

const DETAIL_QUERY = `query ShowCreation($slug: String!) {
  creation(slug: $slug) {
    id
    name(locale: EN)
    slug
    shortUrl
    url(locale: EN)
    description(locale: EN)
    illustrationImageUrl
    illustrations {
      imageUrl
    }
    publishedAt
    likesCount
    downloadsCount
    viewsCount
    tags(locale: EN)
    category {
      name(locale: EN)
    }
    license {
      name(locale: EN)
    }
    creator {
      nick
      shortUrl
    }
    blueprints {
      fileUrl
      imageUrl
    }
  }
}`;

function parseCultsId(id) {
  const s = String(id || '').trim();
  const m = /^cults3d:(.+)$/i.exec(s);
  if (m) return m[1].trim();
  return s || null;
}

function createCults3dAdapter({ http, env = process.env } = {}) {
  const key = env && env[ENV_VAR];
  const user = env && env[ENV_USER];
  const hasKey = Boolean(key && user);

  if (!hasKey) {
    const unavailable = () =>
      new FinderError('needs-key', `${LABEL} needs an API key, which this app does not have yet.`, { site: 'cults3d' });
    return {
      id: 'cults3d',
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

  const basicAuth = 'Basic ' + Buffer.from(`${user}:${key}`).toString('base64');
  const headers = {
    Authorization: basicAuth,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };

  async function gql(query, variables) {
    const body = await http.json('cults3d', GRAPHQL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      label: LABEL,
    });
    if (body && Array.isArray(body.errors) && body.errors.length && !body.data) {
      throw new FinderError('parse', `${LABEL} rejected the request: ${String(body.errors[0].message || 'unknown error').slice(0, 160)}`, {
        site: 'cults3d',
      });
    }
    if (!body || !body.data) throw new FinderError('parse', `${LABEL} sent an answer this app does not understand.`, { site: 'cults3d' });
    return body.data;
  }

  async function search(query, { limit = 24, offset = 0 } = {}) {
    const data = await gql(SEARCH_QUERY, {
      query: String(query),
      limit: Math.max(1, Math.min(60, limit | 0)),
      offset: Math.max(0, offset | 0),
    });
    const batch = data.creationsSearchBatch;
    if (!batch || !Array.isArray(batch.results)) {
      throw new FinderError('parse', `${LABEL} sent a search answer this app does not understand.`, { site: 'cults3d' });
    }
    return {
      total: Number.isFinite(Number(batch.total)) ? Number(batch.total) : null,
      items: batch.results.map(normalizeCults3dHit).filter(Boolean),
    };
  }

  async function detail(rawId) {
    const slug = parseCultsId(rawId);
    if (!slug) throw new FinderError('bad-request', 'That is not a Cults3D model identifier.');
    const data = await gql(DETAIL_QUERY, { slug: String(slug) });
    const out = data.creation ? normalizeCults3dDetail(data.creation) : null;
    if (!out) throw new FinderError('not-found', `${LABEL} has no model ${slug}.`, { site: 'cults3d' });
    return out;
  }

  async function download() {
    throw new FinderError('unsupported', `${LABEL} does not provide file downloads via its API.`, { site: 'cults3d' });
  }

  async function downloadLink() {
    throw new FinderError('unsupported', `${LABEL} does not provide file downloads via its API.`, { site: 'cults3d' });
  }

  return { id: 'cults3d', label: LABEL, available: true, search, detail, download, downloadLink };
}

module.exports = { createCults3dAdapter, USER_AGENT, GRAPHQL };
