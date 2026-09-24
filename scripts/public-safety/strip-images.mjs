#!/usr/bin/env node

/*
 * Removes metadata from images in place, without re-encoding them:
 *
 *   node scripts/public-safety/strip-images.mjs docs/screenshot.png [...]
 *
 * PNG text, EXIF, time and ICC-profile chunks and JPEG EXIF, XMP, IPTC and
 * comment segments are dropped; the pixel data is copied byte for byte (see
 * images.js). It prints what it removed from each file and leaves clean files
 * untouched.
 */

import fs from "node:fs";
import { inspect, strip } from "./images.js";

const files = process.argv.slice(2);
if (!files.length) {
  process.stderr.write("usage: node scripts/public-safety/strip-images.mjs <image> [...]\n");
  process.exit(2);
}
let failed = false;
for (const file of files) {
  try {
    const before = fs.readFileSync(file);
    const { findings } = inspect(before);
    if (!findings.length) { process.stdout.write(`${file}: clean\n`); continue; }
    const after = strip(before);
    if (inspect(after).findings.length) throw new Error("metadata remained after stripping");
    fs.writeFileSync(file, after);
    process.stdout.write(`${file}: removed ${findings.map((f) => f.kind).join(", ")} (${before.length - after.length} bytes)\n`);
  } catch (error) {
    failed = true;
    process.stderr.write(`${file}: ${error.message}\n`);
  }
}
process.exitCode = failed ? 1 : 0;
