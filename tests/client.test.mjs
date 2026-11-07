import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

/** Load the browser bundle the host loads, without a DOM or a real react. */
function loadBundle(globals = {}) {
  const code = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  let entry = null
  const window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  vm.runInNewContext(code, { window, ...globals })
  assert.ok(entry, 'the bundle must register itself with __ModuleLoader__')
  return entry
}

function fakeReact({ firstState = true } = {}) {
  const states = []
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const index = states.length
      states.push(initial)
      // Entry's first hook is its `open` flag; only that one is forced.
      return [index === 0 && firstState ? true : initial, () => {}]
    },
  }
}

/** Render through the slots registry and expand function components. */
function mountBundle(bundle, options = {}) {
  const react = fakeReact(options)
  const module = bundle.factory((name) => {
    assert.equal(name, 'react')
    return react
  })
  const registrations = []
  module.apply({
    slots: {
      register: (options2, render) => { registrations.push({ ...options2, render }); return () => {} },
      inject: (name, mount) => { mount(); return () => {} },
    },
  })
  return registrations
}

function renderEntry(bundle) {
  const sidebar = mountBundle(bundle).find((entry) => entry.name === 'sidebar.footer.action')
  assert.ok(sidebar, 'apply must mount a sidebar entry')
  return expand(sidebar.render())
}

function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type({ ...node.props }))
  return { type: node.type, props: node.props, children: (node.children ?? []).map(expand) }
}

function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = find(item, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return null
}

function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) texts(item, out)
    return out
  }
  for (const child of node.children ?? []) texts(child, out)
  return out
}

function panelOf(tree) {
  return find(tree, (node) => node?.props?.style?.position === 'fixed')
}

test('the panel sets its own readable colors instead of inheriting the host theme', () => {
  const panel = panelOf(renderEntry(loadBundle()))
  assert.ok(panel, 'the opened panel must render')
  const style = panel.props.style
  assert.notEqual(style.color, 'inherit')
  assert.equal(typeof style.color, 'string')
  assert.equal(typeof style.background, 'string')
  assert.notEqual(style.color.trim().toLowerCase(), style.background.trim().toLowerCase())
})

test('the sidebar trigger keeps the host text color so the arrow stays visible', () => {
  const tree = renderEntry(loadBundle())
  const trigger = find(tree, (node) => (
    node?.type === 'button' && node?.props?.['aria-label'] === '切换外壳'
  ))
  assert.ok(trigger, 'the sidebar trigger must render')
  assert.equal(trigger.props.style.color, 'inherit')
})

test('the bundle registers a row config page for its own row', () => {
  const row = mountBundle(loadBundle()).find((entry) => entry.name === 'plugins.row.config')
  assert.ok(row, 'must register into plugins.row.config')
  assert.equal(row.key, 'dsh-shell-switch#dsh-shell-switch')
})

test('the row config page renders the three channels and the webhook fields', () => {
  const bundle = loadBundle({
    fetch: async () => ({
      ok: true,
      json: async () => ({ report: { clipboard: true, dialog: true, webhook: false }, webhook: { url: '', template: '{}' } }),
    }),
  })
  const row = mountBundle(bundle, { firstState: false })
    .find((entry) => entry.name === 'plugins.row.config')
  const tree = expand(row.render({ view: 'page' }))
  const words = texts(tree)
  for (const expected of ['复制到剪贴板', '弹窗', '发送到网络', 'API 地址', 'JSON 模板', '保存', '发送测试']) {
    assert.ok(words.includes(expected), `missing ${expected}: ${JSON.stringify(words)}`)
  }
  assert.ok(words.some((word) => word.includes('{url}')), 'placeholder help missing')
})

test('the row config page answers the summary view with a label', () => {
  const row = mountBundle(loadBundle(), { firstState: false })
    .find((entry) => entry.name === 'plugins.row.config')
  assert.equal(row.render({ view: 'summary' }), '外壳切换')
})

test('the panel offers both shells and a close action', () => {
  const words = texts(renderEntry(loadBundle()))
  assert.ok(words.includes('切换外壳'), `panel title missing: ${JSON.stringify(words)}`)
  assert.ok(words.includes('桌面客户端'), `client choice missing: ${JSON.stringify(words)}`)
  assert.ok(words.includes('浏览器 Web'), `web choice missing: ${JSON.stringify(words)}`)
  assert.ok(words.includes('关闭'), `close action missing: ${JSON.stringify(words)}`)
})
