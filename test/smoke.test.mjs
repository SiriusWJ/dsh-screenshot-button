/**
 * dsh-screenshot-button 冒烟测试（无第三方依赖，`node --test test/` 直接跑）。
 *
 * 宿主端：不启动真实截图工具，只验证路由的鉴权/方法/404/health 行为。
 * 客户端：用桩 ModuleLoader / react / document 跑一遍工厂与 apply，
 *         校验按钮确实注册进 `conversation.input.left` 并能渲染出 <button>。
 *
 * 每次升级 DSH 后先跑这里，再考虑是否需要真机点一次按钮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 造一个 req/res 调用宿主路由，返回 { status, headers, body }。 */
function callRoute(handler, url, method, headers) {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: null,
      body: '',
      writeHead(status, value) {
        this.status = status
        this.headers = value
      },
      end(chunk) {
        this.body = chunk ?? ''
        resolve({ status: this.status, headers: this.headers, body: this.body })
      },
    }
    handler({ url, method, headers }, res)
  })
}

const LOOPBACK = { host: '127.0.0.1:50055' }

test('host: routes reject foreign callers and answer health', async () => {
  const mod = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  assert.equal(mod.name, 'dsh-screenshot-button')
  assert.ok(mod.inject.includes('webServer'), 'plugin must inject webServer')

  let handler = null
  let disposer = null
  mod.apply({
    webServer: { register: (row) => { handler = row.handler; return () => {} } },
    effect: (fn) => { disposer = fn() },
  })
  assert.equal(typeof handler, 'function', 'webServer.register was not called')
  assert.equal(typeof disposer, 'function', 'ctx.effect must return a disposer')

  let reply = await callRoute(handler, '/dsh-screenshot/health', 'GET', LOOPBACK)
  assert.equal(reply.status, 200)
  const health = JSON.parse(reply.body)
  assert.equal(health.ok, true)
  assert.equal(typeof health.value.platform, 'string')
  assert.ok(Array.isArray(health.value.launchers))

  reply = await callRoute(handler, '/dsh-screenshot/health', 'POST', LOOPBACK)
  assert.equal(reply.status, 405)

  reply = await callRoute(handler, '/dsh-screenshot/unknown', 'GET', LOOPBACK)
  assert.equal(reply.status, 404)

  reply = await callRoute(handler, '/dsh-screenshot/capture', 'POST', { host: 'evil.example.com' })
  assert.equal(reply.status, 403)

  reply = await callRoute(handler, '/dsh-screenshot/capture', 'POST', { ...LOOPBACK, origin: 'http://evil.example.com' })
  assert.equal(reply.status, 403)

  reply = await callRoute(handler, '/dsh-screenshot/capture', 'POST', { ...LOOPBACK, 'sec-fetch-site': 'cross-site' })
  assert.equal(reply.status, 403)

  reply = await callRoute(handler, '/dsh-screenshot/health', 'GET', { host: '[::1]:50055' })
  assert.equal(reply.status, 200)

  reply = await callRoute(handler, '/dsh-screenshot/health', 'GET', { host: '10.0.0.5:50055' })
  assert.equal(reply.status, 403)
})

test('client: registers the composer button into conversation.input.left', async () => {
  const styleTags = []
  const elements = []
  let loaderCall = null

  globalThis.document = {
    documentElement: { lang: 'zh' },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: (tag) => styleTags.push(tag) },
  }
  globalThis.window = {
    clearTimeout: () => {},
    setTimeout: () => 0,
    __ModuleLoader__: { load: (definition) => { loaderCall = definition } },
  }

  const react = {
    createElement: (type, props, ...children) => {
      const node = { type, props: props ?? {}, children: children.flat() }
      elements.push(node)
      return node
    },
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }

  await import(pathToFileURL(join(root, 'client/client.js')).href)
  assert.ok(loaderCall, 'window.__ModuleLoader__.load was not called')
  assert.equal(loaderCall.id, 'dsh-screenshot-button')

  const mod = loaderCall.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  assert.ok(mod.inject.includes('slots'))

  let injectedName = null
  let registered = null
  mod.apply({
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject: (name, callback) => { injectedName = name; callback(); return () => {} },
      register: (definition, component) => { registered = { definition, component }; return () => {} },
    },
  })

  assert.equal(injectedName, 'conversation.input.left')
  assert.equal(registered.definition.name, 'conversation.input.left')
  assert.equal(registered.definition.id, 'dsh-screenshot-button')
  assert.equal(typeof registered.definition.order, 'number')
  assert.equal(typeof registered.definition.label, 'function')

  const tree = registered.component({})
  assert.equal(tree.type, 'div')
  const button = tree.children.find((child) => child?.type === 'button')
  assert.ok(button, 'component did not render a <button>')
  assert.equal(button.props.type, 'button')
  assert.equal(typeof button.props.title, 'string')
  assert.equal(button.props.disabled, false)
  assert.equal(typeof button.props.onClick, 'function')
  assert.ok(styleTags.length > 0, 'styles were not injected')
})
