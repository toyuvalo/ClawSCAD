// main/finder/paths.js — every path Find & Print writes or reads is built here.
//
// The rule: a file name or a model id that arrives from a website, or from the
// renderer, is DATA. It never becomes a path until it has been reduced to a safe
// name and the final absolute path has been checked to sit inside the folder it
// was meant for. Lexical checks alone miss a symlink that points out of the tree,
// so containment is tested on real paths where they exist.
'use strict';

const fs = require('fs');
const path = require('path');
const { FinderError } = require('./errors.js');

const SITE_RE = /^[a-z][a-z0-9]{1,15}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function kebab(text, max) {
  let s = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) s = 'model';
  if (max && s.length > max) s = s.slice(0, max).replace(/-+$/, '') || 'model';
  return s;
}

/**
 * A single file name: no directories, no control characters, no characters
 * Windows refuses, no reserved device names, at most `max` characters with the
 * extension kept.
 */
function safeFileName(name, { max = 120, fallback = 'file' } = {}) {
  let n = String(name == null ? '' : name).normalize('NFC');
  n = n.split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').replace(/^\.+/, '').trim();
  if (!n) n = fallback;
  if (RESERVED.test(n)) n = '_' + n;
  if (n.length > max) {
    const ext = path.extname(n);
    const keep = ext && ext.length <= 12 ? ext : '';
    n = n.slice(0, max - keep.length) + keep;
  }
  return n;
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** realpath of the nearest ancestor that exists, re-joined with the missing tail. */
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True only if `target` is inside `root` on the real file system, symlinks resolved. */
function isReallyInside(root, target) {
  return isInside(realish(root), realish(target));
}

function modelsRoot(workspaceDir) {
  return path.join(path.resolve(workspaceDir), 'models');
}

/** <workspace>/models/<site>-<id> for a validated site and id. */
function modelDir(workspaceDir, site, id) {
  if (!SITE_RE.test(String(site))) throw new FinderError('bad-request', 'Unknown site.');
  if (!ID_RE.test(String(id))) throw new FinderError('bad-request', 'That model number is not valid.');
  const dir = path.join(modelsRoot(workspaceDir), `${site}-${id}`);
  if (!isReallyInside(modelsRoot(workspaceDir), dir)) throw new FinderError('path', 'That folder is outside the workspace.');
  return dir;
}

/**
 * Turn a workspace-relative path from the renderer into an absolute path, but
 * only if it names an existing regular file inside `allowedDir`.
 * @returns {string} absolute path
 */
function resolveFileWithin(workspaceDir, relPath, allowedDir) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0') || path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new FinderError('path', 'That file path is not allowed.');
  }
  const abs = path.resolve(workspaceDir, relPath);
  if (!isInside(allowedDir, abs) || !isReallyInside(allowedDir, abs)) {
    throw new FinderError('path', 'That file is outside the folder this model was saved to.');
  }
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw new FinderError('not-found', 'That file has not been downloaded yet.');
  }
  if (!st.isFile() || st.isSymbolicLink()) throw new FinderError('path', 'That path is not a plain file.');
  return abs;
}

const toRel = (workspaceDir, abs) => path.relative(path.resolve(workspaceDir), abs).split(path.sep).join('/');

module.exports = { kebab, safeFileName, isInside, isReallyInside, modelsRoot, modelDir, resolveFileWithin, toRel, SITE_RE, ID_RE };
