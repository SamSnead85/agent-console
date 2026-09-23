/**
 * The exact command that runs this copy of Agent Console.
 *
 * Every command the console or the reporter prints for a person to type uses
 * this, never a bare "agent-console": that name is not on anyone's PATH unless
 * they installed it globally, and "npx agent-console" would fetch an unrelated
 * package from the public registry. Run from a download, the command is this
 * file under node; run through npx, it is the release on GitHub, over HTTPS.
 */

import path from "node:path";

export const REPOSITORY = "https://github.com/SamSnead85/agent-console";

/** The release asset for a version: the one file the one-line install fetches. */
export function releaseAsset(version) {
  return `lockedinlabs-agent-console-${version}.tgz`;
}

export function releaseUrl(version) {
  return `${REPOSITORY}/releases/download/v${version}/${releaseAsset(version)}`;
}

export function releasePage(version) {
  return `${REPOSITORY}/releases/tag/v${version}`;
}

/** How to run this copy again, quoted so a path with spaces survives a shell. */
export function invocation(version, entry = process.argv[1]) {
  const file = path.resolve(String(entry || "bin/agent-console.mjs"));
  if (/[\\/]_npx[\\/]/u.test(file)) return `npx --yes ${releaseUrl(version)}`;
  return `node "${file}"`;
}
