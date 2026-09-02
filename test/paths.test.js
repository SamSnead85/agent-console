import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearPathCaches,
  projectLabel,
  resolveProjectSlug,
  slugifySegment,
} from "../lib/paths.js";

/**
 * Claude Code names a project directory after its cwd with every
 * non-alphanumeric character replaced by "-". The mapping is not invertible in
 * the abstract, but it is resolvable against the filesystem it came from.
 */

test("slugification matches what Claude Code writes", () => {
  assert.equal(slugifySegment("Sprintloop FDE"), "Sprintloop-FDE");
  assert.equal(
    slugifySegment("AI Native Training Aug 23"),
    "AI-Native-Training-Aug-23",
  );
  assert.equal(
    slugifySegment("GuidepointHealth - HealthNext "),
    "GuidepointHealth---HealthNext-",
  );
  assert.equal(slugifySegment(".claude"), "-claude");
});

test("a slug resolves back to the real directory, spaces and all", () => {
  clearPathCaches();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-paths-"));
  const names = [
    "Example Workspace",
    "AI Native Training",
    "Example Health",
    "a-b-c",
  ];
  for (const name of names) fs.mkdirSync(path.join(root, name));

  for (const name of names) {
    const slug = slugifySegment(root + "/" + name).replace(/^-*/u, "-");
    const resolved = resolveProjectSlug(slug);
    assert.equal(resolved.exact, true, "did not resolve: " + slug);
    assert.equal(resolved.path, path.join(root, name));
    assert.equal(projectLabel(resolved.path), name);
  }
  fs.rmSync(root, { recursive: true, force: true });
  clearPathCaches();
});

test("an unresolvable slug is marked approximate rather than asserted", () => {
  clearPathCaches();
  const resolved = resolveProjectSlug(
    "-definitely-not-a-real-path-anywhere-1234",
  );
  assert.equal(resolved.exact, false);
  assert.ok(resolved.path.length > 0);
  clearPathCaches();
});

test("the longest matching directory wins, so a prefix does not steal the match", () => {
  clearPathCaches();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-paths2-"));
  fs.mkdirSync(path.join(root, "AI Native"));
  fs.mkdirSync(path.join(root, "AI Native Training"));
  fs.mkdirSync(path.join(root, "AI Native Training", "web"));
  const slug = slugifySegment(root + "/AI Native Training/web").replace(
    /^-*/u,
    "-",
  );
  const resolved = resolveProjectSlug(slug);
  assert.equal(resolved.exact, true);
  assert.equal(resolved.path, path.join(root, "AI Native Training", "web"));
  fs.rmSync(root, { recursive: true, force: true });
  clearPathCaches();
});
