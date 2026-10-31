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
  interleave,
  printablesModelUrl,
};
