// main/finder/normalize.js — turns each site's JSON into ONE shape.
//
// The renderer, the cache and the tests only ever see the shapes below; nothing
// outside the adapters knows what a Printables `publicUsername` is. A field a site does not give is `null`, never `undefined`,
// never the string "undefined".
//
//   search item   { id, site, siteId, title, author, authorUrl, cover, likes,
//                   downloads, licence, licenceName, url }
//   detail        search item + { description, images[], tags[], category,
//                   published, authorAvatar, licenceInfo, files[],
//                   download:{available, reason?, message?} }
//
// `licence` is the short label ("CC BY-NC"); `licenceName` is the site's own
// words. The spelling `licence` is deliberate and used everywhere in this app.
'use strict';

// Printables is the only live source. The other three are stubs that say they
// need an API key (main/finder/adapters/key-stubs.js).
const SITES = {
  printables: { id: 'printables', label: 'Printables' },
  thingiverse: { id: 'thingiverse', label: 'Thingiverse' },
  myminifactory: { id: 'myminifactory', label: 'MyMiniFactory' },
  cults3d: { id: 'cults3d', label: 'Cults3D' },
};

const PRINTABLE_EXTS = new Set(['stl', '3mf']);
const MESH_EXTS = new Set(['stl', '3mf', 'obj']);

const toInt = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.trunc(Number(v))) : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ── text ─────────────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

/**
 * Third-party HTML never reaches the renderer. This keeps the words, the
 * paragraph breaks and the list bullets, and drops every tag and attribute.
 */
function htmlToText(html, max = 6000) {
  if (typeof html !== 'string' || !html) return '';
  let t = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|blockquote|tr|ul|ol)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '');
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const code = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, g.toLowerCase()) ? ENTITIES[g.toLowerCase()] : m;
  });
  t = t
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + ' ...' : t;
}

// ── licence ──────────────────────────────────────────────────────────────

/**
 * @returns {{label:string|null, name:string|null, remix:'yes'|'no'|'unknown', commercial:'yes'|'no'|'unknown'}}
 */
function parseLicence(name, abbreviation) {
  const raw = str(name) || str(abbreviation);
  if (!raw) return { label: null, name: null, remix: 'unknown', commercial: 'unknown' };
  const text = `${raw} ${str(abbreviation) || ''}`.toLowerCase();

  if (/standard digital file/.test(text)) {
    return { label: 'Standard Digital File License', name: raw, remix: 'no', commercial: 'no' };
  }
  if (/private use/.test(text)) {
    return { label: 'Private Use', name: raw, remix: 'no', commercial: 'no' };
  }
  if (/\bcc0\b|public domain|zero/.test(text)) {
    return { label: 'CC0', name: raw, remix: 'yes', commercial: 'yes' };
  }
  const isCc = /creative commons|\bcc[- ]?(by|0)/.test(text);
  if (isCc) {
    const nc = /non-?commercial|\bnc\b|-nc\b/.test(text);
    const nd = /no ?deriv|\bnd\b|-nd\b/.test(text);
    const sa = /share ?alike|\bsa\b|-sa\b/.test(text);
    const parts = ['BY'];
    if (nc) parts.push('NC');
    if (sa) parts.push('SA');
    if (nd) parts.push('ND');
    return { label: `CC ${parts.join('-')}`, name: raw, remix: nd ? 'no' : 'yes', commercial: nc ? 'no' : 'yes' };
  }
  if (/lgpl/.test(text)) return { label: 'LGPL', name: raw, remix: 'yes', commercial: 'yes' };
  if (/gpl|gnu/.test(text)) return { label: 'GPL', name: raw, remix: 'yes', commercial: 'yes' };
  if (/\bbsd\b/.test(text)) return { label: 'BSD', name: raw, remix: 'yes', commercial: 'yes' };
  return { label: raw, name: raw, remix: 'unknown', commercial: 'unknown' };
}

// ── files ────────────────────────────────────────────────────────────────

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function fileKind(name) {
  const ext = extOf(name);
  if (ext === 'stp') return 'step';
  return ext || 'file';
}

const NOT_PHASE1 = 'This app downloads STL and 3MF files only. Open the model page to get this file.';

// ── Printables ───────────────────────────────────────────────────────────

const PRINTABLES_MEDIA = 'https://media.printables.com/';
const PRINTABLES_SITE = 'https://www.printables.com';

const mediaUrl = (p) => (typeof p === 'string' && p && !p.includes('..') ? PRINTABLES_MEDIA + p.replace(/^\/+/, '') : null);

function printablesModelUrl(id, slug) {
  return `${PRINTABLES_SITE}/model/${encodeURIComponent(id)}${slug ? '-' + encodeURIComponent(slug) : ''}`;
}

function printablesUserUrl(name) {
  return name ? `${PRINTABLES_SITE}/@${encodeURIComponent(name)}` : null;
}

function normalizePrintablesHit(hit) {
  if (!hit || hit.id == null) return null;
  const id = String(hit.id);
  const lic = parseLicence(hit.license && hit.license.name, hit.license && hit.license.abbreviation);
  const author = str(hit.user && hit.user.publicUsername);
  const images = Array.isArray(hit.images) ? hit.images : [];
  return {
    id: `printables:${id}`,
    site: 'printables',
    siteId: id,
    title: str(hit.name) || `Model ${id}`,
    author,
    authorUrl: printablesUserUrl(author),
    cover: images.length ? mediaUrl(images[0].filePath) : null,
    likes: toInt(hit.likesCount),
    downloads: toInt(hit.downloadCount),
    licence: lic.label,
    licenceName: lic.name,
    url: printablesModelUrl(id, str(hit.slug)),
  };
}

function printablesFile(f, group) {
  const name = str(f && f.name) || 'file';
  const kind = fileKind(name);
  const printable = PRINTABLE_EXTS.has(kind) && group === 'stls';
  return {
    id: String(f.id),
    name,
    size: toInt(f.fileSize),
    kind,
    group,
    folder: str(f.folder),
    note: str(f.note),
    previewUrl: mediaUrl(f.filePreviewPath),
    printable,
    downloadable: printable,
    reason: printable ? null : NOT_PHASE1,
    reasonShort: printable ? null : 'STL and 3MF only',
  };
}

function normalizePrintablesDetail(print) {
  const base = normalizePrintablesHit(print);
  if (!base) return null;
  const lic = parseLicence(print.license && print.license.name, print.license && print.license.abbreviation);
  const files = [];
  for (const group of ['stls', 'gcodes', 'slas', 'otherFiles']) {
    for (const f of Array.isArray(print[group]) ? print[group] : []) {
      if (f && f.id != null) files.push(printablesFile(f, group));
    }
  }
  const images = (Array.isArray(print.images) ? print.images : []).map((i) => mediaUrl(i && i.filePath)).filter(Boolean);
  const licenceHtml = print.license && typeof print.license.content === 'string' ? print.license.content : '';
  const licenceLink = /href="(https?:\/\/[^"]+)"/i.exec(licenceHtml);
  return {
    ...base,
    description: htmlToText(print.description) || htmlToText(print.summary),
    summary: str(print.summary),
    images: images.length ? images : base.cover ? [base.cover] : [],
    tags: (Array.isArray(print.tags) ? print.tags : []).map((t) => str(t && t.name)).filter(Boolean),
    category: str(print.category && print.category.name),
    published: str(print.datePublished),
    authorAvatar: mediaUrl(print.user && print.user.avatarFilePath),
    licenceInfo: {
      remix: lic.remix,
      commercial: lic.commercial,
      url: licenceLink ? licenceLink[1] : null,
      text: null,
    },
    files,
    download: { available: true },
  };
}

// ── Thingiverse ──────────────────────────────────────────────────────────

const THINGIVERSE_SITE = 'https://www.thingiverse.com';

function normalizeThingiverseHit(hit) {
  if (!hit || hit.id == null) return null;
  const id = String(hit.id);
  const lic = parseLicence(hit.license);
  const author = str(hit.creator && (hit.creator.name || hit.creator.first_name || hit.creator.username));
  return {
    id: `thingiverse:${id}`,
    site: 'thingiverse',
    siteId: id,
    title: str(hit.name) || `Thing ${id}`,
    author,
    authorUrl: str(hit.creator && hit.creator.public_url) || (author ? `${THINGIVERSE_SITE}/${encodeURIComponent(author)}` : null),
    cover: str(hit.thumbnail) || (hit.default_image && str(hit.default_image.url)) || null,
    likes: toInt(hit.like_count),
    downloads: toInt(hit.download_count),
    licence: lic.label,
    licenceName: lic.name,
    url: str(hit.public_url) || `${THINGIVERSE_SITE}/thing:${id}`,
  };
}

function thingiverseFile(f) {
  if (!f || f.id == null) return null;
  const name = str(f.name) || 'file';
  const kind = fileKind(name);
  const printable = PRINTABLE_EXTS.has(kind);
  return {
    id: String(f.id),
    name,
    size: toInt(f.size),
    kind,
    group: 'files',
    folder: null,
    note: null,
    previewUrl: str(f.thumbnail),
    printable,
    downloadable: printable,
    reason: printable ? null : NOT_PHASE1,
    reasonShort: printable ? null : 'STL and 3MF only',
  };
}

function normalizeThingiverseDetail(thing, rawFiles = []) {
  const base = normalizeThingiverseHit(thing);
  if (!base) return null;
  const lic = parseLicence(thing.license);
  const files = (Array.isArray(rawFiles) ? rawFiles : []).map(thingiverseFile).filter(Boolean);
  const images = [];
  if (base.cover) images.push(base.cover);
  const tags = (Array.isArray(thing.tags) ? thing.tags : []).map((t) => str(t && (t.name || t))).filter(Boolean);
  const cat = Array.isArray(thing.categories) && thing.categories[0] ? str(thing.categories[0].name) : null;
  return {
    ...base,
    description: htmlToText(thing.description_html) || htmlToText(thing.description),
    summary: null,
    images,
    tags,
    category: cat,
    published: str(thing.added),
    authorAvatar: str(thing.creator && (thing.creator.thumbnail || thing.creator.avatar_image)),
    licenceInfo: {
      remix: lic.remix,
      commercial: lic.commercial,
      url: null,
      text: null,
    },
    files,
    download: { available: true },
  };
}

// ── MyMiniFactory ────────────────────────────────────────────────────────

const MMF_SITE = 'https://www.myminifactory.com';
const MMF_NO_DL = 'MyMiniFactory API key does not allow file downloads (OAuth required).';

function normalizeMyMiniFactoryHit(hit) {
  if (!hit || hit.id == null) return null;
  const id = String(hit.id);
  const lic = parseLicence(hit.license);
  const author = str(hit.designer && (hit.designer.name || hit.designer.username));
  let cover = null;
  if (Array.isArray(hit.images) && hit.images[0]) {
    const img = hit.images[0];
    cover = str((img.standard && img.standard.url) || (img.original && img.original.url) || (img.thumbnail && img.thumbnail.url));
  }
  return {
    id: `myminifactory:${id}`,
    site: 'myminifactory',
    siteId: id,
    title: str(hit.name) || `Object ${id}`,
    author,
    authorUrl: str(hit.designer && hit.designer.profile_url) || (author ? `${MMF_SITE}/users/${encodeURIComponent(author)}` : null),
    cover,
    likes: toInt(hit.likes),
    downloads: toInt(hit.views),
    licence: lic.label,
    licenceName: lic.name,
    url: str(hit.url) || `${MMF_SITE}/object/3d-print-${id}`,
  };
}

function myMiniFactoryFile(f) {
  if (!f || f.id == null) return null;
  const name = str(f.filename) || str(f.name) || 'file';
  const kind = fileKind(name);
  const printable = PRINTABLE_EXTS.has(kind);
  return {
    id: String(f.id),
    name,
    size: toInt(f.size),
    kind,
    group: 'files',
    folder: null,
    note: null,
    previewUrl: str(f.thumbnail_url),
    printable,
    downloadable: false,
    reason: MMF_NO_DL,
    reasonShort: 'OAuth required',
  };
}

function normalizeMyMiniFactoryDetail(obj) {
  const base = normalizeMyMiniFactoryHit(obj);
  if (!base) return null;
  const lic = parseLicence(obj.license);
  const files = (Array.isArray(obj.files) ? obj.files : []).map(myMiniFactoryFile).filter(Boolean);
  const images = (Array.isArray(obj.images) ? obj.images : [])
    .map((img) => str((img.original && img.original.url) || (img.standard && img.standard.url) || (img.thumbnail && img.thumbnail.url)))
    .filter(Boolean);
  return {
    ...base,
    description: htmlToText(obj.description_html) || htmlToText(obj.description),
    summary: null,
    images: images.length ? images : base.cover ? [base.cover] : [],
    tags: (Array.isArray(obj.tags) ? obj.tags : []).map((t) => str(t && (t.name || t))).filter(Boolean),
    category: str(obj.category && (obj.category.name || obj.category)),
    published: str(obj.published_at),
    authorAvatar: str(obj.designer && (obj.designer.avatar_url || obj.designer.avatar)),
    licenceInfo: {
      remix: lic.remix,
      commercial: lic.commercial,
      url: null,
      text: null,
    },
    files,
    download: { available: false, reason: MMF_NO_DL },
  };
}

// ── Cults3D ──────────────────────────────────────────────────────────────

const CULTS_SITE = 'https://cults3d.com';
const CULTS_NO_DL = 'Cults3D does not provide file downloads via its API.';

function normalizeCults3dHit(hit) {
  if (!hit) return null;
  const rawId = str(hit.slug) || str(hit.id);
  if (!rawId) return null;
  const lic = parseLicence(hit.license && hit.license.name);
  const author = str(hit.creator && hit.creator.nick);
  return {
    id: `cults3d:${rawId}`,
    site: 'cults3d',
    siteId: rawId,
    title: str(hit.name) || `Creation ${rawId}`,
    author,
    authorUrl: str(hit.creator && hit.creator.shortUrl) || (author ? `${CULTS_SITE}/en/users/${encodeURIComponent(author)}` : null),
    cover: str(hit.illustrationImageUrl),
    likes: toInt(hit.likesCount),
    downloads: toInt(hit.downloadsCount),
    licence: lic.label,
    licenceName: lic.name,
    url: str(hit.url) || str(hit.shortUrl) || `${CULTS_SITE}/en/3d-model/${rawId}`,
  };
}

function cults3dFile(f, idx) {
  if (!f) return null;
  const fileUrl = str(f.fileUrl) || '';
  const m = /\/([^/?#]+)(?:[?#]|$)/.exec(fileUrl);
  const parsedName = m ? m[1] : '';
  const name = parsedName || str(f.name) || `file-${idx + 1}`;
  const kind = fileKind(name);
  const printable = PRINTABLE_EXTS.has(kind);
  return {
    id: String(f.id || idx + 1),
    name,
    size: toInt(f.size),
    kind,
    group: 'blueprints',
    folder: null,
    note: null,
    previewUrl: str(f.imageUrl),
    printable,
    downloadable: false,
    reason: CULTS_NO_DL,
    reasonShort: 'Web download only',
  };
}

function normalizeCults3dDetail(creation) {
  const base = normalizeCults3dHit(creation);
  if (!base) return null;
  const lic = parseLicence(creation.license && creation.license.name);
  const files = (Array.isArray(creation.blueprints) ? creation.blueprints : []).map(cults3dFile).filter(Boolean);
  const images = (Array.isArray(creation.illustrations) ? creation.illustrations : [])
    .map((i) => str(i && i.imageUrl))
    .filter(Boolean);
  if (!images.length && base.cover) images.push(base.cover);
  return {
    ...base,
    description: htmlToText(creation.description),
    summary: null,
    images,
    tags: (Array.isArray(creation.tags) ? creation.tags : []).map((t) => str(t && (t.name || t))).filter(Boolean),
    category: str(creation.category && (creation.category.name || creation.category)),
    published: str(creation.publishedAt),
    authorAvatar: null,
    licenceInfo: {
      remix: lic.remix,
      commercial: lic.commercial,
      url: null,
      text: null,
    },
    files,
    download: { available: false, reason: CULTS_NO_DL },
  };
}

// ── merge ────────────────────────────────────────────────────────────────

/**
 * Round-robin across the sites so the first screen shows every site, in each
 * site's own ranking order. Duplicate ids (a cached page repeated) are dropped.
 */
function interleave(lists) {
  const out = [];
  const seen = new Set();
  const queues = lists.map((l) => (Array.isArray(l) ? l.slice() : []));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const q of queues) {
      while (q.length) {
        const item = q.shift();
        if (item && !seen.has(item.id)) {
          seen.add(item.id);
          out.push(item);
          progressed = true;
          break;
        }
      }
    }
  }
  return out;
}

module.exports = {
  SITES,
  PRINTABLE_EXTS,
  MESH_EXTS,
  htmlToText,
  parseLicence,
  fileKind,
  extOf,
  normalizePrintablesHit,
  normalizePrintablesDetail,
  normalizeThingiverseHit,
  normalizeThingiverseDetail,
  normalizeMyMiniFactoryHit,
  normalizeMyMiniFactoryDetail,
  normalizeCults3dHit,
  normalizeCults3dDetail,
  interleave,
  printablesModelUrl,
};
