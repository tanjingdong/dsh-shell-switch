import net from 'node:net'
import { LauncherError } from './errors.mjs'

/** Parse the standalone relay's arguments. */
export function parseRelayArgs(argv = []) {
  const options = { targetPort: null, listenPort: 0, addresses: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => argv[index + 1]
    if (arg === '--target-port') {
      options.targetPort = Number(value())
      index += 1
    } else if (arg === '--listen-port') {
      options.listenPort = Number(value())
      index += 1
    } else if (arg === '--addresses') {
      options.addresses = String(value() ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      index += 1
    } else {
      throw new LauncherError('bad-relay-args', `未知参数：${arg}`)
    }
  }
  if (!Number.isInteger(options.targetPort) || options.targetPort <= 0) {
    throw new LauncherError('bad-relay-args', '缺少 --target-port')
  }
  if (!Number.isInteger(options.listenPort) || options.listenPort < 0) {
    throw new LauncherError('bad-relay-args', '缺少 --listen-port')
  }
  return options
}

/**
 * Publish the target port on extra interfaces by relaying TCP both ways.
 * A missing address (VPN down) only loses that entry point, and failed
 * addresses are retried later instead of being lost for the session.
 */
export async function createRelay({
  targetHost = '127.0.0.1', targetPort, listenPort = targetPort, addresses = [], log = () => {},
  retryIntervalMs = 30000,
  schedule = (fn, ms) => setInterval(fn, ms),
  cancel = (timer) => clearInterval(timer),
} = {}) {
  const servers = []
  const sockets = new Set()
  const statusOf = new Map()

  const publish = (address) => new Promise((resolve) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: targetHost, port: targetPort })
      sockets.add(client)
      sockets.add(upstream)
      const teardown = () => { client.destroy(); upstream.destroy() }
      client.on('error', teardown)
      upstream.on('error', teardown)
      client.on('close', () => { sockets.delete(client); upstream.destroy() })
      upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
      upstream.on('connect', () => { client.pipe(upstream); upstream.pipe(client) })
    })
    server.once('error', (error) => {
      const status = error?.code ?? 'error'
      statusOf.set(address, { address, status })
      log(`[relay] ${address} 不可用：${status}`)
      resolve()
    })
    server.listen(listenPort, address, () => {
      servers.push(server)
      const port = server.address().port
      statusOf.set(address, { address, status: 'ok', port })
      log(`[relay] ${address}:${port} → ${targetHost}:${targetPort}`)
      resolve()
    })
  })

  await Promise.all(addresses.map(publish))

  const snapshot = () => addresses.map((address) => (
    statusOf.get(address) ?? { address, status: 'pending' }
  ))

  const retry = async () => {
    const failed = addresses.filter((address) => statusOf.get(address)?.status !== 'ok')
    await Promise.all(failed.map(publish))
    return snapshot()
  }

  const timer = retryIntervalMs > 0 && addresses.length > 0
    ? schedule(() => { retry().catch(() => {}) }, retryIntervalMs)
    : null
  timer?.unref?.()

  return {
    retry,
    get results() { return snapshot() },
    async close() {
      if (timer) cancel(timer)
      for (const server of servers) server.close()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}

/** Build the relay from argv. Kept separate from the guard so it is testable. */
export async function runRelayCli(argv, { relayFactory = createRelay, log = () => {} } = {}) {
  const options = parseRelayArgs(argv)
  return await relayFactory({
    targetPort: options.targetPort,
    listenPort: options.listenPort,
    addresses: options.addresses,
    log,
  })
}

if (process.argv[1]?.endsWith('relay.mjs')) {
  const log = (message) => process.stdout.write(`${message}\n`)
  runRelayCli(process.argv.slice(2), { log })
    .then((relay) => {
      // Keep the process alive even when every address failed, so a retry can
      // publish later; the launcher ends it by pid.
      const keepAlive = setInterval(() => {}, 60 * 60 * 1000)
      const stop = () => {
        clearInterval(keepAlive)
        relay.close().then(() => process.exit(0), () => process.exit(1))
      }
      process.on('SIGTERM', stop)
      process.on('SIGINT', stop)
    })
    .catch((error) => {
      process.stderr.write(`${error?.message ?? error}\n`)
      process.exit(1)
    })
}
