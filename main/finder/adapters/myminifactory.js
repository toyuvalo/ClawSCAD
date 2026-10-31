// main/finder/adapters/myminifactory.js — MyMiniFactory REST API v2.
// Pinned doc: E:\Claude\raw\clippings\2026-10-31-myminifactory-api-openapi.yaml
'use strict';

const { FinderError } = require('../errors.js');
const { normalizeMyMiniFactoryHit, normalizeMyMiniFactoryDetail } = require('../normalize.js');

const API_BASE = 'https://www.myminifactory.com/api/v2';
const LABEL = 'MyMiniFactory';
const ENV_VAR = 'MYMINIFACTORY_API_KEY';
const USER_AGENT = 'ClawSCAD-FindPrint/0.8 (personal use; github.com/toyuvalo/ClawSCAD)';

function parseModelId(id) {
  const s = String(id || '').trim();
  const m = /^myminifactory:(\d{1,12})$/i.exec(s);
  if (m) return m[1];
  if (/^\d{1,12}$/.test(s)) return s;
  return null;
}

function createMyMiniFactoryAdapter({ http, env = process.env } = {}) {
  const key = env && env[ENV_VAR];
  const hasKey = Boolean(key);

  if (!hasKey) {
    const unavailable = () =>
      new FinderError('needs-key', `${LABEL} needs an API key, which this app does not have yet.`, { site: 'myminifactory' });
    return {
      id: 'myminifactory',
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
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };

  async function search(query, { limit = 24, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(60, limit | 0));
    const page = Math.floor(Math.max(0, offset | 0) / lim) + 1;
    const url = `${API_BASE}/search?q=${encodeURIComponent(String(query))}&page=${page}&per_page=${lim}&key=${encodeURIComponent(key)}`;
    const data = await http.json('myminifactory', url, { headers, label: LABEL });
    if (!data || !Array.isArray(data.items)) {
      throw new FinderError('parse', `${LABEL} sent a search answer this app does not understand.`, { site: 'myminifactory' });
    }
    return {
      total: Number.isFinite(Number(data.total_count)) ? Number(data.total_count) : null,
      items: data.items.map(normalizeMyMiniFactoryHit).filter(Boolean),
    };
  }

  async function detail(rawId) {
    const id = parseModelId(rawId);
    if (!id) throw new FinderError('bad-request', 'That is not a MyMiniFactory model number.');
    const url = `${API_BASE}/objects/${id}?key=${encodeURIComponent(key)}`;
    const obj = await http.json('myminifactory', url, { headers, label: LABEL });
    const out = obj ? normalizeMyMiniFactoryDetail(obj) : null;
    if (!out) throw new FinderError('not-found', `${LABEL} has no model ${id}.`, { site: 'myminifactory' });
    return out;
  }

  async function download() {
    throw new FinderError('unsupported', `${LABEL} does not allow file downloads with an API key (OAuth login required).`, { site: 'myminifactory' });
  }

  async function downloadLink() {
    throw new FinderError('unsupported', `${LABEL} does not allow file downloads with an API key (OAuth login required).`, { site: 'myminifactory' });
  }

  return { id: 'myminifactory', label: LABEL, available: true, search, detail, download, downloadLink };
}

module.exports = { createMyMiniFactoryAdapter, USER_AGENT, API_BASE };
