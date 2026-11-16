import assert from 'node:assert/strict'
import test from 'node:test'

import { readMacSystemProxy, readWindowsSystemProxy } from '../lib/system-proxy.js'

const SCUTIL_SAMPLE = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : <local>
  }
  HTTPEnable : 1
  HTTPPort : 18275
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 18275
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 18275
  SOCKSProxy : 127.0.0.1
}`

test('readMacSystemProxy returns the macOS route and its source label', async () => {
  const reading = await readMacSystemProxy(async () => SCUTIL_SAMPLE)
  assert.equal(reading.platform, 'macos')
  assert.equal(reading.source, 'macos-system-proxy')
  assert.equal(reading.url, 'http://127.0.0.1:18275')
  assert.equal(reading.disabled, false)
  assert.deepEqual(reading.overrideEntries, [])
})

test('readMacSystemProxy reports an unreadable scutil output', async () => {
  const reading = await readMacSystemProxy(async () => undefined)
  assert.equal(reading.unreadable, true)
  assert.equal(reading.url, undefined)
})

test('readMacSystemProxy reports a SOCKS-only setting', async () => {
  const reading = await readMacSystemProxy(async () => `
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}`)
  assert.equal(reading.disabled, true)
  assert.equal(reading.socksOnly, true)
  assert.equal(reading.url, undefined)
})

test('readWindowsSystemProxy prefers the https= entry and keeps usable overrides', async () => {
  const values = {
    ProxyEnable: '0x1',
    ProxyServer: 'http=127.0.0.1:7890;https=127.0.0.1:7891',
    ProxyOverride: '127.0.0.1;localhost;*.local;10.0.0.0/8;<local>;foo.com',
  }
  const reading = await readWindowsSystemProxy(async name => values[name])
  assert.equal(reading.platform, 'windows')
  assert.equal(reading.source, 'windows-system-proxy')
  assert.equal(reading.url, 'http://127.0.0.1:7891')
  assert.deepEqual(reading.overrideEntries, ['*.local', 'foo.com'])
})

test('readWindowsSystemProxy treats ProxyEnable = 0 as switched off', async () => {
  const reading = await readWindowsSystemProxy(async name =>
    name === 'ProxyEnable' ? '0x0' : name === 'ProxyServer' ? '127.0.0.1:7890' : undefined,
  )
  assert.equal(reading.disabled, true)
  assert.equal(reading.url, undefined)
  assert.deepEqual(reading.overrideEntries, [])
})

test('readWindowsSystemProxy flags an unusable ProxyServer value', async () => {
  const values = { ProxyEnable: '0x1', ProxyServer: 'not a proxy', ProxyOverride: '' }
  const reading = await readWindowsSystemProxy(async name => values[name])
  assert.equal(reading.url, undefined)
  assert.equal(reading.invalid, true)
})
