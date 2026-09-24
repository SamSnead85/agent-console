/** Convert raw local tool input into named facts. Raw text never leaves here. */
import path from 'node:path';

export function classifyTool({ tool_name: tool, tool_input: input = {}, cwd = '' }, repoRoot = cwd) {
  const command = typeof input.command === 'string' ? input.command
    : typeof input.cmd === 'string' ? input.cmd : '';
  const file = typeof input.file_path === 'string' ? input.file_path.replaceAll('\\', '/') : '';
  const matches = new Set();
  const shell = tool === 'Bash' || tool === 'PowerShell';
  if (shell) {
    if (/\bgit\s+push\b[^\n;|]*(?:--force(?:-with-lease)?\b|\s-f\b)/iu.test(command)) matches.add('force-push');
    if (/\bgit\s+push\b[^\n;|]*(?:\b(?:main|master)\b|HEAD:(?:refs\/heads\/)?(?:main|master|release[/-][\w.-]+))/iu.test(command)) matches.add('protected-push');
    if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|node|python\d*)\b/iu.test(command)) matches.add('pipe-to-interpreter');
    if (/\b(?:prisma\s+migrate\s+deploy|knex\s+migrate:latest|db:migrate|alembic\s+upgrade|flyway\s+migrate)\b/iu.test(command)
      && /\b(?:prod|production)\b/iu.test(command)) matches.add('production-migration');
    if (/\b(?:rm\s+-[^\s]*[rR][^\s]*[fF]?|Remove-Item\b[^\n]*-Recurse)\b/iu.test(command)) {
      // A path outside the project, or an unparseable target, asks by default.
      const target = /\b(?:rm\s+-\S+|Remove-Item\b[^\n]*-Recurse)\s+([^\s;&|]+)/iu.exec(command)?.[1];
      const resolved = target ? path.resolve(cwd || '.', target.replace(/^['"]|['"]$/gu, '')) : null;
      const root = path.resolve(repoRoot || cwd || '.');
      if (!resolved || (resolved !== root && !resolved.startsWith(root + path.sep))) matches.add('recursive-delete-outside-repo');
    }
    if (/\b(?:cat|sed|head|tail|less|more|type|Get-Content|cp|scp)\b[^\n;|]*(?:\.env(?:\b|\.)|\.aws[/\\]credentials|\.ssh[/\\]id_|\.npmrc\b|\.netrc\b|keychain)/iu.test(command)) matches.add('credential-read');
  }
  if (tool === 'Read' && /(?:^|\/)\.env(?:$|\.)|\.aws\/credentials|\.ssh\/id_|(?:^|\/)\.npmrc$|(?:^|\/)\.netrc$/iu.test(file)) matches.add('credential-read');
  return [...matches];
}
