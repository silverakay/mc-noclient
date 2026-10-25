'use strict';

const fs = require('fs');
const path = require('path');

// Lock the read/merge/write transaction, not just the final rename.
function withFileLock(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + '.lock';
  const deadline = Date.now() + 1000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; }
    catch (error) {
      // Windows may report a delete-pending lock as EPERM instead of EEXIST.
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      if (Date.now() >= deadline) throw new Error('Data is being saved by another window or is not writable; please retry', { cause: error });
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.unlinkSync(lock); continue; }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(statError.code)) throw statError;
      }
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try { return action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

module.exports = { withFileLock };
