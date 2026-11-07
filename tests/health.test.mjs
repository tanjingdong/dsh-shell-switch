import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileHealth } from '../src/health.mjs'

test('a linked profile reports ok and no warning', async () => {
  const health = await profileHealth({ profilesDir: 'P', command: 'node cutover.mjs', verify: async () => true })
  assert.deepEqual(health, { linked: true, warning: null, command: 'node cutover.mjs' })
})

test('an unlinked profile says so and carries the command to run', async () => {
  const health = await profileHealth({
    profilesDir: 'P',
    command: 'node setup\\cutover.mjs',
    verify: async () => { throw new Error('web 不是联接：P\\web') },
  })
  assert.equal(health.linked, false)
  assert.equal(
    health.warning,
    'web profile 还没有和 desktop 链接（web 不是联接：P\\web）。两个外壳现在不会共享插件与设置；'
    + '先关掉两个外壳，再运行下面的命令。',
  )
  assert.equal(health.command, 'node setup\\cutover.mjs')
})
