#!/usr/bin/env node
/*
 * Is this macOS executable accepted as notarized? Asked the way a browser
 * download is asked: a quarantined copy is assessed by Gatekeeper
 * (spctl --assess --type install) until it says "Notarized Developer ID".
 * A bare executable cannot carry a stapled ticket, so Gatekeeper fetches it
 * from Apple by the signature's CDHash, and Apple publishes a new ticket
 * within minutes: this waits up to ten minutes.
 *
 * Where Gatekeeper assessments are turned off (some CI images), spctl cannot
 * answer; then it asks Apple's ticket service, the one Gatekeeper uses, for
 * the ticket of this CDHash instead, and says that it did.
 *
 *   node packaging/sea/notarized.mjs <file>     (build.mjs and release.yml use it)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TICKETS = "https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup";
const ATTEMPTS = 40;
const WAIT_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (command, args) => spawnSync(command, args, { encoding: "utf8" });

/** The signature's CDHash, from codesign -d (which reports on stderr). */
export function cdhashOf(file) {
  const shown = run("codesign", ["-dvvv", file]);
  const hash = /^CDHash=([0-9a-f]{40})$/mu.exec(shown.stdout + shown.stderr)?.[1];
  if (shown.status !== 0 || !hash) throw new Error(`no code signature on ${file}`);
  return hash;
}

export function gatekeeperEnabled() {
  const status = run("spctl", ["--status"]);
  return /assessments enabled/u.test(status.stdout + status.stderr);
}

async function appleHasTicket(cdhash) {
  try {
    const response = await fetch(TICKETS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records: [{ recordName: `2/2/${cdhash}` }] }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json();
    return body.records?.[0]?.recordType === "DeveloperIDTicket";
  } catch {
    return false;
  }
}

/** Resolves with how it was accepted; rejects if it never was. */
export async function waitUntilNotarized(file, { log = () => {} } = {}) {
  const cdhash = cdhashOf(file);
  if (!gatekeeperEnabled()) {
    log(`Gatekeeper assessments are turned off on this machine; asking Apple's ticket service for CDHash ${cdhash}`);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (await appleHasTicket(cdhash)) return `Apple holds a notarization ticket for CDHash ${cdhash}`;
      await sleep(WAIT_MS);
    }
    throw new Error(`Apple published no notarization ticket for CDHash ${cdhash} within ten minutes`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-gatekeeper-"));
  const probe = path.join(dir, path.basename(file));
  try {
    fs.copyFileSync(file, probe);
    fs.chmodSync(probe, 0o755);
    const stamp = Math.floor(Date.now() / 1000).toString(16);
    const marked = run("xattr", ["-w", "com.apple.quarantine", `0081;${stamp};Safari;`, probe]);
    if (marked.status !== 0) throw new Error(`could not quarantine the probe: ${marked.stderr}`);
    let last = "";
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const assessed = run("spctl", ["--assess", "--type", "install", "-vv", probe]);
      last = (assessed.stdout + assessed.stderr).replaceAll(`${probe}: `, "").trim();
      if (assessed.status === 0 && /source=Notarized Developer ID/u.test(last)) return `Gatekeeper: ${last.split("\n").join(", ")}`;
      await sleep(WAIT_MS);
    }
    throw new Error(`Gatekeeper did not accept a quarantined copy as notarized within ten minutes: ${last}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("Usage: node packaging/sea/notarized.mjs <file>\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${await waitUntilNotarized(path.resolve(file), { log: (line) => process.stdout.write(line + "\n") })}\n`);
  } catch (error) {
    process.stderr.write(`notarized: ${error.message}\n`);
    process.exit(1);
  }
}
