/** Independent read/ingest credential generations. Rotation never changes browser sessions. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const filenameFor = (dir, scope) => path.join(dir, `interop-${checkScope(scope)}-generation.json`);
export function checkScope(scope) {
  if (scope !== 'read' && scope !== 'ingest') throw new Error('Telemetry scope must be read or ingest.');
  return scope;
}
function readGeneration(dir, scope) {
  if (!dir) return {};
  const filename = filenameFor(dir, scope);
  let fd;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid telemetry credential state.');
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!state || state.v !== 1 || Object.keys(state).some(k => !['v', 'generation'].includes(k))
      || !/^[a-f0-9]{32}$/u.test(state.generation)) {
      throw new Error('Invalid telemetry credential state.');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Telemetry credential state cannot be read; access is refused.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function interopGeneration(dir, scope) {
  checkScope(scope);
  return readGeneration(dir, scope).generation || '';
}
export function rotateInteropCredential(dir, scope) {
  checkScope(scope);
  if (!dir) throw new Error('A persistent console state directory is required for rotation.');
  const state = readGeneration(dir, scope);
  state.v = 1;
  state.generation = crypto.randomBytes(16).toString('hex');
  const filename = filenameFor(dir, scope);
  const temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(fd, JSON.stringify(state) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  return state.generation;
}
