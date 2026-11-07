import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLogger, logFilePath } from '../src/log.mjs'

test('logFilePath stamps the file into the launcher log directory', () => {
  const file = logFilePath({ logDir: 'C:\\u\\.dsh\\launcher\\logs' }, new Date(2026, 10, 7, 9, 5, 3))
  assert.equal(file, 'C:\\u\\.dsh\\launcher\\logs\\20261107-090503.log')
})

test('the logger tees every line to stdout, stderr and the log file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshlog-'))
  const lines = []
  const logDir = join(root, 'logs')
  const logger = createLogger({
    paths: { logDir },
    now: new Date(2026, 10, 7, 12, 0, 0),
    out: { write: (line) => lines.push(line.trimEnd()) },
    err: { write: (line) => lines.push(`E:${line.trimEnd()}`) },
  })
  logger.log('hello')
  logger.error('boom')
  logger.close()
  assert.deepEqual(lines, ['hello', 'E:boom'])
  assert.equal(await readFile(join(logDir, '20261107-120000.log'), 'utf8'), 'hello\nboom\n')
})

test('an unusable log directory still prints instead of throwing', async () => {
  const lines = []
  const logger = createLogger({
    paths: { logDir: join(tmpdir(), 'dshlog-missing-parent', 'deep', 'x') },
    out: { write: (line) => lines.push(line.trimEnd()) },
    err: { write: (line) => lines.push(line.trimEnd()) },
    open: () => { throw new Error('denied') },
  })
  logger.log('still visible')
  assert.deepEqual(lines, ['still visible'])
})
