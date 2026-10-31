// main/finder/mesh.js — read an STL or a 3MF into plain triangles, move them,
// and write a binary STL back out.
//
// Why this exists: "Open in ClawSCAD" and "Print" must both start from the same
// thing — one mesh, in millimetres, as a list of triangles — whatever the site
// handed us. A Printables 3MF can be a plain model, a PrusaSlicer project or a
// Bambu project with components and build transforms; flattening all of those to
// triangles here means the rest of the pipeline only ever sees an STL.
//
// A mesh is { positions: Float32Array (9 numbers per triangle), triangles: n }.
'use strict';

const { listZip, readZipEntry, readByName } = require('./zip.js');
const { FinderError } = require('./errors.js');

const MAX_TRIANGLES = 8_000_000;

// ── STL ──────────────────────────────────────────────────────────────────

function isBinaryStl(buf) {
  if (buf.length < 84) return false;
  return 84 + buf.readUInt32LE(80) * 50 === buf.length;
}

/** The size formula is the only reliable test: binary STLs may start with "solid". */
function parseStl(buf) {
  if (isBinaryStl(buf)) {
    const n = buf.readUInt32LE(80);
    const positions = new Float32Array(n * 9);
    let off = 84;
    for (let i = 0; i < n; i++) {
      off += 12; // the stored normal is ignored; slicers recompute it
      for (let k = 0; k < 9; k++, off += 4) positions[i * 9 + k] = buf.readFloatLE(off);
      off += 2;
    }
    return { positions, triangles: n };
  }
  const text = buf.toString('utf-8');
  if (!/^\s*solid/i.test(text)) throw new FinderError('unsupported', 'This file is not a valid STL.');
  const nums = [];
  const re = /vertex\s+(-?[\d.]+(?:[eE][+-]?\d+)?)\s+(-?[\d.]+(?:[eE][+-]?\d+)?)\s+(-?[\d.]+(?:[eE][+-]?\d+)?)/g;
  let m;
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
  if (!nums.length || nums.length % 9 !== 0) throw new FinderError('unsupported', 'This STL has no readable triangles.');
  return { positions: Float32Array.from(nums), triangles: nums.length / 9 };
}

function writeBinaryStl(mesh) {
  const n = mesh.triangles;
  const out = Buffer.alloc(84 + n * 50);
  out.write('ClawSCAD Find & Print', 0, 'latin1');
  out.writeUInt32LE(n, 80);
  const p = mesh.positions;
  let off = 84;
  for (let i = 0; i < n; i++) {
    const b = i * 9;
    const ux = p[b + 3] - p[b], uy = p[b + 4] - p[b + 1], uz = p[b + 5] - p[b + 2];
    const vx = p[b + 6] - p[b], vy = p[b + 7] - p[b + 1], vz = p[b + 8] - p[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    out.writeFloatLE(nx, off); out.writeFloatLE(ny, off + 4); out.writeFloatLE(nz, off + 8);
    off += 12;
    for (let k = 0; k < 9; k++, off += 4) out.writeFloatLE(p[b + k], off);
    out.writeUInt16LE(0, off);
    off += 2;
  }
  return out;
}

// ── 3MF ──────────────────────────────────────────────────────────────────

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 };

const attr = (s, name) => {
  const m = new RegExp(`(?:^|[\\s:])${name}="([^"]*)"`).exec(s);
  return m ? m[1] : null;
};

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(s) {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
}

/** Row-vector convention: apply `a` first, then `b`. */
function compose(a, b) {
  // p' = (p·A + tA)·B + tB = p·(A·B) + (tA·B + tB)
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

function det3(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

function parseModelXml(xml) {
  const modelTag = /<model\b[^>]*>/.exec(xml);
  const unit = ((modelTag && attr(modelTag[0], 'unit')) || 'millimeter').toLowerCase();
  const scale = UNIT_MM[unit] || 1;
  const objects = new Map();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let om;
  while ((om = objRe.exec(xml))) {
    const id = attr(om[1], 'id');
    if (id == null) continue;
    const type = (attr(om[1], 'type') || 'model').toLowerCase();
    const body = om[2];
    const obj = { id, type, verts: null, tris: null, components: [] };
    if (/<mesh\b/.test(body)) {
      const verts = [];
      const vre = /<vertex\b([^>]*?)\/?>/g;
      let vm;
      while ((vm = vre.exec(body))) verts.push(+attr(vm[1], 'x'), +attr(vm[1], 'y'), +attr(vm[1], 'z'));
      const tris = [];
      const tre = /<triangle\b([^>]*?)\/?>/g;
      let tm;
      while ((tm = tre.exec(body))) tris.push(+attr(tm[1], 'v1'), +attr(tm[1], 'v2'), +attr(tm[1], 'v3'));
      obj.verts = verts;
      obj.tris = tris;
    }
    const cre = /<component\b([^>]*?)\/?>/g;
    let cm;
    while ((cm = cre.exec(body))) {
      obj.components.push({
        objectid: attr(cm[1], 'objectid'),
        path: attr(cm[1], 'path'),
        transform: parseTransform(attr(cm[1], 'transform')),
      });
    }
    objects.set(id, obj);
  }
  const items = [];
  const buildMatch = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
  if (buildMatch) {
    const ire = /<item\b([^>]*?)\/?>/g;
    let im;
    while ((im = ire.exec(buildMatch[1]))) {
      if (attr(im[1], 'printable') === '0') continue;
      items.push({ objectid: attr(im[1], 'objectid'), transform: parseTransform(attr(im[1], 'transform')) });
    }
  }
  return { scale, objects, items };
}

function parse3mf(buf) {
  let entries;
  try {
    entries = listZip(buf);
  } catch (err) {
    throw new FinderError('unsupported', `This 3MF cannot be opened (${err.message}).`);
  }
  let rootPath = '3D/3dmodel.model';
  const rels = readByName(buf, '_rels/.rels', entries);
  if (rels) {
    const m = /<Relationship\b[^>]*Type="[^"]*\/3dmodel"[^>]*>/i.exec(rels.toString('utf-8'));
    const t = m && /Target="([^"]+)"/i.exec(m[0]);
    if (t) rootPath = t[1].replace(/^\/+/, '');
  }

  const models = new Map();
  const loadModel = (p) => {
    const key = String(p).replace(/^\/+/, '');
    if (models.has(key)) return models.get(key);
    const data = readByName(buf, key, entries);
    if (!data) throw new FinderError('unsupported', `This 3MF points at a part that is missing (${key}).`);
    const parsed = parseModelXml(data.toString('utf-8'));
    models.set(key, parsed);
    return parsed;
  };

  const root = loadModel(rootPath);
  const out = [];
  let triangles = 0;

  const emit = (model, obj, matrix) => {
    const flip = det3(matrix) < 0;
    const v = obj.verts;
    const world = new Float64Array((v.length / 3) * 3);
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i] * model.scale, y = v[i + 1] * model.scale, z = v[i + 2] * model.scale;
      world[i] = x * matrix[0] + y * matrix[3] + z * matrix[6] + matrix[9];
      world[i + 1] = x * matrix[1] + y * matrix[4] + z * matrix[7] + matrix[10];
      world[i + 2] = x * matrix[2] + y * matrix[5] + z * matrix[8] + matrix[11];
    }
    for (let t = 0; t < obj.tris.length; t += 3) {
      const a = obj.tris[t], b = flip ? obj.tris[t + 2] : obj.tris[t + 1], c = flip ? obj.tris[t + 1] : obj.tris[t + 2];
      if (!(a * 3 + 2 < world.length && b * 3 + 2 < world.length && c * 3 + 2 < world.length)) continue;
      for (const idx of [a, b, c]) out.push(world[idx * 3], world[idx * 3 + 1], world[idx * 3 + 2]);
      triangles++;
      if (triangles > MAX_TRIANGLES) throw new FinderError('too-large', 'This 3MF has too many triangles to open here.');
    }
  };

  // Component transforms are in the parent's space; `matrix` is the transform of
  // everything above. The model scale is applied per mesh, so a component's
  // translation (given in the model's own unit) is scaled to millimetres first.
  const walk = (model, obj, matrix, depth) => {
    if (depth > 16) throw new FinderError('unsupported', 'This 3MF nests its parts too deeply.');
    if (obj.type === 'support' || obj.type === 'solidsupport') return;
    if (obj.verts && obj.tris) emit(model, obj, matrix);
    for (const c of obj.components) {
      const childModel = c.path ? loadModel(c.path) : model;
      const child = childModel.objects.get(c.objectid);
      if (!child) continue;
      const t = c.transform.slice();
      t[9] *= model.scale; t[10] *= model.scale; t[11] *= model.scale;
      walk(childModel, child, compose(t, matrix), depth + 1);
    }
  };

  const roots = root.items.length
    ? root.items
    : [...root.objects.values()].filter((o) => o.verts || o.components.length).map((o) => ({ objectid: o.id, transform: IDENTITY }));
  for (const item of roots) {
    const obj = root.objects.get(item.objectid);
    if (!obj) continue;
    const t = item.transform.slice();
    t[9] *= root.scale; t[10] *= root.scale; t[11] *= root.scale;
    walk(root, obj, t, 0);
  }
  if (!triangles) throw new FinderError('unsupported', 'This 3MF holds no mesh this app can read.');
  return { positions: Float32Array.from(out), triangles };
}

function loadMesh(buf, ext) {
  const e = String(ext).toLowerCase().replace(/^\./, '');
  if (e === 'stl') return parseStl(buf);
  if (e === '3mf') return parse3mf(buf);
  throw new FinderError('unsupported', `Cannot read a .${e} file as a mesh.`);
}

// ── geometry ─────────────────────────────────────────────────────────────

function bounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!Number.isFinite(min[0])) return null;
  const r = (n) => Math.round(n * 1000) / 1000;
  return { min: min.map(r), max: max.map(r), dims: [r(max[0] - min[0]), r(max[1] - min[1]), r(max[2] - min[2])] };
}

function translated(mesh, d) {
  const p = new Float32Array(mesh.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    p[i] = mesh.positions[i] + d[0];
    p[i + 1] = mesh.positions[i + 1] + d[1];
    p[i + 2] = mesh.positions[i + 2] + d[2];
  }
  return { positions: p, triangles: mesh.triangles };
}

/** Bounding-box centre on (cx, cy), lowest point on Z=0. */
function centredOn(mesh, cx, cy) {
  const b = bounds(mesh);
  if (!b) throw new FinderError('unsupported', 'This mesh is empty.');
  const dx = cx - (b.min[0] + b.max[0]) / 2;
  const dy = cy - (b.min[1] + b.max[1]) / 2;
  return translated(mesh, [dx, dy, -b.min[2]]);
}

module.exports = {
  MAX_TRIANGLES,
  isBinaryStl,
  parseStl,
  parse3mf,
  loadMesh,
  writeBinaryStl,
  bounds,
  translated,
  centredOn,
  compose,
};
