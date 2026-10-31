// main/finder/fixture-fetch.js — an offline stand-in for Printables.
//
// Switched on ONLY by CLAWSCAD_FINDER_FIXTURES=<dir> (see index.js). It answers
// the exact URLs the adapters use from the recorded responses in
// tests/fixtures/finder/, so the Playwright specs and the harness tests run
// without the network, without hitting anybody's server, and give the same
// answer every time. Special search words steer the failure paths:
//
//   "zzempty"  -> no results
//   "fail-pr"  -> Printables answers 403 (the Cloudflare case)
//
// Any other host gets a 404 and is recorded in `calls`, so a test can assert that
// nothing else was ever contacted.
//
// File 9990001 is a synthetic 20 mm cube STL (684 bytes) so a download can be
// verified end to end; every other file id gets a tiny 3MF that will, by design,
// fail the size check against the real listed size.
'use strict';

const fs = require('fs');
const path = require('path');
const { createZip } = require('./zip.js');

/** A binary STL cube from (0,0,0) to (s,s,s): 12 triangles, 684 bytes. */
function makeCubeStl(s = 20) {
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ];
  const f = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = Buffer.alloc(84 + f.length * 50);
  buf.write('fixture cube', 0, 'latin1');
  buf.writeUInt32LE(f.length, 80);
  let off = 84;
  for (const tri of f) {
    off += 12;
    for (const idx of tri) for (const c of v[idx]) { buf.writeFloatLE(c, off); off += 4; }
    off += 2;
  }
  return buf;
}

/** A minimal valid 3MF holding one tetrahedron. */
function makeTinyThreeMf() {
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>' +
    '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>' +
    '<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object>' +
    '</resources><build><item objectid="1"/></build></model>';
  return createZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '3D/3dmodel.model', data: model },
  ]);
}

function createFixtureFetch(dir, { calls } = {}) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8').replace(/^﻿/, ''));
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const bytes = (buf, type) => new Response(buf, { status: 200, headers: { 'content-type': type, 'content-length': String(buf.length) } });

  return async function fixtureFetch(url, init = {}) {
    const u = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (calls) calls.push({ method, url: String(url) });

    if (u.hostname === 'api.printables.com' && method === 'POST') {
      const payload = JSON.parse(String(init.body || '{}'));
      const q = String(payload.query || '');
      if (q.includes('searchPrints2')) {
        const term = String((payload.variables && payload.variables.q) || '').toLowerCase();
        if (term.includes('fail-pr')) return json({ error: 'forbidden' }, 403);
        if (term.includes('zzempty')) return json(read('printables-search-empty.json'));
        const body = read('printables-search.json');
        const offset = Number((payload.variables && payload.variables.offset) || 0);
        if (offset >= 3) return json({ data: { searchPrints2: { totalCount: body.data.searchPrints2.totalCount, items: [] } } });
        return json(body);
      }
      if (q.includes('getDownloadLink')) {
        const id = /id:\s*"(\d+)"/.exec(q);
        const body = read('printables-download-link.json');
        body.data.getDownloadLink.output.link = `https://files.printables.com/fixture/${id ? id[1] : '0'}`;
        return json(body);
      }
      if (q.includes('print(id')) {
        const id = String((payload.variables && payload.variables.id) || '');
        return id === '404' ? json({ data: { print: null } }) : json(read('printables-detail.json'));
      }
    }

    if (u.hostname === 'files.printables.com' && u.pathname.startsWith('/fixture/')) {
      const id = u.pathname.split('/').pop();
      return id === '9990001' ? bytes(makeCubeStl(20), 'model/stl') : bytes(makeTinyThreeMf(), 'application/vnd.ms-3mfdocument');
    }

    return json({ error: `fixture fetch has no answer for ${method} ${url}` }, 404);
  };
}

module.exports = { createFixtureFetch, makeCubeStl, makeTinyThreeMf };
