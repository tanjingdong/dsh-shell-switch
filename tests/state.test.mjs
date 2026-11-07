import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readState, writeState, clearState } from '../src/state.mjs'

test('state round-trips and a corrupt file reads as null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshstate-'))
  const file = join(dir, 'state.json')
  assert.equal(await readState(file), null)
  const state = { mode: 'web', pid: 42, port: 3080, startedAt: '2026-11-07T00:00:00.000Z' }
  await writeState(file, state)
  assert.deepEqual(await readState(file), state)
  await clearState(file)
  assert.equal(await readState(file), null)
})
