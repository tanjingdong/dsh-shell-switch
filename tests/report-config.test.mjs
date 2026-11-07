import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_REPORT_CONFIG, normalizeReportConfig, readReportConfig, renderTemplate,
  validateReportConfig, writeReportConfig,
} from '../src/report-config.mjs'

test('a missing or corrupt config file falls back to the defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshcfg-'))
  assert.deepEqual(await readReportConfig(join(root, 'nope.json')), DEFAULT_REPORT_CONFIG)
  await writeFile(join(root, 'bad.json'), '{oops')
  assert.deepEqual(await readReportConfig(join(root, 'bad.json')), DEFAULT_REPORT_CONFIG)
})

test('normalizeReportConfig keeps known keys and ignores junk', () => {
  const config = normalizeReportConfig({
    report: { clipboard: false, webhook: true },
    webhook: { url: '  http://x  ', template: '{"a":1}' },
    extra: true,
  })
  assert.deepEqual(config, {
    report: { clipboard: false, dialog: true, webhook: true },
    webhook: { url: 'http://x', template: '{"a":1}' },
    network: { addresses: ['192.168.0.106', '10.147.20.214', '100.100.0.3'], loopbackOnly: false },
  })
})

test('validation rejects a non-http url and a non-JSON template', () => {
  assert.deepEqual(validateReportConfig(normalizeReportConfig(DEFAULT_REPORT_CONFIG)), [])
  assert.match(
    validateReportConfig(normalizeReportConfig({ ...DEFAULT_REPORT_CONFIG, webhook: { url: 'ftp://x', template: '{}' } })).join(),
    /http/,
  )
  assert.match(
    validateReportConfig(normalizeReportConfig({ ...DEFAULT_REPORT_CONFIG, webhook: { url: '', template: '{oops' } })).join(),
    /JSON/,
  )
})

test('an unquoted number placeholder is still valid JSON after rendering', () => {
  const config = normalizeReportConfig({ webhook: { url: '', template: '{"n": {port}}' } })
  assert.deepEqual(validateReportConfig(config), [])
})

test('network defaults to the three LAN addresses with the relay enabled', () => {
  assert.deepEqual(DEFAULT_REPORT_CONFIG.network.addresses, ['192.168.0.106', '10.147.20.214', '100.100.0.3'])
  assert.equal(DEFAULT_REPORT_CONFIG.network.loopbackOnly, false)
})

test('normalizeReportConfig trims and de-duplicates nothing, just cleans blanks', () => {
  const config = normalizeReportConfig({ network: { addresses: [' 10.0.0.1 ', '', '  '], loopbackOnly: true } })
  assert.deepEqual(config.network, { addresses: ['10.0.0.1'], loopbackOnly: true })
})

test('validation rejects 0.0.0.0 and anything that is not an IPv4 address', () => {
  const validate = (network) => validateReportConfig(normalizeReportConfig({ network })).join()
  assert.match(validate({ addresses: ['0.0.0.0'] }), /0\.0\.0\.0/)
  assert.match(validate({ addresses: ['not-an-ip'] }), /IPv4/)
  assert.deepEqual(validate({ addresses: [] }), '')
})

test('renderTemplate replaces only the known placeholders', () => {
  assert.equal(
    renderTemplate('{"u":"{url}","x":"{nope}"}', { url: 'http://h/?token=t' }),
    '{"u":"http://h/?token=t","x":"{nope}"}',
  )
  assert.equal(renderTemplate('{"u":"{url}"}', {}), '{"u":""}')
})

test('the file is written atomically and round-trips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshcfg-'))
  const file = join(root, 'report-config.json')
  await writeReportConfig(file, {
    report: { clipboard: false, dialog: true, webhook: false },
    webhook: { url: 'http://example.test/hook', template: '{"text":"{target}"}' },
  })
  const read = await readReportConfig(file)
  assert.equal(read.report.clipboard, false)
  assert.equal(read.webhook.url, 'http://example.test/hook')
  assert.match(await readFile(file, 'utf8'), /example\.test/)
})
