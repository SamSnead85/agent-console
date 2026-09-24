/**
 * The private denylist: names that must never be published.
 *
 * The list itself is not in this repository. CI reads it from the repository
 * secret PUBLIC_SAFETY_DENYLIST; a maintainer can run the same check locally
 * with that variable set, or with PUBLIC_SAFETY_DENYLIST_FILE pointing at a
 * file outside the repository. One entry per line:
 *
 *   a plain term      matched case-insensitively, as a whole word
 *   /a regex/flags    matched as written ("g" is added)
 *   # a comment       ignored, as are blank lines
 *
 * A finding names the entry by its line number in the list and the place it
 * was found, never the text: the log of a public repository's CI run is
 * public, and a denylisted name printed there would be published by the very
 * check meant to stop it.
 */

import fs from "node:fs";

/** @returns {{source: string, entries: {n: number, re: RegExp}[]}|null} null when no list is configured */
export function loadDenylist(env = process.env) {
  let text = null, source = null;
  if (env.PUBLIC_SAFETY_DENYLIST && env.PUBLIC_SAFETY_DENYLIST.trim()) { text = env.PUBLIC_SAFETY_DENYLIST; source = "PUBLIC_SAFETY_DENYLIST"; }
  else if (env.PUBLIC_SAFETY_DENYLIST_FILE) { text = fs.readFileSync(env.PUBLIC_SAFETY_DENYLIST_FILE, "utf8"); source = "PUBLIC_SAFETY_DENYLIST_FILE"; }
  if (text === null) return null;
  return { source, entries: parseDenylist(text) };
}

export function parseDenylist(text) {
  const entries = [];
  text.split(/\r?\n/u).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const literal = /^\/(.+)\/([a-z]*)$/u.exec(line);
    let re;
    try {
      re = literal
        ? new RegExp(literal[1], [...new Set(literal[2] + "gu")].join(""))
        : new RegExp(`(?<![\\p{L}\\p{N}_])${line.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "[\\s_-]+")}(?![\\p{L}\\p{N}_])`, "giu");
    } catch {
      throw new Error(`denylist entry ${i + 1} is not a valid pattern`);
    }
    entries.push({ n: i + 1, re });
  });
  return entries;
}

/** Findings as {rule, line, column}; the entry number stands in for the text. */
export function scanDenylist(text, entries) {
  const findings = [];
  for (const { n, re } of entries) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const before = text.slice(0, m.index);
      const line = before.split("\n").length;
      findings.push({ rule: `denylist #${n}`, why: "a name on the private denylist", line, column: m.index - before.lastIndexOf("\n"), masked: "(not shown)" });
    }
  }
  return findings;
}
