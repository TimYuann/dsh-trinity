import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT_URL = new URL('../../lib/client.js', import.meta.url)
const PACKAGE_URL = new URL('../../package.json', import.meta.url)
const CLIENT = readFileSync(CLIENT_URL, 'utf8')
const PACKAGE = JSON.parse(readFileSync(PACKAGE_URL, 'utf8'))

function loadClientModule() {
  let registration = null
  const sandbox = {
    URL,
    window: {
      __ModuleLoader__: {
        load(value) { registration = value },
      },
    },
  }
  vm.runInNewContext(CLIENT, sandbox, { filename: 'lib/client.js' })
  assert.ok(registration, 'client registers through window.__ModuleLoader__')

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } }
    },
  }
  const module = registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-slots') return {}
    throw new Error(`unexpected client require: ${specifier}`)
  })
  return { registration, module }
}

test('DSH 0.1.7: dsh.client declares platform metadata, not Cordis service names', () => {
  assert.deepEqual(PACKAGE.dsh.client, { platform: 'web' })
  assert.equal('inject' in PACKAGE.dsh.client, false,
    'manifest inject is for package dependencies; client Cordis services belong on the factory export')
})

test('DSH 0.1.7: provider UI lives on the owning Plugins row', () => {
  assert.match(CLIENT, /ctx\.slots\.inject\("plugins\.row\.config"/)
  assert.match(CLIENT, /name:\s*"plugins\.row\.config"/)
  assert.match(CLIENT, /key:\s*"dsh-trinity#web-access-chain"/)
  assert.equal(CLIENT.includes('settings.section'), false,
    'plugin-owned configuration must not register the legacy Settings navigation section')
})

test('DSH 0.1.7: client factory keeps Cordis service injection on the runtime export', () => {
  const { registration, module } = loadClientModule()
  assert.equal(registration.id, 'dsh-trinity')
  assert.deepEqual(Array.from(module.inject), ['slots', 'locale', 'remote', 'remote.credentials'])
  assert.equal(typeof module.apply, 'function')
})

test('DSH 0.1.7: slot registration exposes summary and page views', () => {
  const { module } = loadClientModule()
  let injectedName = null
  let slotOptions = null
  let render = null
  const ctx = {
    effect(fn) { return fn() },
    locale: {
      register() { return () => {} },
      bind() { return (key) => key },
    },
    remote: {
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: true, value: undefined }),
        unset: async () => ({ ok: true, value: undefined }),
      },
      $on() { return () => {} },
    },
    slots: {
      inject(name, register) {
        injectedName = name
        return register()
      },
      register(options, renderer) {
        slotOptions = options
        render = renderer
        return () => {}
      },
    },
  }

  module.apply(ctx)
  assert.equal(injectedName, 'plugins.row.config')
  assert.equal(slotOptions.key, 'dsh-trinity#web-access-chain')
  assert.equal(typeof render, 'function')

  const summary = render({ t: (key) => key, view: 'summary' })
  const page = render({ t: (key) => key, view: 'page' })
  assert.equal(summary.props.view, 'summary')
  assert.equal(page.props.view, 'page')
  assert.equal(summary.type, page.type, 'both views are owned by one control-center module')
})

test('control center exposes provider search, routing and diagnostics without an active secret probe', () => {
  assert.match(CLIENT, /providersTab:\s*"Providers"/)
  assert.match(CLIENT, /routingTab:\s*"Routing"/)
  assert.match(CLIENT, /diagnosticsTab:\s*"Diagnostics"/)
  assert.match(CLIENT, /type:\s*"search"/)
  assert.match(CLIENT, /checkStatus:\s*"Refresh status"/)
  assert.match(CLIENT, /do not contact providers or incur usage/)
  assert.equal(/testBtn:\s*"Test"/.test(CLIENT), false,
    'metadata-only describe must not be presented as a provider network test')
})

test('client CSS and locale registrations are owned by ctx.effect for live unload', () => {
  assert.match(CLIENT, /function installStyle\(ctx\)[\s\S]+ctx\.effect\(function \(\)/)
  assert.match(CLIENT, /ctx\.effect\(function \(\) \{ return ctx\.locale\.register/)
})
