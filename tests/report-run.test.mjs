import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runReport } from '../src/cli.mjs'
import { DEFAULT_REPORT_CONFIG } from '../src/report-config.mjs'

const paths = { launcherDir: 'L', logDir: 'L' }
const info = { target: 'web', port: 3080, url: 'http://h/?token=t' }

test('a successful switch reports once with the resolved config', async () => {
  const seen = []
  await runReport({
    paths,
    info,
    deps: {
      read: async () => DEFAULT_REPORT_CONFIG,
      report: async (args) => seen.push(args),
    },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].info.url, 'http://h/?token=t')
  assert.equal(seen[0].config.report.clipboard, true)
  assert.equal(typeof seen[0].copy, 'function')
  assert.equal(typeof seen[0].dialog, 'function')
  assert.equal(typeof seen[0].send, 'function')
})

test('a report failure is logged and never throws into the switch', async () => {
  const lines = []
  const result = await runReport({
    paths,
    info,
    deps: {
      read: async () => DEFAULT_REPORT_CONFIG,
      report: async () => { throw new Error('boom') },
      log: (line) => lines.push(line),
    },
  })
  assert.equal(result, null)
  assert.match(lines[0], /上报失败/)
})

test('an unreadable config still reports with the defaults', async () => {
  const seen = []
  await runReport({
    paths,
    info,
    deps: {
      read: async () => DEFAULT_REPORT_CONFIG,
      report: async (args) => seen.push(args),
    },
  })
  assert.equal(seen[0].config.report.webhook, false)
})
