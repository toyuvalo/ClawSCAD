// main/finder/checkpoint.js — "Open in ClawSCAD".
//
// Takes a model file already downloaded under models/<site>-<id>/, puts a copy
// of the mesh at meshes/<slug>.stl, and writes a NEW mesh-derived checkpoint .scad
// at the workspace root, following the workspace CLAUDE.md:
//   - never touches an existing .scad (a name clash gets a short random token,
//     never a sequential number)
//   - kebab-case name, at most 30 characters
//   - the first line is a // comment: source site, model id, author, licence
//   - the mesh is named by a forward-slash relative path
//   - centred on X/Y with its base on Z=0, from the mesh's own measured bounds
//   - wrapped in color(), because every part gets a colour
// The copy of the mesh is an STL even when the download was a 3MF, so OpenSCAD
// reads it the same way every time.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FinderError } = require('./errors.js');
const { kebab, modelDir, resolveFileWithin, toRel } = require('./paths.js');
const { loadMesh, writeBinaryStl, bounds } = require('./mesh.js');
const { _internal: uploadInternals } = require('../uploads.js');

const SCAD_NAME_MAX = 30;
const BIG_MESH_TRIANGLES = 1_500_000;

/** One line, no comment terminators, no quotes that could break the file. */
function oneLine(text, max) {
  const t = String(text == null ? '' : text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\*\//g, '* /')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 3).trimEnd() + '...' : t;
}

function uniqueScadName(workspaceDir, base) {
  const first = kebab(base, SCAD_NAME_MAX - '.scad'.length) + '.scad';
  if (!fs.existsSync(path.join(workspaceDir, first))) return first;
  const token = crypto.randomBytes(3).toString('hex');
  return kebab(base, SCAD_NAME_MAX - '.scad'.length - 7) + '-' + token + '.scad';
}

const num = (n) => String(Math.round(n * 1000) / 1000);

function buildScad({ detail, fileName, relMesh, bbox }) {
  const [dx, dy, dz] = bbox.dims;
  const cx = (bbox.min[0] + bbox.max[0]) / 2;
  const cy = (bbox.min[1] + bbox.max[1]) / 2;
  const licence = detail.licence || detail.licenceName || 'licence not stated';
  const first =
    `// Imported from ${detail.site === 'printables' ? 'Printables' : detail.site} #${detail.siteId} "${oneLine(detail.title, 60)}"` +
    `${detail.author ? ' by ' + oneLine(detail.author, 40) : ''} (${oneLine(licence, 40)}), file ${oneLine(fileName, 50)}, ` +
    `${num(dx)} x ${num(dy)} x ${num(dz)} mm, centred on X/Y, base at Z=0`;
  return (
    first + '\n' +
    `// Source: ${oneLine(detail.url, 200)}\n` +
    `// Personal use. Credit the author and keep the licence; do not re-host this model.\n` +
    `// Mesh import, not parametric geometry: branch this checkpoint and difference()/union()\n` +
    `// against the import() below to add features. Never edit this file in place.\n` +
    `color("SteelBlue")\n` +
    `  translate([${num(-cx)}, ${num(-cy)}, ${num(-bbox.min[2])}])\n` +
    `    import("${relMesh}", convexity = 10);\n`
  );
}

/**
 * @param {object} p
 * @param {string} p.workspaceDir
 * @param {object} p.detail       normalized detail (site, siteId, title, author, licence, url)
 * @param {string} p.relPath      workspace-relative path of the downloaded file
 * @param {(scadPath:string)=>any} [p.addCheckpoint]  desktop registry hook
 */
function openInClawscad({ workspaceDir, detail, relPath, addCheckpoint }) {
  const dir = modelDir(workspaceDir, detail.site, detail.siteId);
  const abs = resolveFileWithin(workspaceDir, relPath, dir);
  const ext = path.extname(abs).toLowerCase().slice(1);
  if (ext !== 'stl' && ext !== '3mf') throw new FinderError('unsupported', 'Only STL and 3MF files can be opened in ClawSCAD.');

  const source = fs.readFileSync(abs);
  let stlBytes;
  let triangles;
  if (ext === 'stl') {
    // Validate by parsing; the original bytes are kept (no lossy round trip).
    const mesh = loadMesh(source, 'stl');
    stlBytes = source;
    triangles = mesh.triangles;
  } else {
    const mesh = loadMesh(source, '3mf');
    stlBytes = writeBinaryStl(mesh);
    triangles = mesh.triangles;
  }

  const meshesDir = path.join(workspaceDir, 'meshes');
  const baseName = `${kebab(detail.title, 28)}-${kebab(path.basename(abs, path.extname(abs)), 24)}`;
  const stored = uploadInternals.storeUnique(meshesDir, baseName, '.stl', stlBytes);
  const relMesh = 'meshes/' + stored.name;

  const bbox = uploadInternals.meshBBox(stored.path, '.stl');
  if (!bbox) throw new FinderError('unsupported', 'Could not measure this mesh, so no checkpoint was written.');
  const check = bounds(loadMesh(fs.readFileSync(stored.path), 'stl'));
  if (!check || JSON.stringify(check.dims) !== JSON.stringify(bbox.dims)) {
    throw new FinderError('unsupported', 'The copied mesh does not match its measured size, so no checkpoint was written.');
  }

  const scadName = uniqueScadName(workspaceDir, detail.title);
  const scadPath = path.join(workspaceDir, scadName);
  fs.writeFileSync(scadPath, buildScad({ detail, fileName: path.basename(abs), relMesh, bbox }), { flag: 'wx' });

  let checkpointId = null;
  if (typeof addCheckpoint === 'function') {
    try {
      checkpointId = addCheckpoint(scadPath) || null;
    } catch {
      /* the file watcher registers it anyway */
    }
  }
  return {
    ok: true,
    scad: scadName,
    mesh: relMesh,
    meshPath: toRel(workspaceDir, stored.path),
    bbox,
    triangles,
    checkpointId,
    warning: triangles > BIG_MESH_TRIANGLES ? 'This mesh is large. OpenSCAD may take several minutes to render it.' : null,
  };
}

module.exports = { openInClawscad, buildScad, uniqueScadName, oneLine, SCAD_NAME_MAX };
