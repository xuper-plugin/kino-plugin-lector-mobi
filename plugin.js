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
export const BOOKS = [
  { id: "320", title: "Lazarillo de Tormes", author: "Anónimo", lang: "es" },
  { id: "11", title: "Alice's Adventures in Wonderland", author: "Lewis Carroll", lang: "en" },
  { id: "1342", title: "Pride and Prejudice", author: "Jane Austen", lang: "en" },
];

/** About how many characters one page holds: what fits a TV screen without scrolling, and a phone reads comfortably. */
export const PAGE_CHARS = 650;
const PAGE_SEP = "\u0002";
const HEADING = "\u0001";
/** Whatever the book, never more than this many characters of text are kept (a runaway file cannot fill the storage). */
const MAX_TEXT = 3_000_000;
/** The biggest file read: it is downloaded in pieces (kino.fetch answers at most 5 MB at once) and kept as base64 in the 16 MB storage meanwhile. */
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

/** An .epub file's bytes to `{ title, html }`: the spine's XHTML files, in reading order, joined. */
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
  for (const m of opf.match(/<item\b[^>]*>/gi) || []) items.set(attr(m, "id"), { href: attr(m, "href"), type: attr(m, "media-type") });
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
  return { title, html: parts.join("\n") };
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
export function paragraphs(html) {
  let s = html.replace(/<head[\s\S]*?<\/head>/gi, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  // The file's own line breaks are only its source wrapping (an EPUB is cut at 80 columns): paragraphs come from the tags.
  s = s.replace(/\s+/g, " ");
  s = s.replace(/<h[1-3][^>]*>/gi, "\n" + HEADING).replace(/<\/h[1-6]>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|blockquote)>|<br\s*\/?>|<mbp:pagebreak\s*\/?>|<p\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : "";
    }
    return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
  const lines = s.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 0 && l !== HEADING);
  // A Project Gutenberg file wraps the book in a licence: start at the book, end with it.
  const first = lines.findIndex((l) => l.includes("*** START OF"));
  const last = lines.findIndex((l) => l.includes("*** END OF"));
  const from = first >= 0 ? first + 1 : 0;
  const to = last > from ? last : lines.length;
  return lines.slice(from, to);
}

/** Paragraphs cut into pages of about [limit] characters; a long paragraph is cut at a sentence end. Each page is a string; paragraphs are split by a blank line. */
export function paginate(paras, limit = PAGE_CHARS) {
  const pieces = [];
  for (const p of paras) {
    if (p.length <= limit || p[0] === HEADING) { pieces.push(p); continue; }
    let rest = p;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(". ", limit);
      if (cut < limit / 3) cut = rest.lastIndexOf(" ", limit);
      if (cut < limit / 3) cut = limit;
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) pieces.push(rest);
  }
  const pages = [];
  let cur = [];
  let len = 0;
  for (const p of pieces) {
    if (len > 0 && len + p.length > limit) { pages.push(cur.join("\n\n")); cur = []; len = 0; }
    cur.push(p);
    len += p.length;
  }
  if (cur.length) pages.push(cur.join("\n\n"));
  return pages;
}

// ---------------------------------------------------------------- where books come from

/** The archive.org search URL for what the person typed (a title or an author, any language), only items with EPUB or Kindle. */
export function searchUrl(q) {
  const clean = String(q).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const query = `(${clean}) AND mediatype:texts AND (format:EPUB OR format:Kindle)`;
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
  const ok = (f) => !/_lcp\./i.test(f.name) && Number(f.size) <= MAX_FILE;
  const epubs = files.filter((f) => f.format === "EPUB" && /\.epub$/i.test(f.name) && !/_lcp\./i.test(f.name));
  // An item with many EPUBs is a collection, not a book: there is no telling which one the person wants.
  if (epubs.length > 3) throw new Error("Este elemento es una colección de muchos libros: prueba con otro resultado");
  const epub = epubs.find(ok);
  if (epub) return epub;
  const mobi = files.find((f) => f.format === "Kindle" && /\.mobi$/i.test(f.name) && ok(f));
  if (mobi) return mobi;
  const tooBig = files.find((f) => (f.format === "EPUB" || f.format === "Kindle") && !/_lcp\./i.test(f.name));
  throw new Error(tooBig ? `El libro pesa ${(Number(tooBig.size) / 1e6).toFixed(1)} MB: es demasiado grande para este lector` : "Este libro no tiene EPUB ni Kindle sin DRM");
}

const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");

/** The bytes of book [key] ("gb:<number>" or "ia:<identifier>"). */
async function download(key) {
  if (key.startsWith("gb:")) {
    const res = await kino.fetch(`${GUTENBERG}/ebooks/${encodeURIComponent(key.slice(3))}.kindle.noimages`, { timeoutMs: 30000 });
    if (!res.ok) throw new Error(`No se pudo descargar el libro (${res.status})`);
    return b64decode(res.base64());
  }
  const id = key.slice(3);
  const meta = await kino.fetch(`${ARCHIVE}/metadata/${encodeURIComponent(id)}`, { timeoutMs: 30000 });
  if (!meta.ok) throw new Error(`No se pudo consultar archive.org (${meta.status})`);
  const file = pickFile(meta.json());
  return downloadPieces(`${ARCHIVE}/download/${encodeURIComponent(id)}/${encPath(file.name)}`, key);
}

/**
 * A big file in pieces (HTTP Range), each kept in the storage as it arrives, so a tap that runs out of time loses nothing:
 * the next tap goes on from the piece it stopped at. Throws an Error with `partial` set while the file is not complete.
 */
async function downloadPieces(url, key) {
  const metaKey = "dl:" + key;
  let meta = { total: 0, got: 0, n: 0 };
  try { meta = { ...meta, ...JSON.parse((await kino.storage.get(metaKey)) || "{}") }; } catch { /* a fresh start */ }
  const started = Date.now();
  while (meta.total === 0 || meta.got < meta.total) {
    if (Date.now() - started > DOWNLOAD_BUDGET_MS) {
      const pct = meta.total ? Math.round((meta.got / meta.total) * 100) : 0;
      throw Object.assign(new Error(`Descargando… ${pct} % (${(meta.got / 1e6).toFixed(1)} de ${(meta.total / 1e6).toFixed(1)} MB). Toca «Leer» otra vez para continuar.`), { partial: true });
    }
    const res = await kino.fetch(url, { headers: { Range: `bytes=${meta.got}-${meta.got + CHUNK - 1}` }, timeoutMs: 30000 });
    let bytesB64 = res.base64();
    let total;
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers["content-range"] || "");
      if (!m) throw new Error("archive.org no dijo el tamaño del libro");
      total = Number(m[1]);
    } else if (res.status === 200 && meta.got === 0) {
      total = b64decode(bytesB64).length; // the server ignored Range and sent it all
    } else {
      throw new Error(`No se pudo descargar el libro (${res.status})`);
    }
    if (total > MAX_FILE) {
      await clearPieces(key, meta);
      throw new Error(`El libro pesa ${(total / 1e6).toFixed(1)} MB: es demasiado grande para este lector (máximo ${(MAX_FILE / 1e6).toFixed(0)} MB)`);
    }
    const got = meta.got + b64decode(bytesB64).length;
    await kino.storage.set(`part:${key}:${meta.n}`, bytesB64);
    bytesB64 = "";
    meta = { total, got, n: meta.n + 1 };
    await kino.storage.set(metaKey, JSON.stringify(meta));
  }
  const all = new Uint8Array(meta.total);
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

// ---------------------------------------------------------------- the library (download, keep, read)

const bookKey = (key) => "book3:" + key;
const posKey = (key) => "pos:" + key;
const SHELF = "shelf3";

async function shelf() {
  try { const s = JSON.parse((await kino.storage.get(SHELF)) || "[]"); return Array.isArray(s) ? s.filter((x) => x && x.id && x.title) : []; } catch { return []; }
}

/** The pages of book [key], from the storage or downloaded and read now. */
async function pagesOf(key, title) {
  const kept = await kino.storage.get(bookKey(key));
  if (typeof kept === "string" && kept.length > 0) return kept.split(PAGE_SEP);
  const { html } = parseBook(await download(key));
  const pages = paginate(paragraphs(html));
  if (pages.length === 0) throw new Error("El libro no tiene texto");
  await kino.storage.set(bookKey(key), pages.join(PAGE_SEP));
  if (key.startsWith("ia:")) {
    const rest = (await shelf()).filter((x) => x.id !== key.slice(3));
    rest.unshift({ id: key.slice(3), title: title || key.slice(3) });
    for (const old of rest.splice(MAX_SHELF)) { await kino.storage.remove(bookKey("ia:" + old.id)); await kino.storage.remove(posKey("ia:" + old.id)); }
    await kino.storage.set(SHELF, JSON.stringify(rest));
  }
  return pages;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const message = (e) => String(e && e.message ? e.message : e);

// ---------------------------------------------------------------- the screen

const TABS = ["gutenberg", "archive", "mine"];
const busy = (v) => [{ show: "loading" + v }, { hide: "content" + v }];

const cover = (arg, icon) => ({
  type: "Image", key: "cv" + arg, width: 48, aspect: "2:3", fit: "cover", alt: "Portada", altEn: "Cover",
  url: /^\d+$/.test(arg) ? `${GUTENBERG}/cache/epub/${arg}/pg${arg}.cover.medium.jpg` : `${ARCHIVE}/services/img/${encodeURIComponent(arg)}`,
  fallback: { type: "Icon", name: icon },
});

const tile = (v, key, title, subtitle, icon, onTap, arg) => ({
  type: "ListTile", key, title, titleEn: title, subtitle: subtitle || undefined, subtitleEn: subtitle || undefined,
  leading: cover(arg, icon), onTap: { ui: busy(v), event: onTap, arg },
});

const skeleton = (v) => ({
  type: "Column", key: "loading" + v, hidden: true, padding: 16, gap: 12,
  children: [0, 1, 2].map((i) => ({ type: "Skeleton", key: "sk" + i, shape: "line", lines: 2 })),
});

function gutenbergTab(s) {
  return BOOKS.map((b) => tile(s.v | 0, "gb" + b.id, b.title, `${b.author} · ${b.lang === "es" ? "español" : "inglés"}`,
    s.pos && s.pos["gb:" + b.id] ? "check" : "bookmark", "openGb", b.id));
}

function archiveTab(s) {
  const results = Array.isArray(s.results) ? s.results : null;
  return [
    {
      type: "Column", key: "searchBox", padding: 16,
      children: [{
        type: "TextField", key: "q", kind: "search", labelText: "Buscar en archive.org", labelTextEn: "Search archive.org",
        hintText: "Título o autor", hintTextEn: "Title or author", onSubmitted: { ui: busy(s.v | 0), event: "search" },
        trailingIcon: "search", trailingLabel: "Buscar", trailingLabelEn: "Search", onTrailingTap: { ui: busy(s.v | 0), event: "search" },
      }],
    },
    ...(results === null
      ? [{ type: "emptyState", key: "hint", icon: "search", title: "Busca un libro", titleEn: "Find a book", text: "Solo salen los que tienen EPUB o Kindle.", textEn: "Only books with an EPUB or Kindle file show up." }]
      : results.length === 0
        ? [{ type: "emptyState", key: "none", icon: "search", title: "Sin resultados", titleEn: "No results", text: "Prueba con otra palabra.", textEn: "Try another word." }]
        : results.map((r) => tile(s.v | 0, "ia" + r.id, r.title, r.author, "bookmark", "openIa", r.id))),
  ];
}

function mineTab(s, mine) {
  const read = BOOKS.filter((b) => s.pos && s.pos["gb:" + b.id]).map((b) => tile(s.v | 0, "mg" + b.id, b.title, b.author, "check", "openGb", b.id));
  const rows = [...read, ...mine.map((m) => tile(s.v | 0, "mi" + m.id, m.title, "archive.org", "bookmark", "openIa", m.id))];
  return rows.length ? rows : [{ type: "emptyState", key: "nomine", icon: "bookmark", title: "Aún no has leído nada", titleEn: "Nothing read yet", text: "Los libros que abras quedan aquí, en la página donde los dejaste.", textEn: "Books you open stay here, on the page you left them." }];
}

function library(s, mine) {
  const tab = TABS.includes(s.tab) ? s.tab : "gutenberg";
  const rows = tab === "gutenberg" ? gutenbergTab(s) : tab === "archive" ? archiveTab(s) : mineTab(s, mine);
  const notes = [];
  if (s.error) {
    notes.push({
      type: "MaterialBanner", key: "err", role: s.resume ? "info" : "error", text: s.error, textEn: s.error,
      action: s.resume ? { label: "Cancelar", labelEn: "Cancel", onTap: "cancel" } : undefined,
    });
  }
  return {
    type: "Scaffold",
    every: s.resume ? { ms: 1500, event: "resume" } : undefined,
    appBar: {
      type: "AppBar", key: "barLib", mergeWithKinoBar: true, dense: true,
      leading: { type: "IconButton", key: "closeLib", icon: "close", labelText: "Cerrar", labelTextEn: "Close", onPressed: { close: true } },
      title: {
        type: "TabBar", key: "tabs", value: tab, onChanged: "tab", tabs: [
          { value: "gutenberg", label: "Gutenberg", labelEn: "Gutenberg" },
          { value: "archive", label: "archive.org", labelEn: "archive.org" },
          { value: "mine", label: "Mis libros", labelEn: "My books" },
        ],
      },
    },
    body: {
      type: "SingleChildScrollView", key: "libScroll",
      children: [{ type: "Column", key: "libCol", children: [...notes, skeleton(s.v | 0), { type: "Column", key: "content" + (s.v | 0), children: rows }] }],
    },
  };
}

const SIZES = ["p", "h4", "h3"];
const fontOf = (s) => clamp(Number.isInteger(s.fs) ? s.fs : 0, 0, SIZES.length - 1);

function reader(s, pages) {
  const last = pages.length - 1;
  const page = clamp(s.page | 0, 0, last);
  const blocks = pages[page].split("\n\n").map((p, i) =>
    p[0] === HEADING
      ? { type: "text", key: "para" + i, text: p.slice(1), textEn: p.slice(1), style: "h2" }
      : { type: "text", key: "para" + i, text: p, textEn: p, style: SIZES[fontOf(s)] });
  const pct = last > 0 ? Math.round((page / last) * 100) : 100;
  const step = (key, icon, label, labelEn, arg, off) => ({ type: "IconButton", key, icon, labelText: label, labelTextEn: labelEn, onPressed: { event: "nav", arg }, enabled: !off });
  return {
    type: "Scaffold",
    onBack: "lib",
    appBar: {
      type: "AppBar", key: "barRead", mergeWithKinoBar: true, dense: true,
      title: s.title || "Libro", titleEn: s.title || "Book",
      leading: { type: "IconButton", key: "backRead", icon: "arrow_back", labelText: "Biblioteca", labelTextEn: "Library", onPressed: "lib" },
      actions: [
        { type: "IconButton", key: "fontDown", icon: "remove", labelText: "Letra más pequeña", labelTextEn: "Smaller text", onPressed: { event: "font", arg: "-1" }, enabled: fontOf(s) > 0 },
        { type: "IconButton", key: "fontUp", icon: "add", labelText: "Letra más grande", labelTextEn: "Larger text", onPressed: { event: "font", arg: "1" }, enabled: fontOf(s) < SIZES.length - 1 },
        { type: "IconButton", key: "toStart", icon: "home", labelText: "Al inicio", labelTextEn: "To the start", onPressed: { event: "nav", arg: "0" } },
      ],
    },
    body: {
      type: "Column", key: "readBody", fill: true,
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
              type: "Row", key: "steps", mainAxisAlignment: "center", gap: 24,
              children: [
                step("prev", "arrow_back", "Página anterior", "Previous page", "prev", page === 0),
                step("next", "arrow_forward", "Página siguiente", "Next page", "next", page === last),
              ],
            },
          ],
        },
      ],
    },
  };
}

export async function screen({ state }) {
  const s = state && typeof state === "object" ? state : {};
  if (s.view === "read" && s.key) {
    try { return reader(s, await pagesOf(s.key, s.title)); } catch (e) { return library({ ...s, view: "lib", error: message(e) }, await shelf()); }
  }
  return library(s, await shelf());
}

/** Opens book [key]: its pages (downloaded now if need be) and the page the person was on. A half download goes on by itself. */
async function open(s, key, title, ev, arg) {
  try {
    const pages = await pagesOf(key, title);
    const saved = Number(await kino.storage.get(posKey(key))) || 0;
    return { state: { ...s, view: "read", key, title, page: clamp(saved, 0, pages.length - 1), fs: fontOf({ fs: Number(await kino.storage.get("fs")) || 0 }), pos: { ...(s.pos || {}), [key]: true }, error: "", resume: null } };
  } catch (e) {
    return { state: { ...s, view: "lib", error: message(e), resume: e && e.partial ? { ev, arg } : null } };
  }
}

export async function screenEvent(ev) {
  const out = await handle(ev);
  if (out && out.state) out.state.v = ((ev.state && ev.state.v) | 0) + 1; // fresh keys for the loading veil, so it never stays on
  return out;
}

async function handle({ name, arg, value, state }) {
  const s = state && typeof state === "object" ? state : {};
  if (name === "lib") return { state: { ...s, view: "lib", error: "", resume: null } };
  if (name === "tab") return { state: { ...s, tab: TABS.includes(value) ? value : "gutenberg", error: "", resume: null } };
  if (name === "font") {
    const fs = clamp(fontOf(s) + (Number(arg) || 0), 0, SIZES.length - 1);
    await kino.storage.set("fs", String(fs));
    return { state: { ...s, fs } };
  }
  if (name === "cancel") return { state: { ...s, error: "", resume: null } };
  if (name === "resume") {
    return s.resume ? handle({ name: s.resume.ev, arg: s.resume.arg, state: { ...s, resume: null } }) : null;
  }
  if (name === "openGb") {
    const b = BOOKS.find((x) => x.id === String(arg));
    return b ? open(s, "gb:" + b.id, b.title, "openGb", b.id) : null;
  }
  if (name === "openIa") {
    const id = String(arg || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(id)) return null;
    const known = (Array.isArray(s.results) ? s.results : []).find((r) => r.id === id) || (await shelf()).find((r) => r.id === id);
    return open(s, "ia:" + id, known ? known.title : id, "openIa", id);
  }
  if (name === "search") {
    const q = String(value ?? (s.inputs && s.inputs.q) ?? "").trim();
    if (q.length < 2) return { state: { ...s, error: "Escribe al menos dos letras para buscar" } };
    try {
      const res = await kino.fetch(searchUrl(q), { timeoutMs: 30000 });
      if (!res.ok) throw new Error(`archive.org no respondió (${res.status})`);
      return { state: { ...s, results: searchResults(res.json()), error: "" } };
    } catch (e) {
      return { state: { ...s, error: message(e) } };
    }
  }
  if ((name === "nav" || name === "jump") && s.view === "read" && s.key) {
    const pages = await pagesOf(s.key, s.title);
    const here = clamp(s.page | 0, 0, pages.length - 1);
    const a = String(arg ?? "");
    const to = name === "jump" ? Number(value) || 0 : a === "next" ? here + 1 : a === "prev" ? here - 1 : Number(a) || 0;
    const page = clamp(Math.round(to), 0, pages.length - 1);
    await kino.storage.set(posKey(s.key), String(page));
    return { state: { ...s, page } };
  }
  return null;
}
