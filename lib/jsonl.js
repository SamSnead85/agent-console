/**
 * Incremental JSONL tail reader.
 *
 * Transcripts are append-only and large (the Claude tree here is >2 GB), so a
 * scan reads only the bytes appended since the previous pass. Two properties
 * matter and are both tested:
 *
 *  1. A half-written trailing line is never consumed. The read offset advances
 *     by bytes read, but only text up to the final newline is emitted; the tail
 *     is carried into the next pass.
 *
 *  2. Multi-byte characters survive the read-buffer boundary. Decoding each
 *     4 MiB chunk independently splits any UTF-8 sequence that straddles the
 *     boundary into two U+FFFD replacement characters — measured on this
 *     machine at byte offset 20,971,520 of a real 28.7 MB transcript, where an
 *     EN DASH was being rendered as two question marks. A persistent
 *     StringDecoder holds the orphaned bytes instead.
 */

import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";

const CHUNK = 4 * 1024 * 1024;
const SHARED = Buffer.allocUnsafe(CHUNK);

/** Milliseconds a file must be untouched before an un-terminated final line is emitted. */
const IDLE_FLUSH_MS = 30_000;

export function createReadState(filePath, extra) {
  return Object.assign(
    {
      path: filePath,
      offset: 0,
      leftover: "",
      decoder: new StringDecoder("utf8"),
      mtime: 0,
      size: 0,
      bad: 0,
    },
    extra || {},
  );
}

/**
 * Read every complete line appended since the last call.
 *
 * `onLine` may be invoked more than once for the same physical line when a file
 * goes idle without a trailing newline (see IDLE_FLUSH_MS). Every consumer in
 * this program keys on a stable id and is idempotent, which is what makes that
 * flush safe: the alternative is stranding a session's final line forever.
 */
export function readNewLines(state, onLine, now) {
  let st;
  try {
    st = fs.statSync(state.path);
  } catch {
    return false;
  }
  state.mtime = st.mtimeMs;
  state.size = st.size;

  if (st.size < state.offset) {
    // Truncated or replaced. Start over; a stale decoder would corrupt the head.
    state.offset = 0;
    state.leftover = "";
    state.decoder = new StringDecoder("utf8");
  }

  if (st.size > state.offset) {
    let fd;
    try {
      fd = fs.openSync(state.path, "r");
    } catch {
      return false;
    }
    try {
      while (state.offset < st.size) {
        const want = Math.min(CHUNK, st.size - state.offset);
        const got = fs.readSync(fd, SHARED, 0, want, state.offset);
        if (got <= 0) break;
        state.offset += got;
        const chunk =
          state.leftover + state.decoder.write(SHARED.subarray(0, got));
        const nl = chunk.lastIndexOf("\n");
        if (nl === -1) {
          state.leftover = chunk;
          continue;
        }
        state.leftover = chunk.slice(nl + 1);
        emitLines(chunk.slice(0, nl), onLine);
      }
    } catch {
      // Partial progress is retained; the next pass resumes from the offset.
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }

  // A file whose last line has no terminating newline would otherwise strand
  // that line permanently. Once the file has gone quiet, emit it.
  const clock = now === undefined ? Date.now() : now;
  if (state.leftover && clock - st.mtimeMs > IDLE_FLUSH_MS) {
    onLine(state.leftover);
  }
  return true;
}

function emitLines(block, onLine) {
  let start = 0;
  while (start <= block.length) {
    let end = block.indexOf("\n", start);
    if (end === -1) end = block.length;
    if (end > start) onLine(block.slice(start, end));
    start = end + 1;
  }
}

/** Parse a line, counting rather than throwing on the malformed ones. */
export function parseLine(state, line) {
  try {
    return JSON.parse(line);
  } catch {
    state.bad += 1;
    return null;
  }
}
