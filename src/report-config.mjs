import fs from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_REPORT_CONFIG = {
  report: { browser: true, clipboard: true, dialog: true, webhook: false },
  webhook: { url: '', template: '{"text":"DSH 外壳已切换到 {target}：{url}"}' },
  network: {
    // No machine-specific default: which interfaces exist is per-machine and
    // changes over time, so a shipped default cannot be right anywhere.
    // An empty list publishes nothing; the settings page offers the detected
    // interfaces to pick from.
    addresses: [],
    loopbackOnly: false,
  },
}

/** Values used when validating a template at save time. */
export const TEMPLATE_SAMPLE = {
  url: 'http://127.0.0.1:3080/?token=sample',
  token: 'sample',
  port: 3080,
  target: 'web',
  time: '2026-11-07T00:00:00.000Z',
}

export function reportConfigFile(paths) {
  return path.join(paths.launcherDir, 'report-config.json')
}

/** Replace only the known placeholders; anything else stays literal. */
export function renderTemplate(template, values = {}) {
  let text = String(template ?? '')
  for (const key of ['url', 'token', 'port', 'target', 'time']) {
    const value = values[key]
    text = text.split(`{${key}}`).join(value === undefined || value === null ? '' : String(value))
  }
  return text
}

/** Merge defaults field by field; unknown keys are dropped. */
export function normalizeReportConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const report = source.report && typeof source.report === 'object' ? source.report : {}
  const webhook = source.webhook && typeof source.webhook === 'object' ? source.webhook : {}
  const network = source.network && typeof source.network === 'object' ? source.network : {}
  return {
    report: {
      browser: report.browser !== false,
      clipboard: report.clipboard !== false,
      dialog: report.dialog !== false,
      webhook: report.webhook === true,
    },
    webhook: {
      url: typeof webhook.url === 'string' ? webhook.url.trim() : '',
      template: typeof webhook.template === 'string' && webhook.template.trim() !== ''
        ? webhook.template
        : DEFAULT_REPORT_CONFIG.webhook.template,
    },
    network: {
      // An explicit empty list means "publish nowhere"; an absent list has no
      // machine-independent default to fall back to either.
      addresses: Array.isArray(network.addresses)
        ? network.addresses.map((address) => String(address ?? '').trim()).filter(Boolean)
        : [],
      loopbackOnly: network.loopbackOnly === true,
    },
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Empty array means valid; each entry is a Chinese reason. */
export function validateReportConfig(config) {
  const problems = []
  const { url, template } = config?.webhook ?? {}
  if (url && !/^https?:\/\//i.test(url)) {
    problems.push('API 地址必须以 http:// 或 https:// 开头')
  }
  const rendered = renderTemplate(template ?? '', TEMPLATE_SAMPLE)
  try {
    JSON.parse(rendered)
  } catch {
    problems.push('JSON 模板替换占位符后不是合法的 JSON')
  }
  for (const address of config?.network?.addresses ?? []) {
    if (address === '0.0.0.0') {
      problems.push('监听地址不能是 0.0.0.0：DSH 不允许监听全部网卡')
      continue
    }
    const match = IPV4.exec(address)
    if (!match || match.slice(1).some((part) => Number(part) > 255)) {
      problems.push(`监听地址不是合法的 IPv4：${address}`)
    }
  }
  return problems
}

/** Missing or corrupt reads as the defaults, never as an error. */
export async function readReportConfig(file) {
  try {
    return normalizeReportConfig(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return normalizeReportConfig(null)
  }
}

/** Atomic write: a crash never leaves a half file behind. */
export async function writeReportConfig(file, config) {
  const normalized = normalizeReportConfig(config)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8')
  await fs.rename(tmp, file)
  return normalized
}
