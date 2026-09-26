/**
 * The exact command that runs this copy of Agent Console.
 *
 * Every command the console or the reporter prints for a person to type uses
 * this, never a bare "agent-console": that name is not on anyone's PATH unless
 * they installed it globally, and "npx agent-console" would fetch an unrelated
 * package from the public registry. Run from a download, the command is this
 * file under node; run through npx, it is the release on GitHub, over HTTPS.
 */

import fs from "node:fs";
import path from "node:path";
import { isSea } from "node:sea";

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
 * A download that fails names its underlying cause (for fetch, the network
 * or certificate error code) and, when there is one, the one line that fixes
 * it behind a corporate proxy or TLS inspection. Only the cause's code or name
 * is printed; nothing of the download is.
 *
 * It is pasted into sh, bash, zsh, fish and PowerShell alike, inside single
 * quotes, so it holds no single quote, double quote, backslash or dollar sign
 * (test/join-command.test.js checks). public/join.js carries the same text.
 */
export const VERIFY_AND_RUN = "const[u,...a]=process.argv.slice(1),p=require(`path`),n=p.basename(u),g=x=>fetch(x).then(r=>{if(!r.ok)throw Error(x+` answered `+r.status);return r.arrayBuffer()}).then(Buffer.from);(async()=>{if(!/^https:[/][/]github[.]com[/][A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+[/]releases[/]download[/]v[0-9.]+[/][A-Za-z0-9_.-]+[.]tgz(?![^])/.test(u))throw Error(`not a release file: `+u);const t=String(await g(p.posix.dirname(u)+`/SHA256SUMS`)).split(/[^0-9A-Za-z._-]+/),b=await g(u),h=require(`crypto`).createHash(`sha256`).update(b).digest(`hex`);if(h!==t[t.indexOf(n)-1])throw Error(n+` does not match the release SHA256SUMS; nothing was run`);const f=require(`fs`),d=p.join(require(`os`).homedir(),`.agent-console`,`releases`),k=p.join(d,n),w=process.platform==`win32`,q=String.fromCharCode(34);f.mkdirSync(d,{recursive:true});f.writeFileSync(k,b);console.error(n+` matches the release SHA256SUMS: `+h);const r=require(`child_process`).spawnSync(w?[`npx`,`--yes`,`file:`+k,...a].map(x=>q+x+q).join(` `):`npx`,w?[]:[`--yes`,`file:`+k,...a],{stdio:`inherit`,shell:w,env:{...process.env,AGENT_CONSOLE_PACKAGE:k}});process.exit(r.status??1)})().catch(e=>{const c=e.cause;console.error(String(e.message)+(c?` (`+String(c.code||c.name||c)+`)`:``));if(c)console.error(`Behind a proxy or TLS inspection? Set HTTPS_PROXY and NODE_USE_ENV_PROXY=1, and NODE_EXTRA_CA_CERTS=<your company root .pem>`);process.exit(1)})";

/**
 * The SHA-256 of VERIFY_AND_RUN, published in the README, SECURITY.md and each
 * release's notes, so whoever is handed a command can compare the check in it
 * with what this project published (test/join-command.test.js keeps them equal).
 */
export const VERIFY_SHA256 = "77aea0b4b487f2e39065b5739377f16678d6977b0fbd6d1ab0ef901052e581bc";

/**
 * A short command, readable in full, that prints the SHA-256 of the check in a
 * command pasted into it (the text between its first two single quotes)
 * without running anything. Paste the command, press Return, then Ctrl+D
 * (Ctrl+Z and Return in PowerShell).
 */
export const CHECK_HASH_COMMAND = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(require('crypto').createHash('sha256').update(s.split(String.fromCharCode(39))[1]).digest('hex')))"`;

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
 * A standalone executable names itself. Started by the verified command, it
 * names the checked file it kept; started through npx some other way, it is
 * the verified command itself.
 */
export function invocation(version, entry = process.argv[1], env = process.env, executable = isSea() ? process.execPath : null) {
  if (executable) return executableCommand(executable, { env });
  const file = path.resolve(String(entry || "bin/agent-console.mjs"));
  if (/[\\/]_npx[\\/]/u.test(file)) {
    const kept = String(env.AGENT_CONSOLE_PACKAGE || "");
    if (path.isAbsolute(kept) && path.basename(kept) === releaseAsset(version) && !/["'`$\n]/u.test(kept)) return `npx --yes ${shellArgument(`file:${kept}`)}`;
    return verifiedRun(version);
  }
  return `node ${shellArgument(file)}`;
}

/** One literal argument for the platform's documented interactive shell. */
export function shellArgument(value, platform = process.platform) {
  const text = String(value);
  return platform === "win32"
    ? "'" + text.replace(/['‘’‚‛]/gu, (quote) => quote + quote) + "'"
    : "'" + text.replace(/'/gu, "'\\''") + "'";
}

/**
 * A standalone executable (docs/executables.md) has no node to put in front
 * of it. It is run by its bare name when PATH finds this very file first, as
 * after the install script or Homebrew; otherwise by its full path, which
 * PowerShell runs only behind "&" when it is quoted.
 *
 * Whatever is not a plain word is quoted literally for the shell it is pasted
 * into, name and path alike: in single quotes for sh (a ' inside becomes
 * '\''), and for PowerShell in a single-quoted string behind the call operator
 * (a ' inside, in any form PowerShell reads as one, is doubled). Neither shell
 * substitutes anything inside those quotes, so a folder named $(…) or `…`
 * stays a folder name.
 */
export function executableCommand(executable, { env = process.env, platform = process.platform, exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const file = p.basename(executable);
  const same = (a, b) => { try { a = realpath(a); b = realpath(b); } catch { /* compare as given */ } return win ? a.toLowerCase() === b.toLowerCase() : a === b; };
  const literal = (text) => (win ? "& " : "") + shellArgument(text, platform);
  for (const dir of String(env.PATH ?? env.Path ?? "").split(p.delimiter)) {
    if (!dir || !exists(p.join(dir, file))) continue;
    if (!same(p.join(dir, file), executable)) break; // another copy comes first on PATH
    const name = file.replace(/\.exe$/iu, "");
    return /^[\w.-]+$/u.test(name) ? name : literal(name);
  }
  // A backslash separates folders on Windows; in sh it escapes the next character.
  if ((win ? /^[\w./:\\-]+$/u : /^[\w./:-]+$/u).test(executable)) return executable;
  return literal(executable);
}
