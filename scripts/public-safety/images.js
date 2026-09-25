/**
 * Image metadata: find it, and strip it without re-encoding a pixel.
 *
 * A screenshot can carry more than its pixels: EXIF (camera, software, the
 * time it was taken), XMP (the editing history, often with a file path), PNG
 * text chunks (a tool's name, a user comment, the path it was exported from),
 * an embedded colour profile named after the display it came from. None of
 * that should reach a public repository. Every image has to pass `inspect`
 * with no findings; `strip` removes exactly what `inspect` reports, keeping
 * the image data byte for byte.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/*
 * PNG chunks that hold pixels or how to draw them. Everything else, text,
 * EXIF, timestamps and embedded ICC profiles included, is metadata. sRGB,
 * gAMA and cHRM say how to colour the pixels and carry no text.
 */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "sRGB", "gAMA", "cHRM", "sBIT", "pHYs", "bKGD", "acTL", "fcTL", "fdAT"]);

/* JPEG: APP0 (JFIF) and APP14 (Adobe colour transform) describe decoding; the rest is metadata. */
const JPEG_KEEP_APP = new Set([0xe0, 0xee]);

/** Which format the bytes are, by signature, not by name. */
export function formatOf(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/u.test(buf.subarray(0, 6).toString("latin1"))) return "gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

function pngChunks(buf) {
  const chunks = [];
  let at = 8;
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString("latin1");
    const end = at + 12 + length;
    if (end > buf.length) throw new Error(`truncated PNG chunk ${type}`);
    chunks.push({ type, start: at, end, data: buf.subarray(at + 8, at + 8 + length) });
    at = end;
    if (type === "IEND") break;
  }
  if (at < buf.length) chunks.push({ type: "(trailing bytes)", start: at, end: buf.length, data: buf.subarray(at) });
  return chunks;
}

/** A short, printable description of what a metadata chunk holds, for the report. */
function pngDetail(chunk) {
  try {
    if (chunk.type === "tEXt") return chunk.data.toString("latin1").split("\0")[0];
    if (chunk.type === "zTXt" || chunk.type === "iTXt" || chunk.type === "iCCP") return chunk.data.toString("latin1").split("\0")[0];
  } catch { /* the type alone is enough */ }
  return "";
}

function jpegSegments(buf) {
  const segments = [];
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) throw new Error("malformed JPEG marker");
    const marker = buf[at + 1];
    if (marker === 0xd9) { segments.push({ marker, start: at, end: at + 2 }); at += 2; break; }
    if (marker === 0xda) { segments.push({ marker, start: at, end: buf.length, scan: true }); at = buf.length; break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = buf.readUInt16BE(at + 2);
    segments.push({ marker, start: at, end: at + 2 + length, data: buf.subarray(at + 4, at + 2 + length) });
    at += 2 + length;
  }
  return segments;
}

function gifFindings(buf) {
  const found = [];
  // Walk GIF blocks: compressed image data can contain the same bytes as an
  // extension introducer, and scanning every byte flags clean animations.
  if (buf.length < 13) return found;
  let at = 13;
  if (buf[10] & 0x80) at += 3 * (1 << ((buf[10] & 7) + 1));
  const skipSubblocks = () => {
    while (at < buf.length) {
      const size = buf[at++];
      if (!size) break;
      at += size;
    }
  };
  while (at < buf.length) {
    const block = buf[at++];
    if (block === 0x3b) break; // trailer
    if (block === 0x2c) { // image descriptor, local palette, LZW data
      if (at + 9 > buf.length) break;
      const packed = buf[at + 8];
      at += 9;
      if (packed & 0x80) at += 3 * (1 << ((packed & 7) + 1));
      at++; // LZW minimum code size
      skipSubblocks();
      continue;
    }
    if (block !== 0x21 || at >= buf.length) break;
    const label = buf[at++];
    const size = buf[at++];
    if (label === 0xfe) found.push({ kind: "GIF comment", detail: "" });
    if (label === 0xff) {
      const id = buf.subarray(at, at + size).toString("latin1");
      if (!/^(NETSCAPE2\.0|ANIMEXTS1\.0)$/u.test(id)) found.push({ kind: "GIF application data", detail: id });
    }
    at += size;
    skipSubblocks();
  }
  return found;
}

function webpFindings(buf) {
  const found = [];
  for (let at = 12; at + 8 <= buf.length;) {
    const type = buf.subarray(at, at + 4).toString("latin1");
    const size = buf.readUInt32LE(at + 4);
    if (type === "EXIF" || type === "XMP " || type === "ICCP") found.push({ kind: `WebP ${type.trim()} chunk`, detail: "" });
    at += 8 + size + (size % 2);
  }
  return found;
}

/**
 * What metadata an image carries. An empty list means it is clean.
 * @param {Buffer} buf
 * @returns {{format: string|null, findings: {kind: string, detail: string}[]}}
 */
export function inspect(buf) {
  const format = formatOf(buf);
  const findings = [];
  if (format === "png") {
    for (const chunk of pngChunks(buf)) if (!PNG_KEEP.has(chunk.type)) findings.push({ kind: `PNG ${chunk.type} chunk`, detail: pngDetail(chunk) });
  } else if (format === "jpeg") {
    for (const s of jpegSegments(buf)) {
      if (s.marker === 0xfe) findings.push({ kind: "JPEG comment", detail: "" });
      else if (s.marker >= 0xe0 && s.marker <= 0xef && !JPEG_KEEP_APP.has(s.marker)) {
        const id = s.data ? s.data.subarray(0, 12).toString("latin1").split("\0")[0] : "";
        findings.push({ kind: `JPEG APP${s.marker - 0xe0} segment`, detail: id });
      }
    }
  } else if (format === "gif") {
    findings.push(...gifFindings(buf));
  } else if (format === "webp") {
    findings.push(...webpFindings(buf));
  }
  return { format, findings };
}

/**
 * The same image without its metadata: PNG and JPEG only (the formats this
 * repository ships). Pixel data is copied unchanged.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function strip(buf) {
  const format = formatOf(buf);
  if (format === "png") {
    const kept = [PNG_SIGNATURE];
    let hadProfile = false, hasSrgb = false;
    for (const chunk of pngChunks(buf)) {
      if (chunk.type === "iCCP") hadProfile = true;
      if (chunk.type === "sRGB") hasSrgb = true;
      if (PNG_KEEP.has(chunk.type)) {
        // An image that relied on an embedded profile is marked sRGB instead,
        // just before its first IDAT, so browsers still colour it as intended.
        if (chunk.type === "IDAT" && hadProfile && !hasSrgb) { kept.push(srgbChunk()); hasSrgb = true; }
        kept.push(buf.subarray(chunk.start, chunk.end));
      }
    }
    return Buffer.concat(kept);
  }
  if (format === "jpeg") {
    const kept = [buf.subarray(0, 2)];
    for (const s of jpegSegments(buf)) {
      if (s.marker === 0xfe || (s.marker >= 0xe0 && s.marker <= 0xef && !JPEG_KEEP_APP.has(s.marker))) continue;
      kept.push(buf.subarray(s.start, s.end));
    }
    return Buffer.concat(kept);
  }
  throw new Error(`cannot strip ${format || "an unrecognised format"}; convert it to PNG`);
}

function srgbChunk() {
  const body = Buffer.from([0x73, 0x52, 0x47, 0x42, 0x00]); // "sRGB", perceptual
  const out = Buffer.alloc(4 + body.length + 4);
  out.writeUInt32BE(1, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

let table;
function crc32(bytes) {
  table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|heic|tiff?|bmp|ico)$/iu;
