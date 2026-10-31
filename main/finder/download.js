// main/finder/download.js — fetch ONE model file into the workspace.
//
//   <workspace>/models/<site>-<id>/<file>      the downloaded file
//   <workspace>/models/<site>-<id>/source.json where it came from
//
// Limits that are on purpose: one file per call (no bulk download), STL and 3MF
// only, a size cap, a download link must be https on the site's own host, the
// file name is reduced to a safe name, and the final path is checked to sit in
// the model's folder. A file is written to `<name>.part` and renamed only after
// its size and its first bytes check out, so a broken download never looks like
// a model. Files stay on this machine; nothing here uploads or re-hosts them.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FinderError } = require('./errors.js');
const { modelDir, safeFileName, isReallyInside, toRel } = require('./paths.js');
const { isBinaryStl } = require('./mesh.js');

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const ALLOWED = new Set(['stl', '3mf']);

/** First bytes must look like what the extension says. */
function looksLike(kind, head, size) {
  if (kind === '3mf') return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (kind === 'stl') {
    if (/^\s*solid/i.test(head.subarray(0, 64).toString('latin1'))) return true;
    return head.length >= 84 && 84 + head.readUInt32LE(80) * 50 === size;
  }
  return false;
}

function readHead(file, n = 128) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * @param {object} p
 * @param {object} p.adapter      printables adapter (downloadLink)
 * @param {object} p.http         createHttp() result
 * @param {string} p.workspaceDir
 * @param {object} p.detail       normalized detail for the model
 * @param {string} p.fileId
 * @param {number} [p.maxBytes]
 * @param {()=>string} [p.nowIso]
 */
async function downloadModelFile({ adapter, http, workspaceDir, detail, fileId, maxBytes = DEFAULT_MAX_BYTES, nowIso = () => new Date().toISOString(), userAgent }) {
  if (!detail || !Array.isArray(detail.files)) throw new FinderError('bad-request', 'No model details to download from.');
  if (Array.isArray(fileId)) throw new FinderError('bad-request', 'Download one file at a time.');
  const file = detail.files.find((f) => f.id === String(fileId));
  if (!file) throw new FinderError('not-found', 'That file is not part of this model.');
  if (!file.downloadable || !ALLOWED.has(file.kind)) {
    throw new FinderError('unsupported', file.reason || 'This app downloads STL and 3MF files only.');
  }
  if (file.size && file.size > maxBytes) {
    throw new FinderError('too-large', `That file is ${(file.size / 1048576).toFixed(0)} MB, over the ${(maxBytes / 1048576).toFixed(0)} MB limit.`);
  }

  const dir = modelDir(workspaceDir, detail.site, detail.siteId);
  fs.mkdirSync(dir, { recursive: true });
  const name = safeFileName(file.name);
  let dest = path.join(dir, name);
  if (!isReallyInside(dir, dest)) throw new FinderError('path', 'That file name is not allowed.');

  // Already here, intact, same size: do not ask the site again.
  try {
    const st = fs.lstatSync(dest);
    if (st.isFile() && !st.isSymbolicLink() && (!file.size || st.size === file.size) && looksLike(file.kind, readHead(dest), st.size)) {
      const sha256 = sha256File(dest);
      writeSource(dir, detail, file, { name, size: st.size, sha256 }, nowIso);
      return result(workspaceDir, dest, name, st.size, sha256, file.kind, true);
    }
  } catch {
    /* not downloaded yet */
  }

  const link = await adapter.downloadLink(detail.siteId, file.id);
  const part = dest + '.part';
  fs.rmSync(part, { force: true });

  const res = await http.request('printables', link, {
    as: 'response',
    rateKey: 'printables',
    headers: { 'User-Agent': userAgent || 'ClawSCAD-FindPrint/0.8' },
    timeoutMs: 120000,
    label: 'Printables',
  });
  let bytes = 0;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(part, 'w');
  try {
    if (!res.body) throw new FinderError('network', 'Printables sent an empty download.');
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new FinderError('too-large', `The download passed the ${(maxBytes / 1048576).toFixed(0)} MB limit and was stopped.`);
      hash.update(chunk);
      fs.writeSync(fd, chunk);
    }
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(part, { force: true });
    if (err instanceof FinderError) throw err;
    throw new FinderError('network', 'The download stopped part way. Try again.');
  } finally {
    if (res.release) res.release();
  }
  try {
    fs.closeSync(fd);
  } catch {
    /* already closed in the error path */
  }

  if (!bytes || (file.size && bytes !== file.size)) {
    fs.rmSync(part, { force: true });
    throw new FinderError('incomplete', `The download was ${bytes} bytes but the site listed ${file.size}. It was discarded.`);
  }
  if (!looksLike(file.kind, readHead(part), bytes)) {
    fs.rmSync(part, { force: true });
    throw new FinderError('unsupported', `The downloaded file is not a valid ${file.kind.toUpperCase()}. It was discarded.`);
  }

  const digest = hash.digest('hex');
  if (fs.existsSync(dest)) {
    // Same name, different bytes: never overwrite; keep both.
    const ext = path.extname(name);
    dest = path.join(dir, `${path.basename(name, ext)}-${digest.slice(0, 6)}${ext}`);
  }
  fs.renameSync(part, dest);
  const finalName = path.basename(dest);
  writeSource(dir, detail, file, { name: finalName, size: bytes, sha256: digest }, nowIso);
  return result(workspaceDir, dest, finalName, bytes, digest, file.kind, false);
}

function result(workspaceDir, abs, name, size, sha256, kind, cached) {
  return { ok: true, cached, path: toRel(workspaceDir, abs), name, size, sha256, kind };
}

/** source.json: provenance for everything in the folder. Written atomically. */
function writeSource(dir, detail, file, saved, nowIso) {
  const sourcePath = path.join(dir, 'source.json');
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
  } catch {
    /* first file for this model */
  }
  const now = nowIso();
  const files = Array.isArray(prev && prev.files) ? prev.files.filter((f) => f.name !== saved.name) : [];
  files.push({ id: file.id, name: saved.name, size: saved.size, sha256: saved.sha256, fetched: now });
  const doc = {
    schema: 1,
    site: detail.site,
    id: detail.siteId,
    title: detail.title,
    url: detail.url,
    author: detail.author,
    authorUrl: detail.authorUrl,
    licence: detail.licence,
    licenceName: detail.licenceName,
    licenceUrl: (detail.licenceInfo && detail.licenceInfo.url) || null,
    fetched: (prev && prev.fetched) || now,
    updated: now,
    note: 'Downloaded for personal use. Keep the author credit and the licence. Do not re-host these files.',
    files,
  };
  const tmp = sourcePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, sourcePath);
  return doc;
}

module.exports = { downloadModelFile, writeSource, looksLike, DEFAULT_MAX_BYTES, isBinaryStl };
