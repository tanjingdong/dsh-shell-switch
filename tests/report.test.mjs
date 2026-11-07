import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWebhookBody, reportSwitch, sendWebhook } from '../src/report.mjs'
import { normalizeReportConfig } from '../src/report-config.mjs'

const base = normalizeReportConfig({
  report: { browser: true, clipboard: true, dialog: true, webhook: true },
  webhook: { url: 'http://example.test/hook', template: '{"text":"DSH 已切换到 {target}：{url}"}' },
})
const onlyClipboard = normalizeReportConfig({ report: { browser: false, clipboard: true, dialog: false, webhook: false } })
const info = { target: 'web', port: 3080, url: 'http://h/?token=t', token: 't', time: 'T' }

test('the browser opens only when its switch is on and there is a url', async () => {
  const calls = []
  await reportSwitch({
    config: base, info,
    open: async () => calls.push('open'),
    copy: async () => calls.push('copy'),
    dialog: async () => calls.push('dialog'),
    send: async () => calls.push('send'),
  })
  assert.equal(calls[0], 'open', 'the browser opens before the other channels')

  const noBrowser = []
  await reportSwitch({
    config: normalizeReportConfig({ report: { browser: false, clipboard: false, dialog: false, webhook: false } }),
    info,
    open: async () => noBrowser.push('open'),
  })
  assert.deepEqual(noBrowser, [])

  const noUrl = []
  await reportSwitch({
    config: normalizeReportConfig({ report: { browser: true, clipboard: false, dialog: false, webhook: false } }),
    info: { target: 'client', port: 4162 },
    open: async () => noUrl.push('open'),
  })
  assert.deepEqual(noUrl, [])
})

test('each channel runs only when its switch is on', async () => {
  const calls = []
  await reportSwitch({
    config: onlyClipboard,
    info,
    open: async () => calls.push('open'),
    copy: async () => calls.push('copy'),
    dialog: async () => calls.push('dialog'),
    send: async () => calls.push('send'),
  })
  assert.deepEqual(calls, ['copy'])
})

test('a failing channel does not stop the others', async () => {
  const calls = []
  const result = await reportSwitch({
    config: base,
    info,
    open: async () => calls.push('open'),
    copy: async () => { throw new Error('boom') },
    dialog: async () => calls.push('dialog'),
    send: async () => calls.push('send'),
  })
  assert.deepEqual(calls, ['open', 'dialog', 'send'])
  assert.equal(result.clipboard, 'failed')
})

test('with no url the clipboard and dialog channels are skipped, not failed', async () => {
  const result = await reportSwitch({
    config: base, info: { target: 'client', port: 4162 },
    copy: async () => { throw new Error('must not run') },
    dialog: async () => { throw new Error('must not run') },
    send: async () => ({ ok: true, status: 204 }),
  })
  assert.equal(result.clipboard, 'skipped')
  assert.equal(result.dialog, 'skipped')
  assert.equal(result.webhook, 'sent')
})

test('a client switch renders empty url and token, never undefined', () => {
  const body = buildWebhookBody(base, { target: 'client', port: 4162, time: 'T' })
  assert.ok(!body.includes('undefined'))
  assert.deepEqual(JSON.parse(body), { text: 'DSH 已切换到 client：' })
})

test('a template that is not JSON after rendering is refused', () => {
  const bad = normalizeReportConfig({ webhook: { url: 'http://x', template: '{oops' } })
  assert.throws(() => buildWebhookBody(bad, info), (error) => error.code === 'bad-template')
})

test('a failing webhook reports failure without throwing', async () => {
  const result = await sendWebhook({
    url: 'http://x',
    body: '{}',
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(result.ok, false)
})

test('a non-2xx webhook response is a failure but still resolves', async () => {
  const result = await sendWebhook({ url: 'http://x', body: '{}', fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.deepEqual(result, { ok: false, status: 500, error: 'HTTP 500' })
})
