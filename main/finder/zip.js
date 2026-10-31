// main/finder/zip.js — the little ZIP code Find & Print needs, with no npm
// dependency: list and read entries, check a whole archive the way Python's
// ZipFile.testzip() does (every entry inflates and its CRC-32 matches), and write
// a new archive (used for fixture 3MF/gcode.3mf files and for tests).
//
// Reads ZIP64 archives (a real Fusion 360 3MF from Printables is one). Not
// supported on purpose: encryption and multi-disk archives; a 3MF that needs
// them is refused with a plain message by the caller.
'use strict';

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_Z64_LOC = 0x07064b50;
const SIG_Z64_EOCD = 0x06064b50;

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @returns {{name:string, method:number, compSize:number, size:number, crc:number, localOffset:number}[]} */
function listZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip: too short');
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-directory record');
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff || buf.readUInt32LE(eocd + 12) === 0xffffffff) {
    // ZIP64: the real counts and offsets live in a second record, found through
    // the 20-byte locator that sits just before the end record. Fusion 360 and
    // .NET write 3MF files this way even when they are tiny.
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_Z64_LOC) throw new Error('zip64 end record is missing');
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (z64 + 56 > buf.length || buf.readUInt32LE(z64) !== SIG_Z64_EOCD) throw new Error('zip64 end record is damaged');
    count = Number(buf.readBigUInt64LE(z64 + 32));
    off = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CEN) throw new Error('zip directory is damaged');
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    let compSize = buf.readUInt32LE(off + 20);
    let size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    let localOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf-8');
    if (size === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      // The 64-bit values are in extra field 0x0001, in this fixed order, each
      // present only when its 32-bit slot above holds 0xFFFFFFFF.
      let p = off + 46 + nameLen;
      const end = p + extraLen;
      while (p + 4 <= end) {
        const id = buf.readUInt16LE(p);
        const len = buf.readUInt16LE(p + 2);
        if (id === 1) {
          let q = p + 4;
          if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        p += 4 + len;
      }
    }
    out.push({ name, method, compSize, size, crc, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The inflated bytes of one entry. Throws if it is damaged or its size is wrong. */
function readZipEntry(buf, entry) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOC) throw new Error(`zip entry ${entry.name}: bad local header`);
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const raw = buf.subarray(start, start + entry.compSize);
  if (raw.length !== entry.compSize) throw new Error(`zip entry ${entry.name}: truncated`);
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`zip entry ${entry.name}: unsupported compression method ${entry.method}`);
  if (data.length !== entry.size) throw new Error(`zip entry ${entry.name}: size mismatch`);
  return data;
}

/** True when every entry inflates and matches its CRC-32 (Python's testzip() is None). */
function isCompleteZip(buf) {
  try {
    const entries = listZip(buf);
    if (!entries.length) return false;
    for (const e of entries) {
      if (crc32(readZipEntry(buf, e)) !== e.crc) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Convenience: entry bytes by exact name (a leading slash is ignored), or null. */
function readByName(buf, name, entries) {
  const want = String(name).replace(/^\/+/, '');
  const list = entries || listZip(buf);
  const e = list.find((x) => x.name === want);
  return e ? readZipEntry(buf, e) : null;
}

/**
 * @param {{name:string, data:Buffer|string}[]} files
 * @param {{deflate?:boolean}} [opts]
 */
function createZip(files, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (1 << 5) | 1 | ((2026 - 1980) << 9);
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf-8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf-8');
    const comp = deflate && data.length ? zlib.deflateRawSync(data) : data;
    const method = comp === data ? 0 : 8;
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOC, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CEN, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

module.exports = { crc32, listZip, readZipEntry, readByName, isCompleteZip, createZip };
