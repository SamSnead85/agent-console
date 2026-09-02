import fs from "node:fs";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const POSIX = process.platform !== "win32";

export function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("private state path is not a regular directory: " + dir);
  }
  if (POSIX) fs.chmodSync(dir, PRIVATE_DIRECTORY_MODE);
}

export function hardenPrivateFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("private state path is not a regular file: " + file);
  }
  if (POSIX) fs.chmodSync(file, PRIVATE_FILE_MODE);
  return true;
}

export function appendPrivateFile(file, data) {
  ensurePrivateDirectory(path.dirname(file));
  hardenPrivateFile(file);
  const fd = fs.openSync(
    file,
    fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    fs.writeFileSync(fd, data);
    if (POSIX) fs.fchmodSync(fd, PRIVATE_FILE_MODE);
  } finally {
    fs.closeSync(fd);
  }
}

export function writePrivateAtomic(file, data) {
  ensurePrivateDirectory(path.dirname(file));
  hardenPrivateFile(file);
  const tmp = file + ".tmp";
  // Never follow or overwrite a forged temporary symlink.
  try {
    const stat = fs.lstatSync(tmp);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("private state temp path is unsafe: " + tmp);
    }
    fs.rmSync(tmp);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const fd = fs.openSync(
    tmp,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    fs.writeFileSync(fd, data);
    if (POSIX) fs.fchmodSync(fd, PRIVATE_FILE_MODE);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
    if (POSIX) fs.chmodSync(file, PRIVATE_FILE_MODE);
  } catch (error) {
    try {
      fs.rmSync(tmp);
    } catch {
      // Preserve the original failure; cleanup is best effort.
    }
    throw error;
  }
}
