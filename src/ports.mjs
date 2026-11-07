import net from 'node:net'
import { LauncherError } from './errors.mjs'

/** True when something already accepts TCP on host:port. */
export function probePort(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** First port in [start, end] nothing is listening on. */
export async function findFreePort({ start = 3080, end = 3099, host = '127.0.0.1' } = {}) {
  for (let port = start; port <= end; port += 1) {
    if (!(await probePort(port, host))) return port
  }
  throw new LauncherError('no-free-port', `端口 ${start}-${end} 全部被占用`)
}

/**
 * Keep the preferred port when it is still free, otherwise take the next
 * free one. Called before every start attempt so a stale listener cannot
 * make the next attempt reuse a dead port.
 */
export async function reservePort(
  preferred, { probe = probePort, find = findFreePort, start = 3080, end = 3099 } = {},
) {
  if (preferred && !(await probe(preferred))) return preferred
  return await find({ start, end })
}
