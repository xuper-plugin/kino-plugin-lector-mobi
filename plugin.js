// Lector de libros (prototype): reads DRM-free .mobi and .epub books inside a Kino plugin screen.
//
// Books come from Project Gutenberg (a small shelf) and from archive.org (a search box). The plugin downloads the file with
// kino.fetch (bytes as base64) and reads it here in JavaScript: a .mobi is a Palm database with PalmDOC-compressed HTML, an
// .epub is a ZIP of XHTML files listed by a spine. Both end as paragraphs, cut into pages and kept in kino.storage, so a
// book is downloaded once. The screen shows one page at a time with Previous / Next and remembers the page you were on.
//
// Not supported on purpose: books with DRM (Kindle encryption, Adobe/LCP EPUB), the old Huffman MOBI compression and images.

const GUTENBERG = "https://www.gutenberg.org";
const ARCHIVE = "https://archive.org";

/** The shelf: Project Gutenberg public-domain books, by their ebook number. */
/** About how many characters one page holds: what fits a TV screen without scrolling, and a phone reads comfortably. */
export const PAGE_CHARS = 650;
/** How many characters a page holds at each text size (the bigger the letter, the fewer fit). */
export const PAGE_LIMITS = [650, 520, 400];
/** Chapters listed, results of a search in the book and bookmarks kept: never more than these. */
const MAX_CHAPTERS = 400;
const MAX_FOUND = 40;
const MAX_MARKS = 100;
const MAX_NOTES = 200;
const NOTE_CHARS = 600;
const MAX_CATS = 6;
/** The characters of downloaded text kept in the storage (16 MB, shared); the books read longest ago lose their text first, never their notes. */
const TEXT_BUDGET = 8_000_000;
const PAGE_SEP = "\u0002";
const HEADING = "\u0001";
/** Whatever the book, never more than this many characters of text are kept (a runaway file cannot fill the storage). */
const MAX_TEXT = 3_000_000;
/** The biggest piece of a file kept whole: it is downloaded in pieces (kino.fetch answers at most 5 MB at once) and kept as base64 in the 16 MB storage meanwhile. A MOBI is cut before its pictures; a big EPUB is read by parts. */
const MAX_FILE = 9_000_000;
/** One piece of a download. */
const CHUNK = 1_500_000;
/** How long one tap may spend downloading before it keeps what it has and asks the person to tap again. */
const DOWNLOAD_BUDGET_MS = 20_000;
/** How many archive.org books stay on the shelf (the oldest is forgotten, with its text). */
const MAX_SHELF = 8;

// ---------------------------------------------------------------- bytes

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** base64 to bytes. */
export function b64decode(s) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 61) n--; // '=' padding
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) continue; // line breaks and the like
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;

/** UTF-8 bytes to a string (no TextDecoder in the sandbox). Bad sequences become U+FFFD. */
export function utf8(b, start = 0, end = b.length) {
  const parts = [];
  let chunk = [];
  let i = start;
  while (i < end) {
    const c = b[i++];
    let cp = c;
    if (c >= 0xf0 && i + 2 < end) { cp = ((c & 7) << 18) | ((b[i] & 63) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; }
    else if (c >= 0xe0 && i + 1 < end) { cp = ((c & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63); i += 2; }
    else if (c >= 0xc0 && i < end) { cp = ((c & 31) << 6) | (b[i] & 63); i += 1; }
    else if (c >= 0x80) cp = 0xfffd;
    if (cp > 0xffff) { cp -= 0x10000; chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); } else chunk.push(cp);
    if (chunk.length >= 4096) { parts.push(String.fromCharCode.apply(null, chunk)); chunk = []; }
  }
  if (chunk.length) parts.push(String.fromCharCode.apply(null, chunk));
  return parts.join("");
}

/** Windows-1252 bytes to a string (the older MOBI books). */
function cp1252(b, start, end) {
  const map = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
  const parts = [];
  for (let i = start; i < end; i += 4096) {
    const chunk = [];
    for (let j = i; j < Math.min(end, i + 4096); j++) { const c = b[j]; chunk.push(c >= 0x80 && c < 0xa0 ? map[c - 0x80] : c); }
    parts.push(String.fromCharCode.apply(null, chunk));
  }
  return parts.join("");
}

// ---------------------------------------------------------------- DEFLATE (an EPUB is a ZIP)

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman table from code lengths: how many codes of each length, and the symbols in code order. */
function huffman(lengths, n) {
  const count = new Uint16Array(16);
  const offs = new Uint16Array(16);
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { count, symbols };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  FIXED = { lit: huffman(l, 288), dist: huffman(new Uint8Array(30).fill(5), 30) };
  return FIXED;
}

/** Raw DEFLATE data to bytes ([sizeHint]: the expected size, so the buffer rarely grows). */
export function inflate(src, sizeHint = 0) {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.max(sizeHint, 1024));
  let o = 0;
  const room = (n) => {
    if (o + n <= out.length) return;
    if (o + n > MAX_TEXT * 3) throw new Error("Archivo comprimido demasiado grande");
    const bigger = new Uint8Array(Math.max(out.length * 2, o + n));
    bigger.set(out.subarray(0, o));
    out = bigger;
  };
  const bits = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error("Archivo comprimido truncado");
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbols[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("Archivo comprimido corrupto");
  };
  const codes = (lit, dist) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { room(1); out[o++] = sym; continue; }
      if (sym === 256) return;
      const s = sym - 257;
      if (s >= 29) throw new Error("Archivo comprimido corrupto");
      const len = LBASE[s] + bits(LEXT[s]);
      const ds = decode(dist);
      if (ds >= 30) throw new Error("Archivo comprimido corrupto");
      const d = DBASE[ds] + bits(DEXT[ds]);
      if (d > o) throw new Error("Archivo comprimido corrupto");
      room(len);
      for (let k = 0; k < len; k++) { out[o] = out[o - d]; o++; }
    }
  };
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      const len = le16(src, pos);
      pos += 4;
      room(len);
      out.set(src.subarray(pos, pos + len), o);
      o += len;
      pos += len;
    } else if (type === 1) {
      const t = fixedTables();
      codes(t.lit, t.dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      const lens = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lens[CL_ORDER[i]] = bits(3);
      const cl = huffman(lens.subarray(0, 19), 19);
      const all = new Uint8Array(nlen + ndist);
      let i = 0;
      while (i < nlen + ndist) {
        const sym = decode(cl);
        if (sym < 16) { all[i++] = sym; continue; }
        let prev = 0;
        let rep;
        if (sym === 16) { if (i === 0) throw new Error("Archivo comprimido corrupto"); prev = all[i - 1]; rep = 3 + bits(2); }
        else if (sym === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        if (i + rep > nlen + ndist) throw new Error("Archivo comprimido corrupto");
        while (rep--) all[i++] = prev;
      }
      codes(huffman(all.subarray(0, nlen), nlen), huffman(all.subarray(nlen), ndist));
    } else {
      throw new Error("Archivo comprimido corrupto");
    }
  } while (!last);
  return out.subarray(0, o);
}

// ---------------------------------------------------------------- ZIP and EPUB

/** The files of a ZIP: `{ names, read(name) }`, read through the central directory (stored or deflated entries only). */
export function openZip(b) {
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { e = i; break; }
  }
  if (e < 0) throw new Error("No es un archivo EPUB (ZIP)");
  const count = le16(b, e + 10);
  let p = le32(b, e + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (le32(b, p) !== 0x02014b50) break;
    const flags = le16(b, p + 8);
    const method = le16(b, p + 10);
    const csize = le32(b, p + 20);
    const usize = le32(b, p + 24);
    const nlen = le16(b, p + 28);
    const xlen = le16(b, p + 30);
    const clen = le16(b, p + 32);
    const off = le32(b, p + 42);
    entries.set(utf8(b, p + 46, p + 46 + nlen), { flags, method, csize, usize, off });
    p += 46 + nlen + xlen + clen;
  }
  const read = (name) => {
    const en = entries.get(name);
    if (!en) return null;
    if (en.flags & 1) throw new Error("Este libro tiene DRM (cifrado) y no se puede leer");
    if (en.usize > MAX_TEXT) throw new Error("Un capítulo es demasiado grande");
    const start = en.off + 30 + le16(b, en.off + 26) + le16(b, en.off + 28);
    const data = b.subarray(start, start + en.csize);
    if (en.method === 0) return data;
    if (en.method === 8) return inflate(data, en.usize);
    throw new Error("Método de compresión del EPUB no soportado");
  };
  return { names: [...entries.keys()], read };
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : "";
};
const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");
const decodePath = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** The path of an EPUB's cover picture in its package [opf] (base folder [base]), or "". */
export function epubCoverHref(opf, base) {
  const items = [];
  for (const m of opf.match(/<item\b[^>]*>/gi) || []) items.push({ id: attr(m, "id"), href: attr(m, "href"), type: attr(m, "media-type"), props: attr(m, "properties") });
  const image = (i) => /^image\/(png|jpeg|gif|webp)$/i.test(i.type);
  const metaCover = attr((/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opf) || [""])[0], "content");
  const it = items.find((i) => image(i) && /\bcover-image\b/.test(i.props)) || items.find((i) => image(i) && metaCover && i.id === metaCover);
  return it ? base + it.href.split("#")[0] : "";
}

/** A picture's bytes as a `data:` url Kino's Image takes (png, jpeg, gif or webp by what the first bytes say), or "" when it is none or too big. */
export function coverDataUrl(b) {
  if (!b || b.length < 12 || b.length > 140_000) return "";
  const mime = b[0] === 0x89 && b[1] === 0x50 ? "png" : b[0] === 0xff && b[1] === 0xd8 ? "jpeg" : b[0] === 0x47 && b[1] === 0x49 ? "gif" : b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 ? "webp" : "";
  return mime ? `data:image/${mime};base64,${b64encode(b)}` : "";
}

/** An .epub file's bytes to `{ title, html, cover }`: the spine's XHTML files, in reading order, joined. */
export function parseEpub(b) {
  const zip = openZip(b);
  const text = (name) => { const d = zip.read(name); return d ? utf8(d) : ""; };
  const enc = text("META-INF/encryption.xml");
  if (enc && /<(\w+:)?EncryptedData/i.test(enc) && !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC|fontobfuscation/i.test(enc)) {
    throw new Error("Este libro tiene DRM (cifrado) y no se puede leer");
  }
  const container = text("META-INF/container.xml");
  const rootPath = attr((/<rootfile\b[^>]*>/i.exec(container) || [""])[0], "full-path");
  if (!rootPath) throw new Error("EPUB sin contenido (falta el paquete)");
  const opf = text(rootPath);
  const base = dirOf(rootPath);
  const items = new Map();
  for (const m of opf.match(/<item\b[^>]*>/gi) || []) items.set(attr(m, "id"), { href: attr(m, "href"), type: attr(m, "media-type"), props: attr(m, "properties") });
  const titleM = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
  const title = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : "";
  const parts = [];
  let size = 0;
  for (const m of opf.match(/<itemref\b[^>]*>/gi) || []) {
    const it = items.get(attr(m, "idref"));
    if (!it || !/x?html/i.test(it.type)) continue;
    const href = it.href.split("#")[0];
    const d = zip.read(base + href) || zip.read(base + decodePath(href));
    if (!d) continue;
    parts.push(utf8(d));
    size += d.length;
    if (size >= MAX_TEXT) break;
  }
  if (parts.length === 0) throw new Error("El EPUB no tiene capítulos de texto");
  let cover = null;
  try { const href = epubCoverHref(opf, base); if (href) cover = zip.read(href) || zip.read(base + decodePath(href.slice(base.length))); } catch { /* a book without a readable cover */ }
  return { title, html: parts.join("\n"), cover };
}

// ---------------------------------------------------------------- the MOBI format

/** One PalmDOC record decompressed (the LZ77 variant MOBI uses). [out] is the shared output buffer, [at] where it is filled to. */
export function palmdoc(inp, out, at) {
  let i = 0;
  let o = at;
  const n = inp.length;
  while (i < n) {
    const c = inp[i++];
    if (c === 0 || (c >= 9 && c <= 0x7f)) {
      out[o++] = c;
    } else if (c <= 8) {
      for (let k = 0; k < c && i < n; k++) out[o++] = inp[i++];
    } else if (c >= 0xc0) {
      out[o++] = 0x20;
      out[o++] = c ^ 0x80;
    } else {
      if (i >= n) break;
      const v = ((c << 8) | inp[i++]) & 0x3fff;
      const len = (v & 7) + 3;
      const dist = v >> 3;
      if (dist === 0 || dist > o - at) break; // a broken back-reference: stop this record
      for (let k = 0; k < len; k++) { out[o] = out[o - dist]; o++; }
    }
  }
  return o;
}

/** How many bytes of trailing data a record carries (the book's extra-data flags say which kinds). */
function trailingSize(rec, flags) {
  let num = 0;
  let f = flags >> 1;
  while (f) {
    if (f & 1) {
      let size = 0;
      let bit = 0;
      let p = rec.length - num;
      while (p > 0) {
        const v = rec[p - 1];
        size |= (v & 0x7f) << bit;
        bit += 7;
        p--;
        if ((v & 0x80) || bit >= 28) break;
      }
      num += size;
    }
    f >>= 1;
  }
  if (flags & 1) num += (rec[rec.length - num - 1] & 3) + 1; // a character cut by the record boundary
  return num;
}

/** A .mobi file's bytes to `{ title, html }`. Throws an Error whose message says why a book cannot be read. */
export function parseMobi(b) {
  if (b.length < 100) throw new Error("El archivo es demasiado corto");
  const magic = String.fromCharCode(b[60], b[61], b[62], b[63], b[64], b[65], b[66], b[67]);
  if (magic !== "BOOKMOBI" && magic !== "TEXtREAd") throw new Error("No es un libro .mobi");
  const records = u16(b, 76);
  const offsets = [];
  for (let i = 0; i < records; i++) offsets.push(u32(b, 78 + i * 8));
  offsets.push(b.length);
  const rec = (i) => b.subarray(offsets[i], offsets[i + 1]);
  const r0 = offsets[0];
  const compression = u16(b, r0);
  const textLength = u32(b, r0 + 4);
  const textRecords = u16(b, r0 + 8);
  if (u16(b, r0 + 12) !== 0) throw new Error("Este libro tiene DRM (cifrado) y no se puede leer");
  if (compression !== 1 && compression !== 2) throw new Error("Compresión no soportada (HUFF/CDIC)");
  const hasMobi = String.fromCharCode(b[r0 + 16], b[r0 + 17], b[r0 + 18], b[r0 + 19]) === "MOBI";
  const headerLength = hasMobi ? u32(b, r0 + 20) : 0;
  const encoding = hasMobi ? u32(b, r0 + 28) : 1252;
  const flags = hasMobi && headerLength >= 0xe4 + 2 ? u16(b, r0 + 0xf2) : 0;
  let title = "";
  if (hasMobi) {
    const off = u32(b, r0 + 0x54);
    const len = u32(b, r0 + 0x58);
    if (off > 0 && len > 0 && r0 + off + len <= b.length) title = utf8(b, r0 + off, r0 + off + len);
  }
  const out = new Uint8Array(Math.min(textLength, MAX_TEXT) + 8192);
  let o = 0;
  for (let i = 1; i <= textRecords && i < records; i++) {
    const r = rec(i);
    const body = r.subarray(0, Math.max(0, r.length - (flags ? trailingSize(r, flags) : 0)));
    if (compression === 1) { out.set(body.subarray(0, Math.max(0, out.length - o)), o); o += Math.min(body.length, Math.max(0, out.length - o)); }
    else o = palmdoc(body, out, o);
    if (o >= MAX_TEXT) break;
  }
  const html = encoding === 65001 ? utf8(out, 0, o) : cp1252(out, 0, o);
  return { title, html };
}

/** Any supported book file to `{ title, html }`, by what its first bytes say it is. */
export function parseBook(b) {
  if (b.length > 4 && b[0] === 0x50 && b[1] === 0x4b) return parseEpub(b);
  return parseMobi(b);
}

// ---------------------------------------------------------------- text and pages

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»" };

/** The book's HTML as paragraphs; a heading is a paragraph that starts with U+0001. */
export function rawLines(html) {
  let s = html.replace(/<head[\s\S]*?<\/head>/gi, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  // The file's own line breaks are only its source wrapping (an EPUB is cut at 80 columns): paragraphs come from the tags.
  s = s.replace(/\s+/g, " ");
  // A heading is one line: the line breaks inside it (a title split by <br/>) are spaces.
  s = s.replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, inner) => "\n" + HEADING + inner.replace(/<br\s*\/?>/gi, " ") + "\n").replace(/<\/h[1-6]>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|blockquote)>|<br\s*\/?>|<mbp:pagebreak\s*\/?>|<p\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : "";
    }
    return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
  return s.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 0 && l !== HEADING);
}

/** The whole book's lines as its paragraphs: the licence cut off, and the lines that are chapter titles marked. */
export function finishLines(lines) {
  // A Project Gutenberg file wraps the book in a licence: start at the book, end with it.
  const first = lines.findIndex((l) => l.includes("*** START OF"));
  const last = lines.findIndex((l) => l.includes("*** END OF"));
  const from = first >= 0 ? first + 1 : 0;
  const to = last > from ? last : lines.length;
  // A file with no heading tags (a Kindle one) still has lines like "CHAPTER IV." or "Libro primero": they are headings too.
  return lines.slice(from, to).map((l) => (l[0] !== HEADING && isHeadingLine(l) ? HEADING + l : l));
}

/** A book's HTML as its paragraphs (a heading starts with U+0001), in one go. */
export function paragraphs(html) {
  return finishLines(rawLines(html));
}

const NUMBER = "(?:[ivxlcdm]{1,8}|\\d{1,3}|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|primero|primera|segundo|segunda|tercero|tercera|cuarto|quinto|sexto|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth)";
const HEADING_WORDS = new RegExp("^(?:(?:chapter|cap[ií]tulo|libro|book|parte|part|canto|acto|act|tratado|treatise|section|secci[óo]n)\\s+" + NUMBER + "\\b[.:]?(?:\\s.{0,60})?|pr[óo]logo|prologue|ep[ií]logo|epilogue|prefacio|preface|introducci[óo]n|introduction)$", "i");

/** Whether a short line is a chapter title: "Chapter 3", "LIBRO PRIMERO", "Prólogo", or only a Roman numeral ("XVI."). */
export function isHeadingLine(l) {
  return l.length <= 80 && (HEADING_WORDS.test(l) || /^[IVXLCDM]{1,8}\.$/.test(l));
}

/** Paragraphs cut into pages of about [limit] characters; a long paragraph is cut at a sentence end. Each page is a string; paragraphs are split by a blank line. */
export function paginate(paras, limit = PAGE_CHARS) {
  return paginateIdx(paras, limit).pages;
}

/** The pages of [paras] (each is its pieces joined by a blank line) and, for each, the index of the paragraph it starts at. */
export function paginateIdx(paras, limit = PAGE_CHARS) {
  const pieces = [];
  paras.forEach((p, idx) => {
    if (p.length <= limit || p[0] === HEADING) { pieces.push({ t: p, at: idx }); return; }
    let rest = p;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(". ", limit);
      if (cut < limit / 3) cut = rest.lastIndexOf(" ", limit);
      if (cut < limit / 3) cut = limit;
      pieces.push({ t: rest.slice(0, cut + 1).trim(), at: idx });
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) pieces.push({ t: rest, at: idx });
  });
  const pages = [];
  const starts = [];
  let cur = [];
  let len = 0;
  let from = 0;
  for (const piece of pieces) {
    if (len > 0 && len + piece.t.length > limit) { pages.push(cur.join("\n\n")); starts.push(from); cur = []; len = 0; }
    if (cur.length === 0) from = piece.at;
    cur.push(piece.t);
    len += piece.t.length;
  }
  if (cur.length) { pages.push(cur.join("\n\n")); starts.push(from); }
  return { pages, starts };
}

// ---------------------------------------------------------------- where books come from

/** The archive.org search URL for what the person typed (a title or an author, any language), only items with EPUB or Kindle. */
export function searchUrl(q) {
  const clean = String(q).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const query = `(${clean}) AND mediatype:texts AND (format:EPUB OR format:Kindle) AND -access-restricted-item:true`;
  return `${ARCHIVE}/advancedsearch.php?q=${encodeURIComponent(query)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&rows=12&sort%5B%5D=downloads+desc&output=json`;
}

const one = (v) => (Array.isArray(v) ? String(v[0] ?? "") : v == null ? "" : String(v));

/** Search results as `[{ id, title, author }]`. */
export function searchResults(json) {
  const docs = json && json.response && Array.isArray(json.response.docs) ? json.response.docs : [];
  return docs.filter((d) => d && d.identifier).map((d) => ({ id: String(d.identifier), title: one(d.title) || String(d.identifier), author: one(d.creator) })).slice(0, 12);
}

/** Of an archive.org item's files, the one to read: a plain EPUB first, then a Kindle (.mobi); never an encrypted or a huge one. */
export function pickFile(meta) {
  const files = meta && Array.isArray(meta.files) ? meta.files : [];
  const ok = (f) => !/_lcp\./i.test(f.name);
  const epubs = files.filter((f) => f.format === "EPUB" && /\.epub$/i.test(f.name) && !/_lcp\./i.test(f.name));
  // An item with many EPUBs is a collection, not a book: there is no telling which one the person wants.
  if (epubs.length > 3) throw new Error("Este elemento es una colección de muchos libros: prueba con otro resultado");
  const epub = epubs.find(ok);
  if (epub) return epub;
  const mobi = files.find((f) => f.format === "Kindle" && /\.mobi$/i.test(f.name) && ok(f));
  if (mobi) return mobi;
  throw new Error("Este libro no tiene EPUB ni Kindle sin DRM");
}

const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");

const LOANED = "Este libro es de préstamo en archive.org y no se puede descargar sin una cuenta";

/** Any EPUB bigger than this is read by parts (only its text), not downloaded whole. */
export const RANGED_MIN = 3_000_000;

/** The bytes of book [key] ("gb:<number>" or "ia:<identifier>"). */
async function download(key) {
  if (key.startsWith("lf:")) return readLocal(key.slice(3));
  if (key.startsWith("gb:")) {
    const id = encodeURIComponent(key.slice(3));
    let res = await kino.fetch(`${GUTENBERG}/ebooks/${id}.kindle.noimages`, { timeoutMs: 30000 });
    if (!res.ok) res = await kino.fetch(`${GUTENBERG}/ebooks/${id}.epub.noimages`, { timeoutMs: 30000 });
    if (!res.ok) throw new Error(`No se pudo descargar el libro (${res.status})`);
    return b64decode(res.base64());
  }
  const id = key.slice(3);
  const meta = await kino.fetch(`${ARCHIVE}/metadata/${encodeURIComponent(id)}`, { timeoutMs: 30000 });
  if (!meta.ok) throw new Error(`No se pudo consultar archive.org (${meta.status})`);
  const file = pickFile(meta.json());
  const url = `${ARCHIVE}/download/${encodeURIComponent(id)}/${encPath(file.name)}`;
  if (/\.mobi$/i.test(file.name)) return downloadPieces(url, key, mobiTextEnd);
  if (Number(file.size) > RANGED_MIN) return downloadEpubParts(url, key);
  return downloadPieces(url, key);
}

/** A book that is a file on the device: read by ranges through kino.files, no network at all. A big EPUB is read by parts like a web one. */
async function readLocal(id) {
  const info = await kino.files.info(id);
  const name = info.name.toLowerCase();
  const read = async (range) => {
    let a;
    let b;
    if (range[0] === "-") { a = Math.max(0, info.size - Number(range.slice(1))); b = info.size; }
    else { const [x, y] = range.split("-").map(Number); a = x; b = Math.min(y + 1, info.size); }
    return { bytes: await kino.files.read(id, { start: a, end: b }), total: info.size };
  };
  if (name.endsWith(".epub") && info.size > RANGED_MIN) return downloadEpubParts({ read }, "lf:" + id);
  if (info.size > MAX_FILE) throw new Error(`El libro pesa ${(info.size / 1e6).toFixed(1)} MB: es demasiado grande para este lector (máximo ${(MAX_FILE / 1e6).toFixed(0)} MB)`);
  const all = new Uint8Array(info.size);
  for (let at = 0; at < info.size; at += 1_900_000) all.set(await kino.files.read(id, { start: at, end: Math.min(info.size, at + 1_900_000) }), at);
  return all;
}

/** One Range request: the bytes and the whole file's size. [range] is "a-b" or "-n" (the last n bytes). */
async function rangeBytes(url, range) {
  if (url !== null && typeof url === "object") return url.read(range); // a file of the device (kino.files), not an address
  const res = await kino.fetch(url, { headers: { Range: `bytes=${range}` }, timeoutMs: 30000 });
  if (res.status === 401 || res.status === 403) throw new Error(LOANED);
  if (res.status !== 206) throw new Error(res.status === 200 ? "archive.org no deja leer este libro por partes" : `No se pudo descargar el libro (${res.status})`);
  const m = /\/(\d+)\s*$/.exec(res.headers["content-range"] || "");
  if (!m) throw new Error("archive.org no dijo el tamaño del libro");
  return { bytes: b64decode(res.base64()), total: Number(m[1]) };
}

/**
 * Where a MOBI's text ends: the first byte of the first record after the text records (images, fonts and the index come after),
 * read from the first piece. A book that is mostly pictures is then downloaded without them.
 */
export function mobiTextEnd(head, total) {
  if (head.length < 100) return total;
  const magic = String.fromCharCode(head[60], head[61], head[62], head[63], head[64], head[65], head[66], head[67]);
  if (magic !== "BOOKMOBI" && magic !== "TEXtREAd") return total;
  const records = u16(head, 76);
  if (78 + records * 8 > head.length) return total;
  const r0 = u32(head, 78);
  if (r0 + 10 > head.length) return total;
  const textRecords = u16(head, r0 + 8);
  if (textRecords + 1 >= records) return total;
  const end = u32(head, 78 + (textRecords + 1) * 8);
  return end > 0 && end < total ? end : total;
}

/**
 * A big file in pieces (HTTP Range), each kept in the storage as it arrives, so a tap that runs out of time loses nothing:
 * the next try goes on from the piece it stopped at. With [trim] (head bytes, file size → where to stop) only that much is read.
 * Throws an Error with `partial` set while the file is not complete.
 */
async function downloadPieces(url, key, trim) {
  const metaKey = "dl:" + key;
  let meta = { total: 0, got: 0, n: 0, target: 0 };
  try { meta = { ...meta, ...JSON.parse((await kino.storage.get(metaKey)) || "{}") }; } catch { /* a fresh start */ }
  const started = Date.now();
  while (meta.target === 0 || meta.got < meta.target) {
    if (Date.now() - started > DOWNLOAD_BUDGET_MS) {
      const pct = meta.target ? Math.round((meta.got / meta.target) * 100) : 0;
      throw Object.assign(new Error(`Descargando… ${pct} % (${(meta.got / 1e6).toFixed(1)} de ${(meta.target / 1e6).toFixed(1)} MB). Sigue sola.`), { partial: true });
    }
    const last = meta.target ? Math.min(meta.got + CHUNK, meta.target) - 1 : meta.got + CHUNK - 1;
    const res = await kino.fetch(url, { headers: { Range: `bytes=${meta.got}-${last}` }, timeoutMs: 30000 });
    const bytesB64 = res.base64();
    const bytes = b64decode(bytesB64);
    let total;
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers["content-range"] || "");
      if (!m) throw new Error("archive.org no dijo el tamaño del libro");
      total = Number(m[1]);
    } else if (res.status === 200 && meta.got === 0) {
      total = bytes.length; // the server ignored Range and sent it all
    } else if (res.status === 401 || res.status === 403) {
      throw new Error(LOANED);
    } else {
      throw new Error(`No se pudo descargar el libro (${res.status})`);
    }
    if (meta.target === 0) meta.target = trim ? Math.max(1, Math.min(total, trim(bytes, total))) : total;
    if (meta.target > MAX_FILE) {
      await clearPieces(key, meta);
      throw new Error(`El libro pesa ${(meta.target / 1e6).toFixed(1)} MB: es demasiado grande para este lector (máximo ${(MAX_FILE / 1e6).toFixed(0)} MB)`);
    }
    await kino.storage.set(`part:${key}:${meta.n}`, bytesB64);
    meta = { ...meta, total, got: meta.got + bytes.length, n: meta.n + 1 };
    await kino.storage.set(metaKey, JSON.stringify(meta));
  }
  const all = new Uint8Array(meta.got);
  let at = 0;
  for (let i = 0; i < meta.n; i++) {
    const piece = b64decode((await kino.storage.get(`part:${key}:${i}`)) || "");
    all.set(piece, at);
    at += piece.length;
  }
  await clearPieces(key, meta);
  return all;
}

async function clearPieces(key, meta) {
  for (let i = 0; i < (meta.n || 0); i++) await kino.storage.remove(`part:${key}:${i}`);
  await kino.storage.remove("dl:" + key);
}

// ---------------------------------------------------------------- a big EPUB, by parts

/** base64 of bytes. */
export function b64encode(b) {
  const parts = [];
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
    parts.push(B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "="));
  }
  return parts.join("");
}

/** The entries of a ZIP's central directory bytes: name → { flags, method, csize, usize, off, nlen, xlen, raw }. */
export function parseCentral(cd, count) {
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || le32(cd, p) !== 0x02014b50) break;
    const nlen = le16(cd, p + 28);
    const xlen = le16(cd, p + 30);
    const clen = le16(cd, p + 32);
    entries.set(utf8(cd, p + 46, p + 46 + nlen), {
      flags: le16(cd, p + 8), method: le16(cd, p + 10), csize: le32(cd, p + 20), usize: le32(cd, p + 24),
      off: le32(cd, p + 42), nlen, xlen, raw: cd.subarray(p, p + 46 + nlen + xlen + clen),
    });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

/** A ZIP made of only the given `{ raw, rec }` entries (the central directory bytes and the local record bytes of each). */
export function buildZip(list) {
  let size = 22;
  for (const e of list) size += e.rec.length + e.raw.length;
  const out = new Uint8Array(size);
  const offs = [];
  let o = 0;
  for (const e of list) { offs.push(o); out.set(e.rec, o); o += e.rec.length; }
  const cdStart = o;
  list.forEach((e, i) => {
    out.set(e.raw, o);
    out[o + 42] = offs[i] & 255; out[o + 43] = (offs[i] >> 8) & 255; out[o + 44] = (offs[i] >> 16) & 255; out[o + 45] = (offs[i] >>> 24) & 255;
    o += e.raw.length;
  });
  const cdSize = o - cdStart;
  const eocd = [0x50, 0x4b, 5, 6, 0, 0, 0, 0, list.length & 255, list.length >> 8, list.length & 255, list.length >> 8,
    cdSize & 255, (cdSize >> 8) & 255, (cdSize >> 16) & 255, (cdSize >>> 24) & 255,
    cdStart & 255, (cdStart >> 8) & 255, (cdStart >> 16) & 255, (cdStart >>> 24) & 255, 0, 0];
  out.set(eocd, o);
  return out;
}

/** The text of one entry from its local record bytes. */
function recordText(rec, en) {
  if (en.flags & 1) throw new Error("Este libro tiene DRM (cifrado) y no se puede leer");
  const start = 30 + le16(rec, 26) + le16(rec, 28);
  const data = rec.subarray(start, start + en.csize);
  if (en.method === 0) return utf8(data);
  if (en.method === 8) return utf8(inflate(data, en.usize));
  throw new Error("Método de compresión del EPUB no soportado");
}

/** The spine's files that are in the ZIP, in reading order, with the book's title. */
export function epubSpine(opf, base, has) {
  const items = new Map();
  for (const m of opf.match(/<item\b[^>]*>/gi) || []) items.set(attr(m, "id"), { href: attr(m, "href"), type: attr(m, "media-type") });
  const out = [];
  for (const m of opf.match(/<itemref\b[^>]*>/gi) || []) {
    const it = items.get(attr(m, "idref"));
    if (!it || !/x?html/i.test(it.type)) continue;
    const href = it.href.split("#")[0];
    const name = has(base + href) ? base + href : has(base + decodePath(href)) ? base + decodePath(href) : "";
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * A big EPUB's text without its pictures: the ZIP's central directory (the last bytes), then only the container, the package
 * and the spine's XHTML files, in a few Range requests, each file kept in the storage as it arrives. What comes back is a small
 * ZIP with just those files, which `parseEpub` reads as it would the whole book. Throws an Error with `partial` while it is not done.
 */
async function downloadEpubParts(url, key) {
  const started = Date.now();
  const zk = (n) => `zr:${key}:${n}`;
  let kept = [];
  try { kept = JSON.parse((await kino.storage.get("zn:" + key)) || "[]"); } catch { /* a fresh start */ }
  let central = null;
  try { central = JSON.parse((await kino.storage.get("zc:" + key)) || "null"); } catch { /* a fresh start */ }
  if (!central) {
    const tail = await rangeBytes(url, "-65536");
    const b = tail.bytes;
    let e = -1;
    for (let i = b.length - 22; i >= 0; i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { e = i; break; }
    if (e < 0) throw new Error("No es un archivo EPUB (ZIP)");
    const count = le16(b, e + 10);
    const cdSize = le32(b, e + 12);
    const cdOff = le32(b, e + 16);
    if (cdOff === 0xffffffff || count === 0xffff) throw new Error("Este EPUB es demasiado grande para este lector");
    const base = tail.total - b.length;
    const cd = cdOff >= base ? b.subarray(cdOff - base, cdOff - base + cdSize) : (await rangeBytes(url, `${cdOff}-${cdOff + cdSize - 1}`)).bytes;
    central = { count, total: tail.total, cd: b64encode(cd) };
    await kino.storage.set("zc:" + key, JSON.stringify(central));
  }
  const zip = parseCentral(b64decode(central.cd), central.count);
  const have = (n) => zip.has(n);

  /** Fetches the entries of [names] not kept yet, nearby ones in one request, and keeps each. */
  const fetchMissing = async (names) => {
    const todo = names.filter((n) => zip.has(n) && !kept.includes(n)).sort((a, b) => zip.get(a).off - zip.get(b).off);
    let at = 0;
    while (at < todo.length) {
      if (Date.now() - started > DOWNLOAD_BUDGET_MS) {
        throw Object.assign(new Error(`Descargando el texto… ${kept.length} de ${kept.length + todo.length - at} partes. Sigue sola.`), { partial: true });
      }
      const slack = 512;
      const first = zip.get(todo[at]);
      let upto = at;
      let end = first.off + 30 + first.nlen + first.xlen + first.csize + slack;
      while (upto + 1 < todo.length) {
        const nx = zip.get(todo[upto + 1]);
        const nend = nx.off + 30 + nx.nlen + nx.xlen + nx.csize + slack;
        if (nx.off - end > 120_000 || nend - first.off > CHUNK) break;
        end = nend;
        upto++;
      }
      if (end - first.off > 1_900_000) throw new Error("Un capítulo es demasiado grande");
      const got = await rangeBytes(url, `${first.off}-${Math.min(end, central.total || end) - 1}`);
      for (let i = at; i <= upto; i++) {
        const en = zip.get(todo[i]);
        const p = en.off - first.off;
        let rec = got.bytes.subarray(p, p + 30 + le16(got.bytes, p + 26) + le16(got.bytes, p + 28) + en.csize);
        if (rec.length < 30 || rec.length < 30 + le16(rec, 26) + le16(rec, 28) + en.csize) {
          rec = (await rangeBytes(url, `${en.off}-${en.off + 30 + en.nlen + 4096 + en.csize - 1}`)).bytes; // an unusually long local header
          rec = rec.subarray(0, 30 + le16(rec, 26) + le16(rec, 28) + en.csize);
        }
        await kino.storage.set(zk(todo[i]), b64encode(rec));
        kept.push(todo[i]);
      }
      await kino.storage.set("zn:" + key, JSON.stringify(kept));
      at = upto + 1;
    }
  };
  const record = async (name) => b64decode((await kino.storage.get(zk(name))) || "");

  const first = ["META-INF/container.xml", "META-INF/encryption.xml"].filter(have);
  await fetchMissing(first);
  const container = have("META-INF/container.xml") ? recordText(await record("META-INF/container.xml"), zip.get("META-INF/container.xml")) : "";
  const rootPath = attr((/<rootfile\b[^>]*>/i.exec(container) || [""])[0], "full-path");
  if (!rootPath || !have(rootPath)) throw new Error("EPUB sin contenido (falta el paquete)");
  await fetchMissing([rootPath]);
  const spine = [];
  let size = 0;
  for (const n of epubSpine(recordText(await record(rootPath), zip.get(rootPath)), dirOf(rootPath), have)) {
    spine.push(n);
    size += zip.get(n).usize;
    if (size >= MAX_TEXT) break;
  }
  await fetchMissing(spine);
  const opfText = recordText(await record(rootPath), zip.get(rootPath));
  const coverName = epubCoverHref(opfText, dirOf(rootPath));
  const cover = coverName && zip.has(coverName) && zip.get(coverName).csize <= 140_000 && zip.get(coverName).usize <= 140_000 ? [coverName] : [];
  await fetchMissing(cover);

  const names = [...first, rootPath, ...spine, ...cover];
  const list = [];
  for (const n of names) list.push({ raw: zip.get(n).raw, rec: await record(n) });
  const out = buildZip(list);
  for (const n of kept) await kino.storage.remove(zk(n));
  await kino.storage.remove("zn:" + key);
  await kino.storage.remove("zc:" + key);
  return out;
}

// ---------------------------------------------------------------- the library (download, keep, read)

/** `{ [bookKey]: { title, n, sz, fav, cat, last, cached } }`: every book the person has opened, kept for good (small). */
const LIB = "lib4";
const CATS = "cats4";
const parasKey = (key) => "paras4:" + key;
const posKey = (key) => "pos4:" + key;
const bmKey = (key) => "bm4:" + key;
const noteKey = (key) => "nt4:" + key;
const coverKey = (key) => "cover:" + key;
const BOOK_KEY = /^(gb:\d{1,8}|ia:[A-Za-z0-9][A-Za-z0-9._-]{0,100}|lf:[A-Za-z0-9]{1,64})$/;
const DEFAULT_CATS = ["Novela", "Ensayo", "Poesía", "Infantil"];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const message = (e) => (e && e.message ? String(e.message) : e && e.code ? `Error: ${e.code}` : "No se pudo abrir el libro");

/** What the reader keeps in memory about the book on show, so a page turn does not read the storage again. */
const EMPTY_LIVE = { key: "", paras: null, size: 0, fs: -1, pages: null, starts: null };
let live = EMPTY_LIVE;

/** A storage value holds at most 2 MB: the text of a long book is kept in pieces of this many characters. */
const CHUNK_CHARS = 700_000;

async function readParas(key) {
  const n = Number(await kino.storage.get(parasKey(key)));
  if (!Number.isInteger(n) || n < 1) return null;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const c = await kino.storage.get(`${parasKey(key)}:${i}`);
    if (typeof c !== "string") return null;
    parts.push(c);
  }
  return parts.join("");
}

async function removeParas(key) {
  const n = Number(await kino.storage.get(parasKey(key)));
  for (let i = 0; i < (Number.isInteger(n) ? n : 0); i++) await kino.storage.remove(`${parasKey(key)}:${i}`);
  await kino.storage.remove(parasKey(key));
}

async function writeParas(key, text) {
  await removeParas(key);
  const n = Math.ceil(text.length / CHUNK_CHARS);
  try {
    for (let i = 0; i < n; i++) await kino.storage.set(`${parasKey(key)}:${i}`, text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
    await kino.storage.set(parasKey(key), String(n));
  } catch (e) {
    for (let i = 0; i < n; i++) await kino.storage.remove(`${parasKey(key)}:${i}`);
    throw new Error("No cabe en el almacenamiento del plugin: borra algún libro de tu biblioteca");
  }
}

async function libraryMap() {
  try {
    const m = JSON.parse((await kino.storage.get(LIB)) || "{}");
    const out = {};
    if (m && typeof m === "object") for (const [k, v] of Object.entries(m)) if (BOOK_KEY.test(k) && v && v.title) out[k] = v;
    return out;
  } catch { return {}; }
}

const saveLibrary = (m) => kino.storage.set(LIB, JSON.stringify(m));

/** The library, the last book read first: `{ key, title, n, fav, cat, cached, last }`. */
async function shelf() {
  return Object.entries(await libraryMap()).map(([key, v]) => ({ key, ...v })).sort((a, b) => (b.last || 0) - (a.last || 0));
}

async function categories() {
  try {
    const c = JSON.parse((await kino.storage.get(CATS)) || "null");
    if (Array.isArray(c)) return c.filter((x) => typeof x === "string" && x).slice(0, MAX_CATS);
  } catch { /* the defaults */ }
  return DEFAULT_CATS;
}

/** Drops a book from the library, with its text, place, bookmarks, notes and cover. */
async function forget(key) {
  await removeParas(key);
  for (const k of [posKey(key), bmKey(key), noteKey(key), coverKey(key)]) await kino.storage.remove(k);
  const m = await libraryMap();
  delete m[key];
  await saveLibrary(m);
  if (live.key === key) live = EMPTY_LIVE;
}

/** Only the downloaded text goes (the book stays in the library with its notes and place, and downloads again when opened). */
async function dropText(key) {
  await removeParas(key);
  const m = await libraryMap();
  if (m[key]) { m[key].cached = false; m[key].sz = 0; await saveLibrary(m); }
  if (live.key === key) live = EMPTY_LIVE;
}

/**
 * The book is open now: it goes first in the library (added if new), keeps its favourite mark and category, and when the texts
 * kept pass [TEXT_BUDGET] characters the ones read longest ago are dropped (never this one).
 */
async function touchLibrary(key, title, n, size) {
  const m = await libraryMap();
  const old = m[key] || {};
  m[key] = { title: title || old.title || key, n, sz: size, fav: !!old.fav, cat: old.cat || "", last: Date.now(), cached: true };
  const byAge = Object.entries(m).filter(([k, v]) => k !== key && v.cached).sort((a, b) => (a[1].last || 0) - (b[1].last || 0));
  let total = Object.values(m).reduce((t, v) => t + (v.cached ? v.sz || 0 : 0), 0);
  for (const [k, v] of byAge) {
    if (total <= TEXT_BUDGET) break;
    await removeParas(k);
    total -= v.sz || 0;
    m[k] = { ...v, cached: false, sz: 0 };
  }
  await saveLibrary(m);
}

async function patchBook(key, patch) {
  const m = await libraryMap();
  if (!m[key]) return false;
  m[key] = { ...m[key], ...patch };
  await saveLibrary(m);
  return true;
}

/** The paragraphs of book [key], from the storage or downloaded and read now (a heading starts with U+0001). */
async function parasOf(key) {
  if (live.key === key && live.paras) return { paras: live.paras, size: live.size };
  const kept = await readParas(key);
  if (typeof kept !== "string" || kept.length === 0) return null;
  const paras = kept.split("\n");
  live = { key, paras, size: kept.length, fs: -1, pages: null, starts: null };
  return { paras, size: kept.length };
}

/** The book's text, for a screen that shows it: kept already, or a friendly error (the person opens it again from the library). */
async function parasNow(key) {
  const got = await parasOf(key);
  if (!got) throw new Error("El texto de este libro ya no está guardado: ábrelo otra vez desde tu biblioteca");
  return got;
}

const SLICE_CHARS = 150_000;
/** One step of getting a book ready takes about this long at most (an event call may last 20 s, and a phone is slow). */
const STEP_MS = 7_000;
const prepKey = (key) => "prep4:" + key;
const htmlKey = (key, i) => `html4:${key}:${i}`;
const rawKey = (key, i) => `raw4:${key}:${i}`;

/** Cuts [html] into pieces of about [size] characters, each ending at the end of a paragraph, division or break where one is near. */
export function sliceHtml(html, size = SLICE_CHARS) {
  const out = [];
  let at = 0;
  while (at < html.length) {
    let end = Math.min(html.length, at + size);
    if (end < html.length) {
      let cut = -1;
      for (const t of ["</p>", "</div>", "<br/>", "<br>", "<br />"]) {
        const k = html.indexOf(t, end);
        if (k >= 0 && k - end < 20_000 && (cut < 0 || k + t.length < cut)) cut = k + t.length;
      }
      if (cut < 0) { const m = html.indexOf(">", end); cut = m >= 0 ? m + 1 : html.length; }
      end = cut;
    }
    out.push(html.slice(at, end));
    at = end;
  }
  return out;
}

async function prepClear(key) {
  let meta = null;
  try { meta = JSON.parse((await kino.storage.get(prepKey(key))) || "null"); } catch { /* none */ }
  for (let i = 0; i < (meta ? meta.n : 0); i++) { await kino.storage.remove(htmlKey(key, i)); await kino.storage.remove(rawKey(key, i)); }
  await kino.storage.remove(prepKey(key));
}

/**
 * One step of getting book [key] ready to read. Returns `{ paras, size }` when it is, else `{ pct }` and the next step goes on
 * from what was kept: first the download and the file's reading (cut into pieces of HTML), then each piece into its paragraphs
 * (a few per step), then the pieces joined, the licence cut off and the text kept. Throws an Error with `partial` while the
 * download itself is not finished.
 */
async function prepare(key) {
  const started = Date.now();
  let meta = null;
  try { meta = JSON.parse((await kino.storage.get(prepKey(key))) || "null"); } catch { /* a fresh start */ }
  if (!meta) {
    const { html, cover } = parseBook(await download(key));
    const slices = sliceHtml(html);
    for (let i = 0; i < slices.length; i++) await kino.storage.set(htmlKey(key, i), slices[i]);
    const coverUrl = coverDataUrl(cover);
    if (coverUrl) await kino.storage.set(coverKey(key), coverUrl);
    meta = { n: slices.length, i: 0 };
    await kino.storage.set(prepKey(key), JSON.stringify(meta));
    return { pct: 0 };
  }
  while (meta.i < meta.n && Date.now() - started < STEP_MS) {
    const html = (await kino.storage.get(htmlKey(key, meta.i))) || "";
    await kino.storage.set(rawKey(key, meta.i), rawLines(html).join("\n"));
    await kino.storage.remove(htmlKey(key, meta.i));
    meta.i++;
    await kino.storage.set(prepKey(key), JSON.stringify(meta));
  }
  if (meta.i < meta.n) return { pct: Math.round((meta.i / meta.n) * 100) };
  const lines = [];
  for (let i = 0; i < meta.n; i++) for (const l of ((await kino.storage.get(rawKey(key, i))) || "").split("\n")) if (l) lines.push(l);
  const paras = finishLines(lines);
  if (paras.length === 0) { await prepClear(key); throw new Error("El libro no tiene texto"); }
  const joined = paras.join("\n");
  await writeParas(key, joined);
  await prepClear(key);
  live = { key, paras, size: joined.length, fs: -1, pages: null, starts: null };
  return { paras, size: joined.length };
}

/** The pages of the book on show at text size [fs] (a page holds fewer characters at a bigger size), and where each starts. */
function pagesFor(paras, fs) {
  if (live.paras === paras && live.fs === fs && live.pages) return live;
  const { pages, starts } = paginateIdx(paras, PAGE_LIMITS[fs]);
  live = { ...live, fs, pages, starts };
  return live;
}

/** The index of the page that holds paragraph [p]. */
export function pageOf(starts, p) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= p) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * The headings of the book, as chapters: `{ t, p }` (title, paragraph). A run of five or more headings with hardly any text
 * between them whose titles come back later is a table of contents, and is left out (the chapters themselves are what is listed).
 */
export function chaptersOf(paras) {
  const all = [];
  for (let i = 0; i < paras.length; i++) {
    if (paras[i][0] !== HEADING) continue;
    const t = paras[i].slice(1).replace(/\s+/g, " ").trim().slice(0, 80);
    if (t && (all.length === 0 || all[all.length - 1].t !== t)) all.push({ t, p: i });
  }
  const out = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].p - all[j].p <= 2) j++;
    const run = all.slice(i, j + 1);
    const later = new Set(all.slice(j + 1).map((c) => c.t));
    const isToc = run.length >= 5 && run.filter((c) => later.has(c.t)).length * 2 >= run.length;
    if (!isToc) out.push(...run);
    i = j + 1;
  }
  return out.slice(0, MAX_CHAPTERS);
}

const plain = (s) => s.replace(/[áàäâ]/g, "a").replace(/[éèëê]/g, "e").replace(/[íìïî]/g, "i").replace(/[óòöô]/g, "o").replace(/[úùüû]/g, "u").replace(/ñ/g, "n");

/** Where [query] is in the book (case and accents aside): up to [MAX_FOUND] `{ p, t }` with a bit of the text around it. */
export function findInBook(paras, query) {
  const q = plain(String(query).toLowerCase().trim());
  if (q.length < 3) return [];
  const out = [];
  for (let i = 0; i < paras.length && out.length < MAX_FOUND; i++) {
    const text = paras[i][0] === HEADING ? paras[i].slice(1) : paras[i];
    const at = plain(text.toLowerCase()).indexOf(q);
    if (at < 0) continue;
    const from = Math.max(0, at - 30);
    out.push({ p: i, t: (from > 0 ? "…" : "") + text.slice(from, from + 90) });
  }
  return out;
}

/** A list the person keeps for a book (bookmarks or notes), from the storage: `{ p, t }` sorted by place. */
async function listOf(key, storageKey) {
  try {
    const m = JSON.parse((await kino.storage.get(storageKey(key))) || "[]");
    return Array.isArray(m) ? m.filter((x) => x && Number.isInteger(x.p)).sort((a, b) => a.p - b.p) : [];
  } catch { return []; }
}
const marksOf = (key) => listOf(key, bmKey);
const notesOf = (key) => listOf(key, noteKey);

async function placeOf(key) {
  const p = Number(await kino.storage.get(posKey(key)));
  return Number.isInteger(p) && p > 0 ? p : 0;
}

// ---------------------------------------------------------------- Project Gutenberg's catalogue (Gutendex)

const GUTENDEX = "https://gutendex.com/books/";
const LANGS = { es: "español", en: "inglés", fr: "francés", de: "alemán", pt: "portugués", it: "italiano", la: "latín" };

export function gutendexUrl(q, lang, page) {
  const parts = [];
  const clean = String(q || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (clean) parts.push("search=" + encodeURIComponent(clean));
  if (lang && lang !== "all") parts.push("languages=" + encodeURIComponent(lang));
  parts.push("page=" + (page | 0 || 1));
  return GUTENDEX + "?" + parts.join("&");
}

/** Gutendex's answer to `{ items: { id, title, author, lang }[], more }`: only books with a Kindle or EPUB file. */
export function gutendexItems(json) {
  const list = json && Array.isArray(json.results) ? json.results : [];
  const items = [];
  for (const r of list) {
    const f = r && r.formats ? r.formats : {};
    if (!Number.isInteger(r.id) || !r.title || !(f["application/x-mobipocket-ebook"] || f["application/epub+zip"])) continue;
    const name = r.authors && r.authors[0] && r.authors[0].name ? String(r.authors[0].name) : "";
    const author = name.includes(", ") ? name.split(", ").slice(1).join(" ") + " " + name.split(", ")[0] : name;
    items.push({ id: String(r.id), title: String(r.title).slice(0, 120), author: author.slice(0, 60), lang: r.languages && r.languages[0] ? String(r.languages[0]) : "" });
  }
  return { items, more: !!(json && json.next) };
}

async function gutenberg(q, lang, page) {
  const res = await kino.fetch(gutendexUrl(q, lang, page), { timeoutMs: 40000 });
  if (!res.ok) throw new Error(`El catálogo de Gutenberg no respondió (${res.status}). Prueba otra vez en un momento.`);
  return gutendexItems(res.json());
}

// ---------------------------------------------------------------- the screen

const TABS = ["gutenberg", "archive", "files", "mine"];
/** Whether this Kino has `kino.files` (0.9.82 and later): the tab of files on the device only shows where it can work. */
const hasFiles = () => typeof kino === "object" && kino !== null && typeof kino.files === "object" && kino.files !== null;
const TOC_TABS = ["chapters", "marks", "notes", "find"];
const BUSY = (v) => [{ show: "loading" + v }, { hide: "content" + v }];
const SIZES = ["p", "h4", "h3"];
const fontOf = (s) => clamp(Number.isInteger(s.fs) ? s.fs : 0, 0, SIZES.length - 1);

const cover = (key, icon, own) => ({
  type: "Image", key: "cv" + key, width: 48, aspect: "2:3", fit: "cover", alt: "Portada", altEn: "Cover",
  url: own || (key.startsWith("gb:") ? `${GUTENBERG}/cache/epub/${key.slice(3)}/pg${key.slice(3)}.cover.medium.jpg` : key.startsWith("ia:") ? `${ARCHIVE}/services/img/${encodeURIComponent(key.slice(3))}` : undefined),
  fallback: { type: "Icon", name: icon },
});

/** One book of a list: its cover, title and a line under it; a tap opens it, a long press (with [press]) opens the book's menu. */
function tile(s, key, title, subtitle, press) {
  const v = s.v | 0;
  return {
    type: "ListTile", key: "t:" + key, title, titleEn: title, subtitle: subtitle || undefined, subtitleEn: subtitle || undefined,
    leading: cover(key, "bookmark", s.covers && s.covers[key]),
    onTap: { ui: BUSY(v), event: "openBook", arg: key },
    ...(press ? { onLongPress: { event: press === true ? "bookMenu" : press, arg: key } } : {}),
  };
}

const skeleton = (v) => ({
  type: "Column", key: "loading" + v, hidden: true, padding: 16, gap: 12,
  children: [0, 1, 2].map((i) => ({ type: "Skeleton", key: "sk" + i, shape: "line", lines: 2 })),
});

const empty = (key, icon, title, titleEn, text, textEn) => ({ type: "emptyState", key, icon, title, titleEn, text, textEn });

function gutenbergTab(s) {
  const v = s.v | 0;
  const g = s.gb || { q: "", lang: "es", items: null, more: false };
  const search = {
    type: "Column", key: "gbBox", padding: 16, gap: 8,
    children: [
      {
        type: "TextField", key: "gq", kind: "search", labelText: "Buscar en Project Gutenberg", labelTextEn: "Search Project Gutenberg",
        hintText: "Título o autor", hintTextEn: "Title or author", value: g.q || "",
        onSubmitted: { ui: BUSY(v), event: "gbSearch" }, trailingIcon: "search", trailingLabel: "Buscar", trailingLabelEn: "Search", onTrailingTap: { ui: BUSY(v), event: "gbSearch" },
      },
      {
        type: "Chips", key: "gl", value: g.lang || "es", onChanged: { ui: BUSY(v), event: "gbLang" },
        options: [{ value: "es", label: "Español", labelEn: "Spanish" }, { value: "en", label: "Inglés", labelEn: "English" }, { value: "all", label: "Todos", labelEn: "All" }],
      },
    ],
  };
  if (g.items === null) return [search, empty("gbhint", "search", "Buscando libros…", "Finding books…", "El catálogo de Project Gutenberg tiene más de 70 000 libros libres.", "Project Gutenberg has over 70,000 free books.")];
  if (g.items.length === 0) return [search, empty("gbnone", "search", "Sin resultados", "No results", "Prueba con otra palabra o con «Todos» los idiomas.", "Try another word or «All» languages.")];
  return [
    search,
    ...g.items.map((b) => tile(s, "gb:" + b.id, b.title, [b.author, LANGS[b.lang] || b.lang].filter(Boolean).join(" · "))),
    ...(g.more ? [{ type: "Column", key: "gbMore", padding: 16, children: [{ type: "button", key: "gbMoreBtn", label: "Más libros", labelEn: "More books", variant: "secondary", onTap: { ui: BUSY(v), event: "gbMore" } }] }] : []),
  ];
}

function archiveTab(s) {
  const v = s.v | 0;
  const results = Array.isArray(s.results) ? s.results : null;
  return [
    {
      type: "Column", key: "searchBox", padding: 16,
      children: [{
        type: "TextField", key: "q", kind: "search", labelText: "Buscar en archive.org", labelTextEn: "Search archive.org",
        hintText: "Título o autor", hintTextEn: "Title or author", onSubmitted: { ui: BUSY(v), event: "search" },
        trailingIcon: "search", trailingLabel: "Buscar", trailingLabelEn: "Search", onTrailingTap: { ui: BUSY(v), event: "search" },
      }],
    },
    ...(results === null
      ? [empty("hint", "search", "Busca un libro", "Find a book", "Solo salen los que tienen EPUB o Kindle.", "Only books with an EPUB or Kindle file show up.")]
      : results.length === 0
        ? [empty("none", "search", "Sin resultados", "No results", "Prueba con otra palabra.", "Try another word.")]
        : results.map((r) => tile(s, "ia:" + r.id, r.title, r.author))),
  ];
}

/** Files on this device: pick books with Kino's picker, list them, a tap reads one. Nothing is uploaded; the book stays where it is. */
function filesTab(s) {
  const list = Array.isArray(s.fileList) ? s.fileList : [];
  const pick = {
    type: "Column", key: "pickBox", padding: 16, gap: 8,
    children: [
      { type: "button", key: "pickBtn", label: "Elegir libros de este aparato", labelEn: "Pick books from this device", variant: "primary", onTap: "pickBook" },
      { type: "text", key: "pickHint", text: "Libros .epub y .mobi que ya tienes en tu aparato. No se sube nada: se leen desde donde están.", textEn: "Books (.epub, .mobi) you already have on your device. Nothing is uploaded: they are read where they are.", style: "caption", color: "muted" },
    ],
  };
  if (list.length === 0) return [pick, empty("nofiles", "bookmark", "Aún no has elegido ningún libro", "No book picked yet", "Toca el botón de arriba y elige uno o varios.", "Tap the button above and pick one or several.")];
  return [pick, ...list.map((f) => tile(s, "lf:" + f.id, f.name.replace(/\.[A-Za-z0-9]{2,5}$/, ""), `${(f.size / 1e6).toFixed(1)} MB · ${f.name.slice(f.name.lastIndexOf(".") + 1).toUpperCase()}`, "fileMenu"))];
}

/** My library: a filter (all, favourites, or one category) over the books the person has opened. */
function mineTab(s, mine) {
  const used = [...new Set(mine.map((m) => m.cat).filter(Boolean))].slice(0, MAX_CATS);
  const filter = s.filter === "fav" || used.includes(s.filter) ? s.filter : "all";
  const shown = mine.filter((m) => (filter === "all" ? true : filter === "fav" ? m.fav : m.cat === filter));
  const chips = {
    type: "Column", key: "mineBox", padding: 16,
    children: [{
      type: "Chips", key: "lf", value: filter, onChanged: "libFilter",
      options: [{ value: "all", label: `Todos (${mine.length})`, labelEn: `All (${mine.length})` }, { value: "fav", label: "Favoritos", labelEn: "Favourites" }, ...used.map((c) => ({ value: c, label: c }))],
    }],
  };
  if (mine.length === 0) return [empty("nomine", "bookmark", "Tu biblioteca está vacía", "Your library is empty", "Los libros que abras quedan aquí, en la página donde los dejaste. Mantén pulsado uno para marcarlo como favorito, ponerle categoría o borrarlo.", "Books you open stay here, on the page you left them. Press and hold one to make it a favourite, give it a category or delete it.")];
  return [
    chips,
    ...(shown.length === 0 ? [empty("nofilter", "search", "Ningún libro aquí", "No book here", "Cambia el filtro o marca algún libro.", "Change the filter or mark a book.")] : []),
    ...shown.map((m) => {
      const pct = m.n > 1 ? Math.round(((s.places && s.places[m.key]) || 0) / (m.n - 1) * 100) : 0;
      const bits = [m.fav ? "★" : "", m.cat, `${pct} %`, m.key.startsWith("gb:") ? "Gutenberg" : "archive.org"].filter(Boolean);
      return tile(s, m.key, m.title, bits.join(" · "), true);
    }),
  ];
}

function library(s, mine) {
  const tab = TABS.includes(s.tab) ? s.tab : "gutenberg";
  const rows = tab === "gutenberg" ? gutenbergTab(s) : tab === "archive" ? archiveTab(s) : tab === "files" ? filesTab(s) : mineTab(s, mine);
  const v = s.v | 0;
  const notes = [];
  if (s.error) {
    notes.push({
      type: "MaterialBanner", key: "err", role: "error", text: s.error, textEn: s.error,
    });
  }
  if (s.prep) {
    const text = s.prep.text || `Preparando «${s.prep.title}»… ${s.prep.pct | 0} %`;
    notes.push({ type: "MaterialBanner", key: "prep", role: "info", text, textEn: text, action: { label: "Cancelar", labelEn: "Cancel", onTap: "cancel" } });
  }
  const drop = s.askDrop && mine.find((m) => m.key === s.askDrop);
  if (drop) {
    notes.push({
      type: "MaterialBanner", key: "drop", role: "warning", text: `¿Borrar «${drop.title}» de tu biblioteca, con sus notas y marcadores?`, textEn: `Delete «${drop.title}» from your library, with its notes and bookmarks?`,
      action: { label: "Borrar", labelEn: "Delete", onTap: { event: "dropYes", arg: drop.key } },
    });
  }
  return {
    type: "Scaffold",
    every: s.prep ? { ms: 400, event: "prep" } : undefined,
    appBar: {
      type: "AppBar", key: "barLib", mergeWithKinoBar: true, dense: true,
      leading: { type: "IconButton", key: "closeLib", icon: "close", labelText: "Cerrar", labelTextEn: "Close", onPressed: { close: true } },
      title: {
        type: "TabBar", key: "tabs", value: tab, onChanged: "tab", tabs: [
          { value: "gutenberg", label: "Gutenberg", labelEn: "Gutenberg" },
          { value: "archive", label: "archive.org", labelEn: "archive.org" },
          ...(hasFiles() ? [{ value: "files", label: "Mis archivos", labelEn: "My files" }] : []),
          { value: "mine", label: "Mi biblioteca", labelEn: "My library" },
        ],
      },
    },
    body: {
      type: "SingleChildScrollView", key: "libScroll",
      children: [{ type: "Column", key: "libCol", children: [...notes, skeleton(v), { type: "Column", key: "content" + v, children: rows }] }],
    },
  };
}

/** The place a page starts and where the next one does (Infinity for the last): the paragraphs a page holds. */
const spanOf = (starts, page) => [starts[page], page < starts.length - 1 ? starts[page + 1] : Infinity];

/** The book on show: its page, the slider, the arrows, the text size, and the bar with the mark, the note, the book's menu and the contents. */
function reader(s, book, marks, notes) {
  const { pages, starts } = book;
  const last = pages.length - 1;
  const page = pageOf(starts, s.p | 0);
  const [from, to] = spanOf(starts, page);
  const marked = marks.some((m) => m.p >= from && m.p < to);
  const noted = notes.some((m) => m.p >= from && m.p < to);
  const blocks = pages[page].split("\n\n").map((p, i) =>
    p[0] === HEADING
      ? { type: "text", key: "para" + i, text: p.slice(1), textEn: p.slice(1), style: "h2" }
      : { type: "text", key: "para" + i, text: p, textEn: p, style: SIZES[fontOf(s)] });
  const pct = last > 0 ? Math.round((page / last) * 100) : 100;
  const btn = (key, icon, label, labelEn, onPressed, off) => ({ type: "IconButton", key, icon, labelText: label, labelTextEn: labelEn, onPressed, enabled: !off });
  return {
    type: "Scaffold",
    onBack: "lib",
    appBar: {
      type: "AppBar", key: "barRead", mergeWithKinoBar: true, dense: true,
      title: s.title || "Libro", titleEn: s.title || "Book",
      leading: { type: "IconButton", key: "backRead", icon: "arrow_back", labelText: "Biblioteca", labelTextEn: "Library", onPressed: "lib" },
      actions: [
        { type: "IconButton", key: "mark", icon: "bookmark", selected: marked, labelText: marked ? "Quitar el marcador" : "Poner un marcador", labelTextEn: marked ? "Remove the bookmark" : "Add a bookmark", onPressed: "mark" },
        { type: "IconButton", key: "note", icon: "edit", selected: noted, labelText: noted ? "Editar la nota de esta página" : "Escribir una nota en esta página", labelTextEn: noted ? "Edit this page's note" : "Write a note on this page", onPressed: "noteOpen" },
        { type: "IconButton", key: "bookMenuBtn", icon: "more_vert", labelText: "Favorito y categoría", labelTextEn: "Favourite and category", onPressed: { event: "bookMenu", arg: s.key } },
        { type: "IconButton", key: "toc", icon: "list", labelText: "Contenido, marcadores, notas y búsqueda", labelTextEn: "Contents, bookmarks, notes and search", onPressed: "toc" },
      ],
    },
    body: {
      type: "Column", key: "readBody", fill: true, onSwipeLeft: { event: "nav", arg: "next" }, onSwipeRight: { event: "nav", arg: "prev" },
      children: [
        {
          type: "SingleChildScrollView", key: "text" + page, flex: 1, zoom: true,
          children: [{ type: "Column", key: "blocks", gap: 12, padding: { compact: 16, medium: 24, expanded: 32 }, children: blocks }],
        },
        {
          type: "Column", key: "controls", padding: 12, gap: 4,
          children: [
            ...(last > 0 ? [{
              type: "Slider", key: "jump", min: 0, max: last, step: 1, value: page, onChanged: "jump",
              labelText: `Página ${page + 1} de ${pages.length} · ${pct} %`, labelTextEn: `Page ${page + 1} of ${pages.length} · ${pct} %`,
            }] : []),
            {
              type: "Row", key: "steps", mainAxisAlignment: "center", gap: 16,
              children: [
                btn("fontDown", "remove", "Letra más pequeña", "Smaller text", { event: "font", arg: "-1" }, fontOf(s) === 0),
                btn("prev", "arrow_back", "Página anterior", "Previous page", { event: "nav", arg: "prev" }, page === 0),
                btn("next", "arrow_forward", "Página siguiente", "Next page", { event: "nav", arg: "next" }, page === last),
                btn("fontUp", "add", "Letra más grande", "Larger text", { event: "font", arg: "1" }, fontOf(s) === SIZES.length - 1),
              ],
            },
          ],
        },
      ],
    },
  };
}

/** Contents, bookmarks, notes and search of the book on show. */
function contents(s, book, paras, marks, notes) {
  const tab = TOC_TABS.includes(s.tocTab) ? s.tocTab : "chapters";
  const { starts } = book;
  const pageNo = (p) => `Página ${pageOf(starts, p) + 1} de ${starts.length}`;
  const pageNoEn = (p) => `Page ${pageOf(starts, p) + 1} of ${starts.length}`;
  const row = (key, title, p, onLongPress) => ({
    type: "ListTile", key, title, titleEn: title, subtitle: pageNo(p), subtitleEn: pageNoEn(p), dense: true,
    onTap: { event: "goP", arg: String(p) }, ...(onLongPress ? { onLongPress } : {}),
  });
  const hint = (key, es, en) => ({ type: "text", key, text: es, textEn: en, style: "caption", color: "muted", padding: 16 });
  let rows;
  if (tab === "chapters") {
    const ch = chaptersOf(paras);
    rows = ch.length ? ch.map((c, i) => row("ch" + i, c.t, c.p)) : [empty("noch", "list", "Este libro no marca capítulos", "This book marks no chapters", "Usa el deslizador o la búsqueda para moverte.", "Use the slider or the search to move around.")];
  } else if (tab === "marks") {
    rows = marks.length
      ? [hint("markHint", "Mantén pulsado un marcador para borrarlo.", "Press and hold a bookmark to delete it."), ...marks.map((m) => row("bm" + m.p, m.t || "Marcador", m.p, { event: "markDel", arg: String(m.p) }))]
      : [empty("nomark", "bookmark", "Sin marcadores", "No bookmarks", "Toca el marcador de la barra para guardar la página donde estás.", "Tap the bookmark in the bar to keep the page you are on.")];
  } else if (tab === "notes") {
    rows = notes.length
      ? [hint("noteHint", "Toca una nota para ir a su página. Mantén pulsada una para borrarla.", "Tap a note to go to its page. Press and hold one to delete it."), ...notes.map((m) => row("nt" + m.p, m.t, m.p, { event: "noteDel", arg: String(m.p) }))]
      : [empty("nonote", "edit", "Sin notas", "No notes", "Toca el lápiz de la barra para escribir una nota en la página donde estás.", "Tap the pencil in the bar to write a note on the page you are on.")];
  } else {
    const found = Array.isArray(s.found) ? s.found : null;
    rows = [
      {
        type: "Column", key: "findBox", padding: 16,
        children: [{
          type: "TextField", key: "fq", kind: "search", labelText: "Buscar en este libro", labelTextEn: "Search this book",
          hintText: "Una palabra o una frase", hintTextEn: "A word or a phrase", onSubmitted: "find",
          trailingIcon: "search", trailingLabel: "Buscar", trailingLabelEn: "Search", onTrailingTap: "find",
        }],
      },
      ...(found === null ? [] : found.length === 0
        ? [empty("nofind", "search", "No aparece", "Not found", "Prueba con otra palabra (mínimo tres letras).", "Try another word (at least three letters).")]
        : found.map((f, i) => row("f" + i, f.t, f.p))),
    ];
  }
  return {
    type: "Scaffold",
    onBack: "closeToc",
    appBar: {
      type: "AppBar", key: "barToc", mergeWithKinoBar: true, dense: true,
      leading: { type: "IconButton", key: "backToc", icon: "arrow_back", labelText: "Volver al libro", labelTextEn: "Back to the book", onPressed: "closeToc" },
      title: {
        type: "TabBar", key: "tocTabs", value: tab, onChanged: "tocTab", tabs: [
          { value: "chapters", label: "Capítulos", labelEn: "Chapters" },
          { value: "marks", label: "Marcadores", labelEn: "Bookmarks" },
          { value: "notes", label: "Notas", labelEn: "Notes" },
          { value: "find", label: "Buscar", labelEn: "Search" },
        ],
      },
    },
    body: { type: "SingleChildScrollView", key: "tocScroll", children: [{ type: "Column", key: "tocCol" + tab, children: rows }] },
  };
}

/** The note of the page on show: one box, Save and Delete. */
function noteScreen(s, book, notes) {
  const { starts } = book;
  const page = pageOf(starts, s.p | 0);
  const [from, to] = spanOf(starts, page);
  const mine = notes.find((m) => m.p >= from && m.p < to);
  const pageNo = `Página ${page + 1} de ${starts.length}`;
  return {
    type: "Scaffold",
    onBack: "closeNote",
    appBar: {
      type: "AppBar", key: "barNote", mergeWithKinoBar: true, dense: true, title: "Nota", titleEn: "Note",
      leading: { type: "IconButton", key: "backNote", icon: "arrow_back", labelText: "Volver al libro", labelTextEn: "Back to the book", onPressed: "closeNote" },
    },
    body: {
      type: "SingleChildScrollView", key: "noteScroll",
      children: [{
        type: "Column", key: "noteCol", padding: 16, gap: 12,
        children: [
          { type: "text", key: "noteWhere", text: `${s.title || ""} · ${pageNo}`, textEn: `${s.title || ""} · Page ${page + 1} of ${starts.length}`, style: "caption", color: "muted" },
          { type: "TextField", key: "nt", labelText: "Tu nota", labelTextEn: "Your note", multiline: true, maxLength: NOTE_CHARS, value: mine ? mine.t : "" },
          { type: "button", key: "noteSave", label: "Guardar la nota", labelEn: "Save the note", variant: "primary", onTap: "noteSave" },
          ...(mine ? [{ type: "button", key: "noteDelete", label: "Borrar la nota", labelEn: "Delete the note", variant: "text", onTap: { event: "noteDel", arg: String(mine.p) } }] : []),
        ],
      }],
    },
  };
}

/** A new category: one box, then it is given to the book. */
function categoryScreen(s) {
  return {
    type: "Scaffold",
    onBack: "catBack",
    appBar: {
      type: "AppBar", key: "barCat", mergeWithKinoBar: true, dense: true, title: "Nueva categoría", titleEn: "New category",
      leading: { type: "IconButton", key: "backCat", icon: "arrow_back", labelText: "Volver", labelTextEn: "Back", onPressed: "catBack" },
    },
    body: {
      type: "Column", key: "catCol", padding: 16, gap: 12,
      children: [
        { type: "TextField", key: "cn", labelText: "Nombre de la categoría", labelTextEn: "Category name", maxLength: 24, onSubmitted: "catSave" },
        { type: "button", key: "catSave", label: "Guardar y usar", labelEn: "Save and use", variant: "primary", onTap: "catSave" },
      ],
    },
  };
}

export async function screen({ state }) {
  const s = state && typeof state === "object" ? state : {};
  if (s.view === "category" && s.target) return categoryScreen(s);
  if ((s.view === "read" || s.view === "toc" || s.view === "note") && s.key) {
    try {
      const { paras } = await parasNow(s.key);
      const book = pagesFor(paras, fontOf(s));
      if (s.view === "toc") return contents(s, book, paras, await marksOf(s.key), await notesOf(s.key));
      if (s.view === "note") return noteScreen(s, book, await notesOf(s.key));
      return reader(s, book, await marksOf(s.key), await notesOf(s.key));
    } catch (e) { return library({ ...s, view: "lib", error: message(e) }, await shelf()); }
  }
  const mine = await shelf();
  let fileList = [];
  if (s.tab === "files" && hasFiles()) { try { fileList = await kino.files.list({ kinds: ["book"] }); } catch { fileList = []; } }
  const covers = {};
  const places = {};
  const keys = [...(s.gb && s.gb.items ? s.gb.items.map((b) => "gb:" + b.id) : []), ...(Array.isArray(s.results) ? s.results : []).map((r) => "ia:" + r.id), ...mine.map((m) => m.key)];
  for (const k of keys) { const c = await kino.storage.get(coverKey(k)); if (typeof c === "string" && c) covers[k] = c; }
  for (const m of mine) places[m.key] = await placeOf(m.key);
  return library({ ...s, covers, places, fileList }, mine);
}

/** The keys older versions of this plugin kept (a book as one big value, a shelf and places of another shape) are dropped once. */
async function purgeOld() {
  for (const k of kino.storage.keys()) if (k === "shelf3" || k.startsWith("book3:") || k.startsWith("pos:")) await kino.storage.remove(k);
}

/** Opens book [key]: its text (got ready a step at a time, with a timer asking for the next step) and the place the person was at. */
async function openBook(s, key, title) {
  try {
    const got = (await parasOf(key)) || (await prepare(key));
    if (!got.paras) return { state: { ...s, view: "lib", error: "", prep: { key, title, pct: got.pct } } };
    await touchLibrary(key, title, got.paras.length, got.size);
    const fs = fontOf({ fs: Number(await kino.storage.get("fs")) || 0 });
    return { state: { ...s, view: "read", key, title, p: clamp(await placeOf(key), 0, got.paras.length - 1), fs, error: "", prep: null, askDrop: "" } };
  } catch (e) {
    return { state: { ...s, view: "lib", error: e && e.partial ? "" : message(e), prep: e && e.partial ? { key, title, text: message(e) } : null } };
  }
}

const titleOf = async (s, key) => {
  if (key.startsWith("lf:")) {
    try { return (await kino.files.info(key.slice(3))).name.replace(/\.[A-Za-z0-9]{2,5}$/, ""); } catch { return key; }
  }
  const gb = s.gb && s.gb.items ? s.gb.items.find((b) => "gb:" + b.id === key) : null;
  const ia = (Array.isArray(s.results) ? s.results : []).find((r) => "ia:" + r.id === key);
  const kept = (await shelf()).find((m) => m.key === key);
  return (gb && gb.title) || (ia && ia.title) || (kept && kept.title) || key;
};

export async function screenEvent(ev) {
  const out = await handle(ev);
  if (out && out.state) out.state.v = ((ev.state && ev.state.v) | 0) + 1; // fresh keys for the loading veil, so it never stays on
  return out;
}

/** Runs a Gutenberg query and puts what it says in the state's list; a failure is the state's error. */
async function gbList(s, q, lang, page) {
  try {
    const r = await gutenberg(q, lang, page);
    const items = page > 1 && s.gb && s.gb.items ? [...s.gb.items, ...r.items] : r.items;
    return { state: { ...s, error: "", gb: { q, lang, items, more: r.more, page } } };
  } catch (e) {
    return { state: { ...s, error: message(e), gb: { q, lang, items: s.gb && s.gb.items ? s.gb.items : [], more: false, page: 1 } } };
  }
}

/** The menu of a book: favourite, category, the saved text, delete. */
async function bookMenu(s, key) {
  const m = (await libraryMap())[key];
  const items = [];
  if (m) {
    items.push({ label: m.fav ? "Quitar de favoritos" : "Marcar como favorito", labelEn: m.fav ? "Remove from favourites" : "Make favourite", icon: "star", onTap: { event: "favToggle", arg: key } });
    items.push({ label: m.cat ? `Categoría: ${m.cat}` : "Poner categoría", labelEn: m.cat ? `Category: ${m.cat}` : "Set a category", icon: "list", onTap: { event: "catMenu", arg: key } });
    if (m.cached) items.push({ label: "Quitar el texto descargado", labelEn: "Remove the downloaded text", icon: "download", onTap: { event: "textDrop", arg: key } });
    items.push({ label: "Borrar de mi biblioteca", labelEn: "Delete from my library", icon: "delete", onTap: { event: "askDrop", arg: key } });
  }
  return items.length ? { state: s, menu: { title: m.title.slice(0, 40), items } } : null;
}

async function handle({ name, arg, value, state }) {
  const s = state && typeof state === "object" ? state : {};
  const inputs = s.inputs || {};
  if (name === "open") {
    await purgeOld();
    return s.gb ? null : gbList(s, "", "es", 1);
  }
  if (name === "lib") return { state: { ...s, view: "lib", error: "" } };
  if (name === "tab") return { state: { ...s, tab: TABS.includes(value) ? value : "gutenberg", error: "", askDrop: "" } };
  if (name === "cancel") {
    if (s.prep) await prepClear(s.prep.key);
    return { state: { ...s, error: "", prep: null } };
  }
  if (name === "prep") return s.prep ? openBook(s, s.prep.key, s.prep.title) : null;
  if (name === "openBook") {
    const key = String(arg || "");
    return BOOK_KEY.test(key) ? openBook(s, key, await titleOf(s, key)) : null;
  }
  // a book's menu: favourite, category, delete
  if (name === "bookMenu") return BOOK_KEY.test(String(arg)) ? bookMenu(s, String(arg)) : null;
  if (name === "favToggle" && BOOK_KEY.test(String(arg))) {
    const m = (await libraryMap())[String(arg)];
    if (m) await patchBook(String(arg), { fav: !m.fav });
    return { state: { ...s } };
  }
  if (name === "catMenu" && BOOK_KEY.test(String(arg))) {
    const key = String(arg);
    const list = await categories();
    const items = list.slice(0, 6).map((c) => ({ label: c, icon: "list", onTap: { event: "catSet", arg: key + "|" + c } }));
    if (list.length < MAX_CATS) items.push({ label: "Nueva categoría…", labelEn: "New category…", icon: "add", onTap: { event: "catNew", arg: key } });
    items.push({ label: "Sin categoría", labelEn: "No category", icon: "remove", onTap: { event: "catSet", arg: key + "|" } });
    return { state: s, menu: { title: "Categoría", titleEn: "Category", items: items.slice(0, 8) } };
  }
  if (name === "catSet") {
    const [key, cat] = String(arg || "").split("|");
    if (!BOOK_KEY.test(key)) return null;
    await patchBook(key, { cat: (cat || "").slice(0, 24) });
    return { state: { ...s } };
  }
  if (name === "catNew") return BOOK_KEY.test(String(arg)) ? { state: { ...s, view: "category", target: String(arg), back: s.view === "read" ? "read" : "lib" } } : null;
  if (name === "catBack") return { state: { ...s, view: s.back === "read" ? "read" : "lib", target: "" } };
  if (name === "catSave") {
    const text = String(value ?? inputs.cn ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!text || !s.target) return { state: { ...s, view: s.back === "read" ? "read" : "lib", target: "" } };
    const list = await categories();
    if (!list.includes(text) && list.length < MAX_CATS) await kino.storage.set(CATS, JSON.stringify([...list, text]));
    await patchBook(s.target, { cat: text });
    return { state: { ...s, view: s.back === "read" ? "read" : "lib", target: "" } };
  }
  if (name === "textDrop" && BOOK_KEY.test(String(arg))) { await dropText(String(arg)); return { state: { ...s } }; }
  if (name === "askDrop") return BOOK_KEY.test(String(arg)) ? { state: { ...s, view: "lib", askDrop: String(arg) } } : null;
  if (name === "dropYes") {
    const key = String(arg || "");
    if (!BOOK_KEY.test(key)) return null;
    await forget(key);
    return { state: { ...s, askDrop: "" } };
  }
  if (name === "dismiss") return { state: { ...s, askDrop: "" } };
  // files on this device (kino.files)
  if (name === "pickBook") {
    if (!hasFiles()) return { state: { ...s, error: "Tu Kino aún no puede abrir archivos del aparato (llega con la 0.9.82)." } };
    try {
      await kino.files.pick({ kinds: ["book"], multiple: true });
      return { state: { ...s, tab: "files", error: "" } };
    } catch (e) {
      return { state: { ...s, error: e && e.code === "unavailable" ? "Este aparato no tiene un selector de archivos." : message(e) } };
    }
  }
  if (name === "fileMenu" && BOOK_KEY.test(String(arg))) {
    return { state: s, menu: { title: "Archivo", titleEn: "File", items: [{ label: "Quitar de mis archivos (no se borra del aparato)", labelEn: "Remove from my files (it stays on the device)", icon: "delete", onTap: { event: "fileForget", arg: String(arg) } }] } };
  }
  if (name === "fileForget" && String(arg).startsWith("lf:")) {
    try { await kino.files.forget(String(arg).slice(3)); } catch { /* it was already gone */ }
    return { state: { ...s } };
  }
  if (name === "libFilter") return { state: { ...s, filter: String(value || "all") } };
  // Project Gutenberg's catalogue
  if (name === "gbSearch") return gbList(s, String(value ?? inputs.gq ?? "").trim(), (s.gb && s.gb.lang) || "es", 1);
  if (name === "gbLang") return gbList(s, (s.gb && s.gb.q) || "", ["es", "en", "all"].includes(value) ? value : "es", 1);
  if (name === "gbMore") return s.gb ? gbList(s, s.gb.q || "", s.gb.lang || "es", (s.gb.page | 0) + 1) : null;
  // archive.org
  if (name === "search") {
    const q = String(value ?? inputs.q ?? "").trim();
    if (q.length < 2) return { state: { ...s, error: "Escribe al menos dos letras para buscar" } };
    try {
      const res = await kino.fetch(searchUrl(q), { timeoutMs: 30000 });
      if (!res.ok) throw new Error(`archive.org no respondió (${res.status})`);
      return { state: { ...s, results: searchResults(res.json()), error: "" } };
    } catch (e) {
      return { state: { ...s, error: message(e) } };
    }
  }
  // reading
  if (!s.key || (s.view !== "read" && s.view !== "toc" && s.view !== "note")) return null;
  const { paras } = await parasNow(s.key);
  const fs = fontOf(s);
  const book = pagesFor(paras, fs);
  const moveTo = async (p) => {
    const at = clamp(Math.round(p), 0, paras.length - 1);
    await kino.storage.set(posKey(s.key), String(at));
    return { state: { ...s, view: "read", p: at } };
  };
  const pageSpan = () => spanOf(book.starts, pageOf(book.starts, s.p | 0));
  if (name === "nav" || name === "jump") {
    const page = pageOf(book.starts, s.p | 0);
    const a = String(arg ?? "");
    const to = name === "jump" ? Number(value) || 0 : a === "next" ? page + 1 : a === "prev" ? page - 1 : Number(a) || 0;
    return moveTo(book.starts[clamp(Math.round(to), 0, book.starts.length - 1)]);
  }
  if (name === "font") {
    const next = clamp(fs + (Number(arg) || 0), 0, SIZES.length - 1);
    await kino.storage.set("fs", String(next));
    return { state: { ...s, fs: next } };
  }
  if (name === "mark") {
    const [from, to] = pageSpan();
    const marks = await marksOf(s.key);
    const kept = marks.filter((m) => m.p < from || m.p >= to);
    if (kept.length === marks.length) kept.push({ p: from, t: book.pages[pageOf(book.starts, from)].split("\n\n")[0].replace(HEADING, "").slice(0, 70) });
    await kino.storage.set(bmKey(s.key), JSON.stringify(kept.slice(0, MAX_MARKS)));
    return { state: { ...s } };
  }
  if (name === "markDel") {
    await kino.storage.set(bmKey(s.key), JSON.stringify((await marksOf(s.key)).filter((m) => m.p !== Number(arg))));
    return { state: { ...s } };
  }
  if (name === "noteOpen") return { state: { ...s, view: "note" } };
  if (name === "closeNote") return { state: { ...s, view: "read" } };
  if (name === "noteSave") {
    const text = String(value ?? inputs.nt ?? "").trim().slice(0, NOTE_CHARS);
    const [from, to] = pageSpan();
    const kept = (await notesOf(s.key)).filter((m) => m.p < from || m.p >= to);
    if (text) kept.push({ p: from, t: text });
    await kino.storage.set(noteKey(s.key), JSON.stringify(kept.slice(0, MAX_NOTES)));
    return { state: { ...s, view: "read" } };
  }
  if (name === "noteDel") {
    await kino.storage.set(noteKey(s.key), JSON.stringify((await notesOf(s.key)).filter((m) => m.p !== Number(arg))));
    return { state: { ...s, view: s.view === "note" ? "read" : s.view } };
  }
  if (name === "toc") return { state: { ...s, view: "toc", tocTab: "chapters", found: null } };
  if (name === "closeToc") return { state: { ...s, view: "read" } };
  if (name === "tocTab") return { state: { ...s, tocTab: TOC_TABS.includes(value) ? value : "chapters" } };
  if (name === "find") return { state: { ...s, found: findInBook(paras, String(value ?? inputs.fq ?? "")) } };
  if (name === "goP") return moveTo(Number(arg) || 0);
  return null;
}
