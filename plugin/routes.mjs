import { randomUUID } from 'node:crypto'
import { resolvePaths } from '../src/paths.mjs'
import {
  normalizeReportConfig, readReportConfig, reportConfigFile, validateReportConfig, writeReportConfig,
} from '../src/report-config.mjs'

const NONCE_TTL_MS = 5 * 60 * 1000

const configFile = () => reportConfigFile(resolvePaths())

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
  readConfig = null,
  writeConfig = null,
  sendTest = null,
} = {}) {
  let nonce = null
  let expiresAt = 0

  const read = readConfig ?? (async () => readReportConfig(configFile()))
  const write = writeConfig ?? (async (config) => writeReportConfig(configFile(), config))
  const test = sendTest ?? (async () => ({ ok: false, error: 'no-test-hook' }))

  const saveConfig = async (body) => {
    let parsed
    try {
      parsed = JSON.parse(body ?? '{}')
    } catch {
      return json(400, { errors: ['请求体不是合法 JSON'] })
    }
    const config = normalizeReportConfig(parsed)
    const problems = validateReportConfig(config)
    if (problems.length > 0) return json(400, { errors: problems })
    try {
      const saved = await write(config)
      return json(200, saved ?? config)
    } catch (error) {
      return json(500, { errors: [String(error?.message ?? error)] })
    }
  }

  const respond = (fn) => fn().catch((error) => json(500, { errors: [String(error?.message ?? error)] }))

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
          const inbox = known && activity.inbox === true
          const approvals = known ? Number(activity.approvals ?? 0) : 0
          return json(200, {
            busy: agents > 0 || jobs > 0 || inbox || approvals > 0,
            known, agents, jobs, inbox, approvals, nonce,
          })
        }

        if (method === 'GET' && url === '/dsh-switch/report-config') {
          return respond(async () => json(200, await read()))
        }

        if (method === 'POST' && url === '/dsh-switch/report-config') {
          return respond(() => saveConfig(body))
        }

        if (method === 'POST' && url === '/dsh-switch/report-test') {
          return respond(async () => {
            const result = await test()
            return result?.ok
              ? json(200, { ok: true, status: result.status })
              : json(502, { ok: false, error: result?.error ?? 'send failed' })
          })
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
