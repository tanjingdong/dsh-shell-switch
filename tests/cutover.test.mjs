import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyCutover, planCutover } from '../setup/cutover.mjs'

test('cutover renames a real dir to a backup and creates a junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshcut-'))
  await mkdir(join(root, 'desktop'))
  await mkdir(join(root, 'web'))
  await writeFile(join(root, 'web', 'package.json'), '{}')
  const { backupPath } = await applyCutover({ profilesDir: root, now: '20261107-120000' })
  assert.equal(backupPath, join(root, 'web.bak-20261107-120000'))
  assert.equal((await lstat(join(root, 'web'))).isSymbolicLink(), true)
})

test('cutover is idempotent when web is already a junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshcut2-'))
  await mkdir(join(root, 'desktop'))
  await applyCutover({ profilesDir: root, now: 'x' })
  const again = await applyCutover({ profilesDir: root, now: 'y' })
  assert.equal(again.backupPath, null)
  assert.deepEqual((await planCutover({ profilesDir: root, now: 'z' })).steps, [])
})
