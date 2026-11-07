import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

/** Load the browser bundle the host loads, without a DOM or a real react. */
function loadBundle() {
  const code = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  let entry = null
  const window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  vm.runInNewContext(code, { window })
  assert.ok(entry, 'the bundle must register itself with __ModuleLoader__')
  return entry
}

function fakeReact() {
  const states = []
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const index = states.length
      states.push(initial)
      // The first hook is Entry's `open`; start it open so the panel renders.
      return [index === 0 ? true : initial, () => {}]
    },
  }
}

/** Render through the slots registry and expand function components. */
function renderEntry(bundle) {
  const react = fakeReact()
  const module = bundle.factory((name) => {
    assert.equal(name, 'react')
    return react
  })
  let element = null
  module.apply({
    slots: {
      register: (options, render) => { element = render() },
      inject: (name, mount) => mount(),
    },
  })
  assert.ok(element, 'apply must mount a sidebar entry')
  return expand(element)
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

test('the panel offers both shells and a close action', () => {
  const words = texts(renderEntry(loadBundle()))
  assert.ok(words.includes('切换外壳'), `panel title missing: ${JSON.stringify(words)}`)
  assert.ok(words.includes('桌面客户端'), `client choice missing: ${JSON.stringify(words)}`)
  assert.ok(words.includes('浏览器 Web'), `web choice missing: ${JSON.stringify(words)}`)
  assert.ok(words.includes('关闭'), `close action missing: ${JSON.stringify(words)}`)
})
