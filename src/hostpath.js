'use strict';
/**
 * hostpath.js — the one check for host paths: adb_push, adb_pull, adb_install,
 * the adb_app store and every backup path read back from a snapshot.
 *
 * A path is accepted when it is absolute, lies inside one of the roots, and
 * the real place of its nearest existing ancestor (the file of a pull may not
 * exist yet) lies inside the real place of one of the roots, so a symlink or a
 * junction that leads out is refused. "Inside" is path.relative() not
 * climbing out, never a prefix test: /media2 is not inside /media. Windows
 * and macOS compare without regard to letter case. On Windows UNC and device
 * paths (\\server\share, \\?\, \\.\) and paths without a drive letter are
 * refused.
 *
 * Nothing here creates a directory: callers check first, then mkdir.
 */

const fs = require('fs');
const path = require('path');

function caseInsensitive(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin';
}

function fold(s) {
  return caseInsensitive() ? s.toLowerCase() : s;
}

/** Whether p is root itself or below it (both absolute). */
function inside(p, root) {
  const rel = path.relative(fold(root), fold(p));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

// realpath of the nearest existing ancestor, with the missing tail appended.
function realWithTail(p) {
  const tail = [];
  let probe = p;
  for (;;) {
    let real;
    try {
      real = fs.realpathSync.native(probe);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const up = path.dirname(probe);
      if (up === probe) return p;
      tail.unshift(path.basename(probe));
      probe = up;
      continue;
    }
    return tail.length ? path.join(real, ...tail) : real;
  }
}

function describeRoots(roots) {
  const shown = roots.join(', ');
  return roots.length <= 3 && shown.length <= 200 ? shown : `${roots.length} directories`;
}

class HostPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostPathError';
  }
}

/**
 * Check a host path. Returns the absolute (lexical) path or throws
 * HostPathError naming the setting.
 *   roots    allowed directories (absolute)
 *   exact    paths accepted as they are, not their contents (the store setting
 *            for the adb_app store parameter)
 *   setting  the setting the refusal names: 'file_roots' or 'store'
 *   what     what the path is for, for the message
 */
const DEFAULT_ROOTS_HINT = 'run `brickproof-adb set file_roots <folder>` and restart the server';

function checkHostPath(p, { roots = [], exact = [], setting = 'file_roots', what = 'host path', emptyHint = DEFAULT_ROOTS_HINT } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new HostPathError(`${what} must be a non-empty string`);
  if (p.includes('\0')) throw new HostPathError(`${what} contains a NUL character`);
  if (process.platform === 'win32') {
    if (/^[\\/]{2}/.test(p)) throw new HostPathError(`${what} ${p}: UNC and device paths (\\\\server\\share, \\\\?\\, \\\\.\\) are not accepted`);
    if (!/^[A-Za-z]:[\\/]/.test(p)) throw new HostPathError(`${what} ${p} must be an absolute path with a drive letter`);
  }
  if (!path.isAbsolute(p)) throw new HostPathError(`${what} ${p} must be an absolute path`);
  const resolved = path.resolve(p);

  for (const e of exact) {
    if (e && inside(resolved, e) && inside(e, resolved)) return resolved;
  }

  if (!roots.length) {
    throw new HostPathError(setting === 'store'
      ? `${what} ${p}: the snapshot store must be the store setting or a directory inside file_roots, and file_roots is empty`
      : `${what} ${p} is refused: file_roots is empty, so no folder on this computer is open to the tools. To open one, ${emptyHint}.`);
  }

  const lexical = roots.filter(r => inside(resolved, r));
  const refuse = why => new HostPathError(`${what} ${p} is outside the allowed directories (${setting}: ${describeRoots(setting === 'store' ? [...exact, ...roots] : roots)})${why}`);
  if (!lexical.length) throw refuse('');

  const real = realWithTail(resolved);
  const realRoots = roots.map(r => realWithTail(path.resolve(r)));
  if (!realRoots.some(r => inside(real, r))) throw refuse(' - a symlink or junction on the way leads out of them');
  return resolved;
}

module.exports = { checkHostPath, HostPathError, inside, caseInsensitive };
