import net from 'node:net'

/**
 * Publish the target port on extra interfaces by relaying TCP both ways.
 * A missing address (VPN down) only loses that entry point.
 */
export async function createRelay({
  targetHost = '127.0.0.1', targetPort, listenPort = targetPort, addresses = [], log = () => {},
} = {}) {
  const servers = []
  const sockets = new Set()
  const results = []

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
      log(`[relay] ${address} 不可用：${status}`)
      results.push({ address, status })
      resolve()
    })
    server.listen(listenPort, address, () => {
      servers.push(server)
      const port = server.address().port
      results.push({ address, status: 'ok', port })
      log(`[relay] ${address}:${port} → ${targetHost}:${targetPort}`)
      resolve()
    })
  })

  await Promise.all(addresses.map(publish))

  return {
    results,
    async close() {
      for (const server of servers) server.close()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}
