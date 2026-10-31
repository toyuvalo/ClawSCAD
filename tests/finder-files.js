#!/usr/bin/env node
/**
 * Standalone harness for Find & Print file handling:
 * zip.js, mesh.js, paths.js, download.js, checkpoint.js.
 *
 * Runs offline with fixtures only. No test framework required.
 *
 * Run: node tests/finder-files.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { crc32, listZip, readZipEntry, readByName, isCompleteZip, createZip } = require('../main/finder/zip.js');
const { parseStl, parse3mf, writeBinaryStl, bounds, centredOn, compose, loadMesh, isBinaryStl } = require('../main/finder/mesh.js');
const { safeFileName, kebab, modelDir, isInside, isReallyInside, resolveFileWithin } = require('../main/finder/paths.js');
const { downloadModelFile } = require('../main/finder/download.js');
const { openInClawscad, buildScad, uniqueScadName, oneLine } = require('../main/finder/checkpoint.js');
const { createFinder } = require('../main/finder/index.js');
const { createFixtureFetch, makeCubeStl, makeTinyThreeMf } = require('../main/finder/fixture-fetch.js');
const { createHttp } = require('../main/finder/http.js');
const { createRateLimiter } = require('../main/finder/rate-limiter.js');
const { FinderError } = require('../main/finder/errors.js');

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'finder');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL — ${name}`);
    console.log(`  ${err.stack || err.message}`);
  }
}

function signedVolume(mesh) {
  let v = 0;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    // a . (b x c)
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6.0;
}

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // zip.js
  // ───────────────────────────────────────────────────────────────────────────

  await check('zip: crc32 matches known value for "123456789"', async () => {
    const res = crc32(Buffer.from('123456789', 'utf-8'));
    assert.strictEqual(res, 0xcbf43926);
  });

  await check('zip: createZip -> listZip/readZipEntry roundtrip (deflate and stored)', async () => {
    const deflatedData = Buffer.from('Deflated repetitive content '.repeat(40), 'utf-8');
    const storedData = Buffer.from('Plain uncompressed stored bytes', 'utf-8');

    // Deflate
    const zipDeflate = createZip([{ name: 'deflate.txt', data: deflatedData }], { deflate: true });
    const entriesDeflate = listZip(zipDeflate);
    assert.strictEqual(entriesDeflate.length, 1);
    assert.strictEqual(entriesDeflate[0].name, 'deflate.txt');
    assert.strictEqual(entriesDeflate[0].method, 8);
    const readDeflated = readZipEntry(zipDeflate, entriesDeflate[0]);
    assert.ok(readDeflated.equals(deflatedData));

    // Stored
    const zipStored = createZip([{ name: 'stored.txt', data: storedData }], { deflate: false });
    const entriesStored = listZip(zipStored);
    assert.strictEqual(entriesStored.length, 1);
    assert.strictEqual(entriesStored[0].name, 'stored.txt');
    assert.strictEqual(entriesStored[0].method, 0);
    const readStored = readZipEntry(zipStored, entriesStored[0]);
    assert.ok(readStored.equals(storedData));
  });

  await check('zip: isCompleteZip is true for good archive, false for damaged/truncated/empty/random', async () => {
    const goodZip = createZip([
      { name: 'file1.txt', data: 'hello world' },
      { name: 'file2.txt', data: 'another file' },
    ]);
    assert.strictEqual(isCompleteZip(goodZip), true);

    // Truncated buffer
    const truncated = goodZip.subarray(0, goodZip.length - 20);
    assert.strictEqual(isCompleteZip(truncated), false);

    // One flipped byte inside an entry's data
    const entries = listZip(goodZip);
    const flipped = Buffer.from(goodZip);
    const nameLen = flipped.readUInt16LE(entries[0].localOffset + 26);
    const extraLen = flipped.readUInt16LE(entries[0].localOffset + 28);
    const dataOffset = entries[0].localOffset + 30 + nameLen + extraLen;
    flipped[dataOffset] ^= 0xff;
    assert.strictEqual(isCompleteZip(flipped), false);

    // Empty buffer
    assert.strictEqual(isCompleteZip(Buffer.alloc(0)), false);

    // Random bytes
    assert.strictEqual(isCompleteZip(crypto.randomBytes(120)), false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // mesh.js
  // ───────────────────────────────────────────────────────────────────────────

  await check('mesh: parseStl binary cube', async () => {
    const cube = makeCubeStl(20);
    const mesh = parseStl(cube);
    assert.strictEqual(mesh.triangles, 12);
    assert.strictEqual(mesh.positions.length, 12 * 9);
  });

  await check('mesh: binary STL whose 80-byte header starts with "solid" is read as binary', async () => {
    const buf = Buffer.alloc(84 + 1 * 50);
    buf.write('solid binary STL header test with solid text at start', 0, 'latin1');
    buf.writeUInt32LE(1, 80); // 1 triangle
    // normal
    buf.writeFloatLE(0, 84);
    buf.writeFloatLE(0, 88);
    buf.writeFloatLE(1, 92);
    // vertex 1
    buf.writeFloatLE(1.0, 96);
    buf.writeFloatLE(2.0, 100);
    buf.writeFloatLE(3.0, 104);
    // vertex 2
    buf.writeFloatLE(4.0, 108);
    buf.writeFloatLE(5.0, 112);
    buf.writeFloatLE(6.0, 116);
    // vertex 3
    buf.writeFloatLE(7.0, 120);
    buf.writeFloatLE(8.0, 124);
    buf.writeFloatLE(9.0, 128);

    assert.strictEqual(isBinaryStl(buf), true);
    const mesh = parseStl(buf);
    assert.strictEqual(mesh.triangles, 1);
    assert.strictEqual(mesh.positions[0], 1.0);
    assert.strictEqual(mesh.positions[8], 9.0);
  });

  await check('mesh: ASCII STL parsed correctly', async () => {
    const ascii = Buffer.from(`solid test_ascii
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
endsolid test_ascii`);
    const mesh = parseStl(ascii);
    assert.strictEqual(mesh.triangles, 1);
    assert.deepStrictEqual(Array.from(mesh.positions), [0, 0, 0, 10, 0, 0, 0, 10, 0]);
  });

  await check('mesh: garbage throws FinderError code unsupported', async () => {
    assert.throws(
      () => parseStl(Buffer.from('not an stl file at all')),
      (err) => err instanceof FinderError && err.code === 'unsupported'
    );
  });

  await check('mesh: writeBinaryStl -> parseStl roundtrip keeps triangles', async () => {
    const cube = makeCubeStl(20);
    const m1 = parseStl(cube);
    const out = writeBinaryStl(m1);
    const m2 = parseStl(out);
    assert.strictEqual(m2.triangles, m1.triangles);
    assert.deepStrictEqual(Array.from(m2.positions), Array.from(m1.positions));
  });

  await check('mesh: bounds() returns correct min, max, dims', async () => {
    const cube = makeCubeStl(20);
    const mesh = parseStl(cube);
    const b = bounds(mesh);
    assert.deepStrictEqual(b.min, [0, 0, 0]);
    assert.deepStrictEqual(b.max, [20, 20, 20]);
    assert.deepStrictEqual(b.dims, [20, 20, 20]);
  });

  await check('mesh: centredOn(mesh, 128, 128) centres bbox at (128, 128) and min z at 0', async () => {
    const cube = makeCubeStl(20);
    const mesh = parseStl(cube);
    const centred = centredOn(mesh, 128, 128);
    const b = bounds(centred);
    assert.strictEqual((b.min[0] + b.max[0]) / 2, 128);
    assert.strictEqual((b.min[1] + b.max[1]) / 2, 128);
    assert.strictEqual(b.min[2], 0);
    assert.deepStrictEqual(b.dims, [20, 20, 20]);
  });

  await check('mesh: compose(A, B) applies A then B in row-vector convention', async () => {
    // Translation composition
    const A = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30];
    const B = [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, -5, 2];
    const C = compose(A, B);
    assert.deepStrictEqual(C, [1, 0, 0, 0, 1, 0, 0, 0, 1, 15, 15, 32]);

    // Scale X by 2, then translate X by 10
    const S = [2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    const T = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];
    // p' = (p*S)*T: for p=(1,0,0) -> p*S=(2,0,0) -> +T=(12,0,0)
    const ST = compose(S, T);
    assert.strictEqual(ST[0], 2);
    assert.strictEqual(ST[9], 10);
    // p' = (p*T)*S: for p=(1,0,0) -> p*T=(11,0,0) -> *S=(22,0,0)
    const TS = compose(T, S);
    assert.strictEqual(TS[0], 2);
    assert.strictEqual(TS[9], 20);
  });

  await check('mesh: parse3mf plain model with one object and build item', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="10" y="0" z="0"/>
          <vertex x="0" y="10" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>`;
    const zip = createZip([{ name: '3D/3dmodel.model', data: xml }]);
    const mesh = parse3mf(zip);
    assert.strictEqual(mesh.triangles, 1);
    assert.deepStrictEqual(Array.from(mesh.positions), [0, 0, 0, 10, 0, 0, 0, 10, 0]);
  });

  await check('mesh: parse3mf build item with translate transform moves mesh by (tx, ty, tz)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="10" y="0" z="0"/>
          <vertex x="0" y="10" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 15 25 35"/>
  </build>
</model>`;
    const zip = createZip([{ name: '3D/3dmodel.model', data: xml }]);
    const mesh = parse3mf(zip);
    assert.strictEqual(mesh.triangles, 1);
    assert.strictEqual(mesh.positions[0], 15);
    assert.strictEqual(mesh.positions[1], 25);
    assert.strictEqual(mesh.positions[2], 35);
  });

  await check('mesh: parse3mf component object referencing another object with transform', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="10" y="0" z="0"/>
          <vertex x="0" y="10" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
    <object id="2" type="model">
      <components>
        <component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 6 7"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="2"/>
  </build>
</model>`;
    const zip = createZip([{ name: '3D/3dmodel.model', data: xml }]);
    const mesh = parse3mf(zip);
    assert.strictEqual(mesh.triangles, 1);
    assert.strictEqual(mesh.positions[0], 5);
    assert.strictEqual(mesh.positions[1], 6);
    assert.strictEqual(mesh.positions[2], 7);
  });

  await check('mesh: parse3mf unit "inch" scales by 25.4', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="1" y="2" z="3"/>
          <vertex x="2" y="2" z="3"/>
          <vertex x="1" y="3" z="3"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>`;
    const zip = createZip([{ name: '3D/3dmodel.model', data: xml }]);
    const mesh = parse3mf(zip);
    assert.strictEqual(mesh.triangles, 1);
    assert.strictEqual(Math.round(mesh.positions[0] * 10) / 10, 25.4);
    assert.strictEqual(Math.round(mesh.positions[1] * 10) / 10, 50.8);
    assert.strictEqual(Math.round(mesh.positions[2] * 10) / 10, 76.2);
  });

  await check('mesh: parse3mf Bambu-style production 3MF with component p:path', async () => {
    const rootXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources>
    <object id="10" type="model">
      <components>
        <component p:path="/3D/Objects/o1.model" objectid="1"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="10"/>
  </build>
</model>`;
    const subXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="10" y="0" z="0"/>
          <vertex x="0" y="10" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
  </resources>
</model>`;
    const zip = createZip([
      { name: '3D/3dmodel.model', data: rootXml },
      { name: '3D/Objects/o1.model', data: subXml },
    ]);
    const mesh = parse3mf(zip);
    assert.strictEqual(mesh.triangles, 1);
  });

  await check('mesh: parse3mf mirrored transform (negative determinant) keeps outward winding', async () => {
    // A 4-triangle tetrahedron with outward-pointing normals
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="10" y="0" z="0"/>
          <vertex x="0" y="10" z="0"/>
          <vertex x="0" y="0" z="10"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="2" v3="1"/>
          <triangle v1="0" v2="1" v3="3"/>
          <triangle v1="0" v2="3" v3="2"/>
          <triangle v1="1" v2="2" v3="3"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/>
  </build>
</model>`;
    const zip = createZip([{ name: '3D/3dmodel.model', data: xml }]);
    const mesh = parse3mf(zip);
    assert.strictEqual(mesh.triangles, 4);
    const vol = signedVolume(mesh);
    assert.ok(vol > 0, `signed volume must stay positive under reflection, got ${vol}`);
  });

  await check('mesh: parse3mf item with printable="0" is skipped', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
    <object id="2" type="model">
      <mesh>
        <vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" printable="0"/>
    <item objectid="2"/>
  </build>
</model>`;
    const zip = createZip([{ name: '3D/3dmodel.model', data: xml }]);
    const mesh = parse3mf(zip);
    assert.strictEqual(mesh.triangles, 1);
    assert.strictEqual(mesh.positions[3], 20); // only object 2 was emitted
  });

  await check('mesh: parse3mf with no mesh throws FinderError code unsupported', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model"/>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>`;
    const zip = createZip([{ name: '3D/3dmodel.model', data: xml }]);
    assert.throws(
      () => parse3mf(zip),
      (err) => err instanceof FinderError && err.code === 'unsupported'
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // paths.js
  // ───────────────────────────────────────────────────────────────────────────

  await check('paths: safeFileName table test cases', async () => {
    assert.strictEqual(safeFileName('../../evil.stl'), 'evil.stl');
    assert.strictEqual(safeFileName('a\\b\\c.stl'), 'c.stl');
    assert.strictEqual(safeFileName('CON.stl'), '_CON.stl');
    assert.strictEqual(safeFileName('name...   '), 'name');
    assert.strictEqual(safeFileName('ctrl\x00\x1f\x7fname.stl'), 'ctrl___name.stl');
    assert.strictEqual(safeFileName('a<b:c"d/e|f?g*h.stl'), 'e_f_g_h.stl');
    const longName = 'a'.repeat(300) + '.stl';
    const safeLong = safeFileName(longName);
    assert.ok(safeLong.length <= 120);
    assert.ok(safeLong.endsWith('.stl'));
    assert.strictEqual(safeFileName(''), 'file');
    assert.strictEqual(safeFileName(null, { fallback: 'fallback' }), 'fallback');
  });

  await check('paths: kebab converts strings to kebab-case', async () => {
    assert.strictEqual(kebab('Gridfinity Box Pred'), 'gridfinity-box-pred');
    assert.strictEqual(kebab(''), 'model');
    assert.strictEqual(kebab('A Very Long Name Exceeding Limit', 6), 'a-very');
  });

  await check('paths: modelDir validation rules', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-test-'));
    try {
      const ok = modelDir(ws, 'printables', '543553');
      assert.strictEqual(ok, path.join(path.resolve(ws), 'models', 'printables-543553'));

      for (const badSite of ['..', 'site/slash', 'site\\bs', 'with space', '', 'a'.repeat(45)]) {
        assert.throws(
          () => modelDir(ws, badSite, '543553'),
          (err) => err instanceof FinderError && (err.code === 'bad-request' || err.code === 'path')
        );
      }
      for (const badId of ['..', 'id/slash', 'id\\bs', 'with space', '', 'a'.repeat(45)]) {
        assert.throws(
          () => modelDir(ws, 'printables', badId),
          (err) => err instanceof FinderError && (err.code === 'bad-request' || err.code === 'path')
        );
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('paths: isInside / isReallyInside and directory junction containment', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-inside-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-outside-'));
    try {
      const insideFile = path.join(ws, 'sub', 'file.txt');
      assert.strictEqual(isInside(ws, insideFile), true);
      assert.strictEqual(isReallyInside(ws, insideFile), true);

      const outsideFile = path.join(outside, 'file.txt');
      assert.strictEqual(isInside(ws, outsideFile), false);
      assert.strictEqual(isReallyInside(ws, outsideFile), false);

      const link = path.join(ws, 'junction-link');
      let created = false;
      try {
        fs.symlinkSync(outside, link, 'junction');
        created = true;
      } catch {
        console.log('skip — OS refused junction creation');
      }
      if (created) {
        const target = path.join(link, 'file.txt');
        assert.strictEqual(isInside(ws, target), true);
        assert.strictEqual(isReallyInside(ws, target), false);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await check('paths: resolveFileWithin rejects invalid paths, accepts real file', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-res-'));
    try {
      const allowed = path.join(ws, 'models', 'printables-543553');
      fs.mkdirSync(allowed, { recursive: true });
      const realFile = path.join(allowed, 'cube.stl');
      fs.writeFileSync(realFile, 'data');

      // Accepts real file
      const rel = 'models/printables-543553/cube.stl';
      const resolved = resolveFileWithin(ws, rel, allowed);
      assert.strictEqual(resolved, realFile);

      // Rejections
      assert.throws(() => resolveFileWithin(ws, path.resolve(realFile), allowed), (err) => err.code === 'path');
      assert.throws(() => resolveFileWithin(ws, 'C:/evil.stl', allowed), (err) => err.code === 'path');
      assert.throws(() => resolveFileWithin(ws, '../escape.stl', allowed), (err) => err.code === 'path');
      assert.throws(() => resolveFileWithin(ws, 'models/printables-543553/cube\0.stl', allowed), (err) => err.code === 'path');
      const other = path.join(ws, 'other.stl');
      fs.writeFileSync(other, 'other');
      assert.throws(() => resolveFileWithin(ws, 'other.stl', allowed), (err) => err.code === 'path');
      assert.throws(() => resolveFileWithin(ws, 'models/printables-543553', allowed), (err) => err.code === 'path');
      assert.throws(() => resolveFileWithin(ws, 'models/printables-543553/missing.stl', allowed), (err) => err.code === 'not-found');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // download.js
  // ───────────────────────────────────────────────────────────────────────────

  await check('download: cube download writes file and provenance source.json', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-dl-'));
    try {
      const fetchCalls = [];
      const fetchImpl = createFixtureFetch(FIXTURES_DIR, { calls: fetchCalls });
      const finder = createFinder({ cacheDir: path.join(ws, '.cache'), fetchImpl, minIntervalMs: 0 });

      const res = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '9990001' });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.cached, false);
      assert.strictEqual(res.path, 'models/printables-543553/cube-20mm.stl');
      assert.strictEqual(res.size, 684);

      const filePath = path.join(ws, res.path);
      assert.ok(fs.existsSync(filePath));
      const fileBytes = fs.readFileSync(filePath);
      assert.strictEqual(fileBytes.length, 684);
      const hash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      assert.strictEqual(res.sha256, hash);

      const sourceJsonPath = path.join(ws, 'models', 'printables-543553', 'source.json');
      assert.ok(fs.existsSync(sourceJsonPath));
      const src = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf-8'));
      assert.strictEqual(src.site, 'printables');
      assert.strictEqual(src.id, '543553');
      assert.strictEqual(src.author, 'Pred');
      assert.ok(src.licence);
      assert.ok(src.fetched);
      assert.strictEqual(src.files.length, 1);
      assert.strictEqual(src.files[0].id, '9990001');
      assert.strictEqual(src.files[0].name, 'cube-20mm.stl');
      assert.strictEqual(src.files[0].sha256, hash);

      // Calling again returns cached: true and does not hit the file URL again
      const fileCallsBefore = fetchCalls.filter((c) => c.url.includes('9990001')).length;
      const res2 = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '9990001' });
      assert.strictEqual(res2.ok, true);
      assert.strictEqual(res2.cached, true);
      const fileCallsAfter = fetchCalls.filter((c) => c.url.includes('9990001')).length;
      assert.strictEqual(fileCallsAfter, fileCallsBefore);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('download: declared size mismatch discards file and leaves no .part', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-dl-'));
    try {
      const finder = createFinder({ cacheDir: path.join(ws, '.cache'), fetchImpl: createFixtureFetch(FIXTURES_DIR), minIntervalMs: 0 });
      // File 2496570 has size 240923 in printables-detail.json, but fixture-fetch serves makeTinyThreeMf()
      const res = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '2496570' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error.code, 'incomplete');

      const modelDir = path.join(ws, 'models', 'printables-543553');
      if (fs.existsSync(modelDir)) {
        const files = fs.readdirSync(modelDir);
        assert.ok(!files.some((f) => f.includes('2496570') || f.endsWith('.part')));
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('download: bytes not looking like STL are discarded with code unsupported', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-dl-'));
    try {
      const adapter = {
        downloadLink: async () => 'https://files.printables.com/fixture/stl-garbage',
      };
      const garbage = Buffer.from('not an stl file at all, just plain invalid text bytes!');
      const http = createHttp({
        fetchImpl: async () => new Response(garbage, { status: 200, headers: { 'content-length': String(garbage.length) } }),
        limiter: createRateLimiter({ minIntervalMs: 0 }),
      });
      const detail = {
        site: 'printables',
        siteId: '543553',
        files: [{ id: '123', name: 'corrupt.stl', kind: 'stl', downloadable: true, size: garbage.length }],
      };
      await assert.rejects(
        () => downloadModelFile({ adapter, http, workspaceDir: ws, detail, fileId: '123' }),
        (err) => err instanceof FinderError && err.code === 'unsupported'
      );
      const modelDir = path.join(ws, 'models', 'printables-543553');
      if (fs.existsSync(modelDir)) {
        assert.ok(!fs.readdirSync(modelDir).some((f) => f.endsWith('.part')));
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('download: invalid file ids and formats are refused', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-dl-'));
    try {
      const finder = createFinder({ cacheDir: path.join(ws, '.cache'), fetchImpl: createFixtureFetch(FIXTURES_DIR), minIntervalMs: 0 });

      // File not in model list
      const r1 = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '9999999' });
      assert.strictEqual(r1.ok, false);
      assert.strictEqual(r1.error.code, 'not-found');

      // .f3d unsupported
      const r2 = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '2705077' });
      assert.strictEqual(r2.ok, false);
      assert.strictEqual(r2.error.code, 'unsupported');

      // .step unsupported
      const r3 = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '2498547' });
      assert.strictEqual(r3.ok, false);
      assert.strictEqual(r3.error.code, 'unsupported');

      // .gcode unsupported
      const r4 = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '176053' });
      assert.strictEqual(r4.ok, false);
      assert.strictEqual(r4.error.code, 'unsupported');

      // fileId passed as array -> bad-request
      const r5 = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: ['9990001'] });
      assert.strictEqual(r5.ok, false);
      assert.strictEqual(r5.error.code, 'bad-request');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('download: declared size above maxBytes throws too-large before request', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-dl-'));
    try {
      let requested = false;
      const adapter = {
        downloadLink: async () => {
          requested = true;
          return 'https://files.printables.com/fixture/cube';
        },
      };
      const detail = {
        site: 'printables',
        siteId: '543553',
        files: [{ id: '9990001', name: 'cube.stl', kind: 'stl', downloadable: true, size: 684 }],
      };
      await assert.rejects(
        () => downloadModelFile({ adapter, http: {}, workspaceDir: ws, detail, fileId: '9990001', maxBytes: 100 }),
        (err) => err instanceof FinderError && err.code === 'too-large'
      );
      assert.strictEqual(requested, false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('download: second download into same folder appends to source.json and keeps fetched', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-dl-'));
    try {
      const cube1 = makeCubeStl(10);
      const cube2 = makeCubeStl(20);
      const adapter = {
        downloadLink: async (_id, fileId) => `https://files.printables.com/fixture/${fileId}`,
      };
      const http = createHttp({
        fetchImpl: async (url) => {
          const buf = url.includes('1') ? cube1 : cube2;
          return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
        },
        limiter: createRateLimiter({ minIntervalMs: 0 }),
      });
      const detail = {
        site: 'printables',
        siteId: '543553',
        files: [
          { id: '1', name: 'cube1.stl', kind: 'stl', downloadable: true, size: cube1.length },
          { id: '2', name: 'cube2.stl', kind: 'stl', downloadable: true, size: cube2.length },
        ],
      };

      await downloadModelFile({ adapter, http, workspaceDir: ws, detail, fileId: '1', nowIso: () => '2026-01-01T00:00:00.000Z' });
      await downloadModelFile({ adapter, http, workspaceDir: ws, detail, fileId: '2', nowIso: () => '2026-01-02T00:00:00.000Z' });

      const src = JSON.parse(fs.readFileSync(path.join(ws, 'models', 'printables-543553', 'source.json'), 'utf-8'));
      assert.strictEqual(src.fetched, '2026-01-01T00:00:00.000Z');
      assert.strictEqual(src.updated, '2026-01-02T00:00:00.000Z');
      assert.strictEqual(src.files.length, 2);
      assert.strictEqual(src.files[0].name, 'cube1.stl');
      assert.strictEqual(src.files[1].name, 'cube2.stl');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('download: name collision with different bytes keeps both files', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-dl-'));
    try {
      const cube1 = makeCubeStl(10);
      const cube2 = Buffer.alloc(84 + 1 * 50);
      cube2.write('cube2', 0, 'latin1');
      cube2.writeUInt32LE(1, 80);
      const adapter = {
        downloadLink: async () => 'https://files.printables.com/fixture/cube',
      };
      let callCount = 0;
      const http = createHttp({
        fetchImpl: async () => {
          callCount++;
          const buf = callCount === 1 ? cube1 : cube2;
          return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
        },
        limiter: createRateLimiter({ minIntervalMs: 0 }),
      });
      const detail1 = { site: 'printables', siteId: '543553', files: [{ id: '1', name: 'cube.stl', kind: 'stl', downloadable: true, size: cube1.length }] };
      const detail2 = { site: 'printables', siteId: '543553', files: [{ id: '2', name: 'cube.stl', kind: 'stl', downloadable: true, size: cube2.length }] };

      const r1 = await downloadModelFile({ adapter, http, workspaceDir: ws, detail: detail1, fileId: '1' });
      const r2 = await downloadModelFile({ adapter, http, workspaceDir: ws, detail: detail2, fileId: '2' });

      assert.strictEqual(r1.name, 'cube.stl');
      assert.notStrictEqual(r2.name, 'cube.stl');
      assert.ok(r2.name.startsWith('cube-'));
      assert.ok(fs.existsSync(path.join(ws, 'models', 'printables-543553', r1.name)));
      assert.ok(fs.existsSync(path.join(ws, 'models', 'printables-543553', r2.name)));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // checkpoint.js
  // ───────────────────────────────────────────────────────────────────────────

  await check('checkpoint: openInClawscad creates mesh copy and valid .scad checkpoint', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-cp-'));
    try {
      const finder = createFinder({ cacheDir: path.join(ws, '.cache'), fetchImpl: createFixtureFetch(FIXTURES_DIR), minIntervalMs: 0 });
      const dl = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '9990001' });

      let hookScad = null;
      const res = await finder.open({
        workspaceDir: ws,
        site: 'printables',
        id: '543553',
        path: dl.path,
        addCheckpoint: (scadPath) => {
          hookScad = scadPath;
          return 'cp-1001';
        },
      });

      assert.strictEqual(res.ok, true);
      assert.ok(res.scad.length <= 30);
      assert.ok(res.scad.endsWith('.scad'));
      assert.strictEqual(res.checkpointId, 'cp-1001');
      assert.strictEqual(hookScad, path.join(ws, res.scad));

      const scadPath = path.join(ws, res.scad);
      assert.ok(fs.existsSync(scadPath));
      const content = fs.readFileSync(scadPath, 'utf-8');
      const lines = content.split('\n');

      // First line comment format
      assert.ok(lines[0].startsWith('// Imported from Printables #543553'));
      assert.ok(lines[0].includes('Pred'));
      assert.ok(lines[0].includes('CC'));
      assert.ok(lines[0].includes('file cube-20mm.stl'));
      assert.ok(lines[0].includes('20 x 20 x 20 mm'));
      assert.ok(lines[0].includes('centred on X/Y, base at Z=0'));

      // Forward slash relative import
      assert.ok(res.mesh.startsWith('meshes/'));
      assert.ok(!res.mesh.includes('\\'));
      assert.ok(fs.existsSync(path.join(ws, res.mesh)));

      // translate([-10, -10, 0]) and color
      assert.ok(content.includes('translate([-10, -10, 0])'));
      assert.ok(content.includes('color('));

      // Opening a second time does not overwrite .scad, uses hex token, dedupes mesh
      const res2 = await finder.open({
        workspaceDir: ws,
        site: 'printables',
        id: '543553',
        path: dl.path,
      });
      assert.strictEqual(res2.ok, true);
      assert.notStrictEqual(res2.scad, res.scad);
      assert.ok(res2.scad.length <= 30);
      assert.ok(!res2.scad.endsWith('-2.scad'));
      assert.strictEqual(res2.mesh, res.mesh); // Deduped!

      const meshes = fs.readdirSync(path.join(ws, 'meshes'));
      assert.strictEqual(meshes.length, 1);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('checkpoint: openInClawscad refuses path outside allowed model directory', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-cp-'));
    try {
      const finder = createFinder({ cacheDir: path.join(ws, '.cache'), fetchImpl: createFixtureFetch(FIXTURES_DIR), minIntervalMs: 0 });
      await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '9990001' });

      // Create an outside file in workspace root
      fs.writeFileSync(path.join(ws, 'outside.stl'), makeCubeStl(20));

      const res = await finder.open({
        workspaceDir: ws,
        site: 'printables',
        id: '543553',
        path: 'outside.stl',
      });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error.code, 'path');
      assert.ok(!fs.existsSync(path.join(ws, 'meshes')));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await check('checkpoint: title with quotes, newlines and */ does not break first line', async () => {
    const detail = {
      site: 'printables',
      siteId: '543553',
      title: 'A "Quoted" Model\nwith newline and */ comment terminator',
      author: 'Test "Author"\n',
      licence: 'MIT\n',
      url: 'https://example.com',
    };
    const scad = buildScad({
      detail,
      fileName: 'cube.stl',
      relMesh: 'meshes/cube.stl',
      bbox: { dims: [10, 10, 10], min: [0, 0, 0], max: [10, 10, 10] },
    });
    const firstLine = scad.split('\n')[0];
    assert.ok(firstLine.startsWith('//'));
    assert.ok(!firstLine.includes('\n'));
    assert.ok(!firstLine.includes('\r'));
    assert.ok(!firstLine.includes('*/'));
    assert.ok(firstLine.includes("'Quoted'"));
  });

  await check('checkpoint: 3MF source is converted to binary STL copy', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-cp-'));
    try {
      const modelDir = path.join(ws, 'models', 'printables-543553');
      fs.mkdirSync(modelDir, { recursive: true });

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="10" y="0" z="0"/>
          <vertex x="0" y="10" z="0"/>
          <vertex x="0" y="0" z="10"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="2" v3="1"/>
          <triangle v1="0" v2="1" v3="3"/>
          <triangle v1="0" v2="3" v3="2"/>
          <triangle v1="1" v2="2" v3="3"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>`;
      const zip = createZip([{ name: '3D/3dmodel.model', data: xml }]);
      fs.writeFileSync(path.join(modelDir, 'sample.3mf'), zip);

      const detail = {
        site: 'printables',
        siteId: '543553',
        title: 'Tetra 3MF',
        author: 'Pred',
        licence: 'CC0',
        url: 'https://example.com',
      };

      const res = openInClawscad({
        workspaceDir: ws,
        detail,
        relPath: 'models/printables-543553/sample.3mf',
      });

      assert.strictEqual(res.ok, true);
      assert.ok(res.mesh.endsWith('.stl'));
      const stlPath = path.join(ws, res.mesh);
      assert.ok(fs.existsSync(stlPath));
      assert.strictEqual(isBinaryStl(fs.readFileSync(stlPath)), true);
      assert.strictEqual(res.triangles, 4);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  console.log(`\nfinder-files: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
