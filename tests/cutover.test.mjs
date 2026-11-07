import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, lstat, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyCutover, parseCutoverArgs, planCutover, revertCutover, verifyCutover,
} from '../setup/cutover.mjs'

async function profileRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dshcut-'))
  await mkdir(join(root, 'desktop'))
  return root
}

test('cutover renames a real dir to a backup and creates a junction', async () => {
  const root = await profileRoot()
  await mkdir(join(root, 'web'))
  await writeFile(join(root, 'web', 'package.json'), '{}')
  const { backupPath } = await applyCutover({ profilesDir: root, now: '20261107-120000' })
  assert.equal(backupPath, join(root, 'web.bak-20261107-120000'))
  assert.equal((await lstat(join(root, 'web'))).isSymbolicLink(), true)
})

test('cutover is idempotent when web is already a junction', async () => {
  const root = await profileRoot()
  await applyCutover({ profilesDir: root, now: 'x' })
  const again = await applyCutover({ profilesDir: root, now: 'y' })
  assert.equal(again.backupPath, null)
  assert.deepEqual((await planCutover({ profilesDir: root, now: 'z' })).steps, [])
})

test('cutover repairs a junction that points somewhere else', async () => {
  const root = await profileRoot()
  await mkdir(join(root, 'other'))
  await symlink(join(root, 'other'), join(root, 'web'), 'junction')
  assert.deepEqual((await planCutover({ profilesDir: root, now: 'x' })).steps, ['rename-backup', 'create-junction'])
  await assert.rejects(verifyCutover({ profilesDir: root }), /应指向/)
})

test('a repair ends with a verified junction to desktop', async () => {
  const root = await profileRoot()
  await mkdir(join(root, 'other'))
  await symlink(join(root, 'other'), join(root, 'web'), 'junction')
  const plan = await applyCutover({ profilesDir: root, now: 'fix' })
  assert.equal(plan.backupPath, join(root, 'web.bak-fix'))
  assert.equal(await verifyCutover({ profilesDir: root }), true)
})

test('cutover refuses to touch profiles while a shell is open', async () => {
  const root = await profileRoot()
  await mkdir(join(root, 'web'))
  await assert.rejects(
    applyCutover({ profilesDir: root, now: 'x', detect: async () => 'client' }),
    /先关闭/,
  )
  assert.equal((await lstat(join(root, 'web'))).isSymbolicLink(), false)
})

test('revertCutover restores the directory that was backed up', async () => {
  const root = await profileRoot()
  await mkdir(join(root, 'web'))
  await writeFile(join(root, 'web', 'package.json'), '{"kept":true}')
  const { backupPath } = await applyCutover({ profilesDir: root, now: 'r' })
  await revertCutover({ profilesDir: root, backupPath })
  assert.equal((await lstat(join(root, 'web'))).isSymbolicLink(), false)
  assert.match(await readFile(join(root, 'web', 'package.json'), 'utf8'), /kept/)
})

test('parseCutoverArgs reads the revert backup path', () => {
  assert.deepEqual(parseCutoverArgs([]), { revert: null })
  assert.deepEqual(parseCutoverArgs(['--revert', 'C:\\backup']), { revert: 'C:\\backup' })
  assert.throws(() => parseCutoverArgs(['--nope']), /未知参数/)
})
