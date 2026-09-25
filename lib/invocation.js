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

/**
 * A join link as a command may carry it: an address, /join, then exactly a
 * code and a fingerprint. Every character is one no shell gives a meaning to,
 * and none is a quote. public/join.js holds the same pattern.
 */
export const SAFE_JOIN_LINK = /^https?:\/\/(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?\/join#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;

/**
 * Verify, then run. Every command the console prints for someone to paste
 * starts with this: a short program for `node -e` that downloads the release
 * file and the release's SHA256SUMS from GitHub over HTTPS, refuses to go on
 * unless the file's SHA-256 is the one SHA256SUMS lists for it, keeps the
 * checked file in ~/.agent-console/releases, and only then runs that file with
 * npx (as a file: package). Nothing from the download runs before the check.
 *
 * It is pasted into sh, bash, zsh, fish and PowerShell alike, inside single
 * quotes, so it holds no single quote, double quote, backslash or dollar sign
 * (test/join-command.test.js checks). public/join.js carries the same text.
 */
export const VERIFY_AND_RUN = "const[u,...a]=process.argv.slice(1),p=require(`path`),n=p.basename(u),g=x=>fetch(x).then(r=>{if(!r.ok)throw Error(x+` answered `+r.status);return r.arrayBuffer()}).then(Buffer.from);(async()=>{if(!/^https:[/][/]github[.]com[/][A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+[/]releases[/]download[/]v[0-9.]+[/][A-Za-z0-9_.-]+[.]tgz(?![^])/.test(u))throw Error(`not a release file: `+u);const t=String(await g(p.posix.dirname(u)+`/SHA256SUMS`)).split(/[^0-9A-Za-z._-]+/),b=await g(u),h=require(`crypto`).createHash(`sha256`).update(b).digest(`hex`);if(h!==t[t.indexOf(n)-1])throw Error(n+` does not match the release SHA256SUMS; nothing was run`);const f=require(`fs`),d=p.join(require(`os`).homedir(),`.agent-console`,`releases`),k=p.join(d,n),w=process.platform==`win32`,q=String.fromCharCode(34);f.mkdirSync(d,{recursive:true});f.writeFileSync(k,b);console.error(n+` matches the release SHA256SUMS: `+h);const r=require(`child_process`).spawnSync(w?[`npx`,`--yes`,`file:`+k,...a].map(x=>q+x+q).join(` `):`npx`,w?[]:[`--yes`,`file:`+k,...a],{stdio:`inherit`,shell:w,env:{...process.env,AGENT_CONSOLE_PACKAGE:k}});process.exit(r.status??1)})().catch(e=>{console.error(String(e.message));process.exit(1)})";

/** The verified way to run a release: `node -e '<check>' <release file>`, then the arguments. */
export function verifiedRun(version) {
  return `node -e '${VERIFY_AND_RUN}' ${releaseUrl(version)}`;
}

/**
 * The command that joins with a link. The link goes in single quotes, which
 * sh, bash, zsh, fish and PowerShell all take literally; the reporter also
 * accepts the quotes cmd.exe passes through.
 */
export function joinCommand(version, link) {
  if (!SAFE_JOIN_LINK.test(String(link))) throw new Error("a join link with unexpected characters was not put into a command");
  return `${verifiedRun(version)} join '${link}'`;
}

/**
 * How to run this copy again, quoted so a path with spaces survives a shell.
 * Started by the verified command, it names the checked file it kept; started
 * through npx some other way, it is the verified command itself.
 */
export function invocation(version, entry = process.argv[1], env = process.env) {
  const file = path.resolve(String(entry || "bin/agent-console.mjs"));
  if (/[\\/]_npx[\\/]/u.test(file)) {
    const kept = String(env.AGENT_CONSOLE_PACKAGE || "");
    if (path.isAbsolute(kept) && path.basename(kept) === releaseAsset(version) && !/["'`$\n]/u.test(kept)) return `npx --yes "file:${kept}"`;
    return verifiedRun(version);
  }
  return `node "${file}"`;
}
