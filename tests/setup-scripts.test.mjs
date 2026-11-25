import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('../', import.meta.url)
const bytesOf = (name) => fs.readFileSync(new URL(name, root))
const textOf = (name) => bytesOf(name).toString('utf8')

// A LF-only batch file is mis-parsed by cmd.exe ("'nu' is not recognized"):
// CRLF and ASCII are not style preferences here, they are correctness.
test('the batch entry points stay ASCII and CRLF', () => {
  for (const name of ['install.cmd', 'uninstall.cmd']) {
    const bytes = bytesOf(name)
    assert.ok([...bytes].every((byte) => byte < 0x80), `${name} must be ASCII`)
    const text = bytes.toString('latin1')
    assert.ok(!/(^|[^\r])\n/.test(text), `${name} must use CRLF line endings`)
    assert.match(text, /%~dp0/, `${name} must work from its own folder`)
    assert.match(text, /pause/i, `${name} must keep the window open`)
  }
})

test('the batch files only pick a runtime and hand off to JavaScript', () => {
  for (const [name, mode] of [['install.cmd', ''], ['uninstall.cmd', '--uninstall']]) {
    const text = textOf(name)
    assert.match(text, /setup\\wizard\.mjs/, `${name} must run the wizard`)
    if (mode) assert.ok(text.includes(mode), `${name} must pass ${mode}`)
    assert.match(text, /where node/, `${name} must look for node on PATH`)
    assert.match(text, /ELECTRON_RUN_AS_NODE/, `${name} must fall back to the app runtime`)
    assert.match(text, /DSH_APP/, `${name} must allow an app path override`)
  }
})

test('no PowerShell is left in the install path', () => {
  for (const name of ['install.ps1', 'uninstall.ps1', 'setup/common.ps1']) {
    assert.equal(fs.existsSync(new URL(name, root)), false, `${name} should be gone`)
  }
})

test('the wizard is plain JavaScript and downloads nothing', () => {
  const code = textOf('setup/wizard.mjs')
  for (const banned of ['Invoke-WebRequest', 'Start-BitsTransfer', 'curl ', 'wget ']) {
    assert.ok(!code.includes(banned), `wizard must not download (${banned})`)
  }
  for (const expected of ['runWizard', 'applyCutover', 'install', 'uninstall', 'detectCurrent', 'stopEverything']) {
    assert.ok(code.includes(expected), `wizard must mention ${expected}`)
  }
})
