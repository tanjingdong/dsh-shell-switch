import { randomUUID } from 'node:crypto'

const NONCE_TTL_MS = 5 * 60 * 1000

function json(status, payload) {
  return { status, body: JSON.stringify(payload) }
}

function isLoopbackAddress(address) {
  const value = String(address ?? '')
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function isLoopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host ?? '').trim())
}

/**
 * Two loopback-only routes: a read-only state/activity probe and a one-shot
 * handoff. Everything is caught; nothing throws into the host.
 */
export function createHandoffRoutes({
  spawnLauncher,
  now = () => Date.now(),
  random = () => randomUUID(),
  readActivity = () => null,
} = {}) {
  let nonce = null
  let expiresAt = 0

  return {
    handle(method, url, headers = {}, remote = {}, body) {
      try {
        if (!isLoopbackAddress(remote?.remoteAddress)) return json(403, { error: 'forbidden' })
        const host = headers.host ?? headers.Host
        if (!isLoopbackHost(host)) return json(403, { error: 'forbidden' })

        if (method === 'GET' && url === '/dsh-switch/state') {
          nonce = random()
          expiresAt = now() + NONCE_TTL_MS
          const activity = readActivity()
          const known = activity !== null && typeof activity === 'object'
          const agents = known ? Number(activity.agents ?? 0) : 0
          const jobs = known ? Number(activity.jobs ?? 0) : 0
          return json(200, { busy: agents > 0 || jobs > 0, known, agents, jobs, nonce })
        }

        if (method === 'POST' && url === '/dsh-switch/handoff') {
          const parsed = JSON.parse(body ?? '{}')
          if (!nonce || parsed.nonce !== nonce || now() > expiresAt) return json(403, { error: 'bad-nonce' })
          nonce = null
          const target = parsed.target === 'client' ? 'client' : 'web'
          spawnLauncher(target)
          return json(202, { ok: true, target })
        }

        return json(404, { error: 'not-found' })
      } catch (error) {
        return json(500, { error: error?.message ?? String(error) })
      }
    },
  }
}
