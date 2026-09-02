/**
 * Project progress — read from the orchestrator, never computed here.
 *
 * The orchestrator (single writer) maintains
 * ~/.muster-console/progress.json (or the reused legacy history directory):
 *
 *   { "percent": 0-100, "summary": "<one line>",
 *     "remaining": ["<short item>", ...], "updatedAt": "<ISO>" }
 *
 * This dashboard only READS it — no GitHub call, no inference. A missing or
 * malformed file makes the widget ABSENT, with the reason recorded: a
 * fabricated 0% reads as "nothing done" and a fabricated 100% as "ship it",
 * and both are worse than no widget. The same goes for a record with no
 * usable timestamp — a progress claim whose age cannot be checked cannot be
 * trusted, so it is refused rather than shown fresh.
 *
 * Staleness is called out, not hidden: past STALE_MS the widget carries
 * "last updated Xm ago", because the orchestrator writes every merge round
 * and a quiet half hour means the number on screen is history, not status.
 */

import fs from "node:fs";
import path from "node:path";
import { redactAndClip } from "./redact.js";

export const PROGRESS_FILE = "progress.json";
export const STALE_MS = 30 * 60_000;
const MAX_REMAINING = 12;
const LINE_MAX = 160;

function absent(reason) {
  return { available: false, reason };
}

/**
 * @param {string} dir the dashboard's own data directory (config.historyDir)
 * @param {number} now epoch milliseconds
 */
export function readProgress(dir, now) {
  if (!dir) return absent("no data directory configured");
  const file = path.join(dir, PROGRESS_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return absent(
      error && error.code === "ENOENT"
        ? "no progress file"
        : "progress file unreadable: " + ((error && error.code) || "error"),
    );
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return absent("progress file is not JSON");
  }
  if (!d || typeof d !== "object")
    return absent("progress file is not an object");

  // Percent must BE a number in range. Clamping an out-of-range value would
  // fabricate the exact figures this widget must never invent.
  const percent = d.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return absent("percent is not a number");
  }
  if (percent < 0 || percent > 100) {
    return absent("percent is out of range (0-100)");
  }
  if (typeof d.summary !== "string" || !d.summary.trim()) {
    return absent("summary is missing");
  }
  const updatedAt =
    typeof d.updatedAt === "string" ? Date.parse(d.updatedAt) : NaN;
  if (!Number.isFinite(updatedAt)) {
    return absent("updatedAt is missing or unparseable");
  }
  const remaining = Array.isArray(d.remaining)
    ? d.remaining
        .filter((item) => typeof item === "string" && item.trim())
        .slice(0, MAX_REMAINING)
        .map((item) => redactAndClip(item, LINE_MAX))
    : [];

  const ageMs = Math.max(0, now - updatedAt);
  const stale = ageMs > STALE_MS;
  return {
    available: true,
    percent,
    summary: redactAndClip(d.summary.trim().split("\n")[0], LINE_MAX),
    remaining,
    remainingCount: remaining.length,
    updatedAt,
    ageMs,
    stale,
    // Rendered verbatim by the page when stale, so the wording is tested here.
    staleNote: stale
      ? "last updated " + Math.round(ageMs / 60_000) + "m ago"
      : null,
    source: file,
    writer: "orchestrator-maintained; this dashboard only reads it",
  };
}
