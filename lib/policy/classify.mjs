/** Turn local tool input into rule names. Never persist or transmit raw input. */
import os from 'node:os';
import path from 'node:path';

const CREDENTIAL = /(?:^|[/\\])\.env(?:$|[./\\])|(?:^|[/\\])(?:\.npmrc|\.netrc)(?:$|[/\\])|[/\\]\.aws[/\\]credentials|[/\\]\.ssh[/\\]id_[^/\\]+|keychain|credential(?:s|_store)?/iu;
const inside = (target, root) => target === root || target.startsWith(root + path.sep);
const expand = (target, home) => target.replace(/^~(?=$|[/\\])/u, home)
  .replace(/^\$\{?HOME\}?|^%USERPROFILE%/iu, home);
const token = (value) => value.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;|&]+/gu) || [];
const unquote = (value) => value?.replace(/^(['"])(.*)\1$/u, '$2');

export function classifyTool(input, repoRoot, home = os.homedir()) {
  const tool = String(input?.tool_name || '');
  const args = input?.tool_input || {};
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
  const file = typeof args.file_path === 'string' ? args.file_path : '';
  const cwd = typeof input?.cwd === 'string' ? input.cwd : repoRoot;
  const found = new Set();
  if (['Read', 'Grep', 'Glob'].includes(tool) && CREDENTIAL.test(file || args.path || args.pattern || '')) found.add('credential_read');
  if (tool !== 'Bash' && tool !== 'PowerShell') return [...found];

  if (/\bgit\s+push\b[^\n;|&]*(?:--force(?:-with-lease)?\b|(?:^|\s)-f\b|(?:^|\s)\+[^\s]+)/iu.test(command)) found.add('force_push');
  if (/\|\s*(?:sudo\s+)?(?:sh|bash|zsh|node|python\d*|ruby|perl)\b/iu.test(command)) found.add('pipe_to_interpreter');
  if (/\b(?:prisma\s+migrate\s+deploy|knex\s+migrate:latest|db:migrate|alembic\s+upgrade|flyway\s+migrate)\b/iu.test(command)
    && /\b(?:prod|production)\b/iu.test(command)) found.add('production_migration');
  if (CREDENTIAL.test(command) && /\b(?:cat|sed|head|tail|less|more|type|Get-Content|cp|scp|rg|grep|find|ls)\b/iu.test(command))
    found.add('credential_read');

  const words = token(command);
  for (let i = 0; i < words.length; i++) {
    const current = words[i].replace(/^.*[/\\]/u, '');
    if (current !== 'rm' && current !== 'Remove-Item') continue;
    const targets = [];
    for (let j = i + 1; j < words.length && !/^(?:&&|\|\||;|\|)$/u.test(words[j]); j++) {
      const word = unquote(words[j]);
      if (word === '--') continue;
      if (word.startsWith('-')) continue;
      targets.push(word);
    }
    if (!targets.length) { found.add('delete_outside_repo'); continue; }
    for (const target of targets) {
      const expanded = expand(target, home);
      if (/\$|%[A-Za-z_]+%/u.test(expanded) || !inside(path.resolve(cwd || repoRoot, expanded), path.resolve(repoRoot))) {
        found.add('delete_outside_repo'); break;
      }
    }
  }
  return [...found];
}
