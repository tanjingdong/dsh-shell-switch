import fs from 'node:fs'
import path from 'node:path'

/** `logs/<yyyyMMdd-HHmmss>.log` — the same shape as the cutover backup stamp. */
export function logFilePath(paths, now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return path.join(paths.logDir, `${stamp}.log`)
}

/**
 * Tee every line to the console and to a timestamped file. A log that cannot
 * be opened must never stop a switch, and the file path travels with failures
 * so the user can open it.
 */
export function createLogger({
  paths, now = new Date(), out = process.stdout, err = process.stderr,
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
  open = (file) => fs.openSync(file, 'a'),
  write = (fd, text) => fs.writeSync(fd, text),
  close = (fd) => fs.closeSync(fd),
} = {}) {
  const file = logFilePath(paths, now)
  let fd = null
  try {
    mkdir(paths.logDir)
    fd = open(file)
  } catch {
    fd = null
  }
  const emit = (stream, message) => {
    const line = `${message}\n`
    try {
      stream.write(line)
    } catch {
      /* a closed stream must not break the switch */
    }
    if (fd !== null) {
      try {
        write(fd, line)
      } catch {
        /* a full or locked disk must not break the switch */
      }
    }
  }
  return {
    file,
    log: (message) => emit(out, message),
    error: (message) => emit(err, message),
    close: () => {
      if (fd === null) return
      try {
        close(fd)
      } catch {
        /* nothing left to release */
      }
      fd = null
    },
  }
}
