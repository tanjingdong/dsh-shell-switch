import { LauncherError } from './errors.mjs'
import { renderTemplate } from './report-config.mjs'

const VALUE_KEYS = ['url', 'token', 'port', 'target', 'time']

/** Render the template with the switch facts; result must be valid JSON. */
export function buildWebhookBody(config, info = {}) {
  const values = {}
  for (const key of VALUE_KEYS) values[key] = info?.[key] ?? ''
  const text = renderTemplate(config?.webhook?.template ?? '', values)
  try {
    JSON.parse(text)
  } catch {
    throw new LauncherError('bad-template', `JSON 模板渲染后不是合法 JSON：${text.slice(0, 120)}`)
  }
  return text
}

/** POST the body. Never throws: the caller only needs ok/failure. */
export async function sendWebhook({ url, body, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!url) return { ok: false, error: 'no-url' }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response?.ok) return { ok: true, status: response.status }
    return { ok: false, status: response?.status, error: `HTTP ${response?.status}` }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

/**
 * Run the enabled channels once. Every channel is independent: a failure is
 * recorded and logged, and none of them can fail the switch itself.
 */
export async function reportSwitch({
  config, info = {}, open, copy, dialog, send, log = () => {},
} = {}) {
  const result = { browser: 'skipped', clipboard: 'skipped', dialog: 'skipped', webhook: 'skipped' }
  const url = info?.url ?? ''

  // The browser goes first so the page is up while the other channels report.
  if (config?.report?.browser === true && url) {
    try {
      await open({ url })
      result.browser = 'sent'
    } catch (error) {
      result.browser = 'failed'
      log(`[report] 打开浏览器失败：${error?.message ?? error}`)
    }
  }

  if (config?.report?.clipboard === true && url) {
    try {
      await copy({ url })
      result.clipboard = 'sent'
    } catch (error) {
      result.clipboard = 'failed'
      log(`[report] 剪贴板失败：${error?.message ?? error}`)
    }
  }

  if (config?.report?.dialog === true && url) {
    try {
      await dialog({ url })
      result.dialog = 'sent'
    } catch (error) {
      result.dialog = 'failed'
      log(`[report] 弹窗失败：${error?.message ?? error}`)
    }
  }

  if (config?.report?.webhook === true) {
    try {
      const body = buildWebhookBody(config, info)
      const sent = await send({ url: config.webhook.url, body })
      result.webhook = sent?.ok ? 'sent' : 'failed'
      if (!sent?.ok) log(`[report] webhook 失败：${sent?.error ?? sent?.status ?? 'unknown'}`)
    } catch (error) {
      result.webhook = 'failed'
      log(`[report] webhook 失败：${error?.message ?? error}`)
    }
  }

  return result
}
