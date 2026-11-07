import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, renderMenu } from '../src/cli.mjs'

test('parseArgs defaults to menu and accepts --force', () => {
  assert.deepEqual(parseArgs([]), { command: 'menu', force: false })
  assert.deepEqual(parseArgs(['web', '--force']), { command: 'web', force: true })
  assert.deepEqual(parseArgs(['client']), { command: 'client', force: false })
  assert.throws(() => parseArgs(['nope']), (e) => e.code === 'bad-args')
})

test('renderMenu lists the four choices', () => {
  const menu = renderMenu()
  assert.match(menu, /1\).*客户端/)
  assert.match(menu, /2\).*Web/)
  assert.match(menu, /3\).*状态/)
  assert.match(menu, /4\).*停止/)
})
