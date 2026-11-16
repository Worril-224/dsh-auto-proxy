import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig, normalizeInterval } from '../lib/config.js'
import { DEFAULT_NO_PROXY, DEFAULT_REFRESH_MS, MAX_REFRESH_MS } from '../lib/proxy.js'

test('normalizeConfig supplies safe defaults', () => {
  const config = normalizeConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.autoDetect, true)
  assert.equal(config.proxyUrl, '')
  assert.equal(config.noProxy, DEFAULT_NO_PROXY)
  assert.equal(config.nodeUseEnvProxy, true)
  assert.equal(config.refreshIntervalMs, DEFAULT_REFRESH_MS)
  assert.deepEqual(config.notes, [])
})

test('normalizeConfig treats an empty noProxy as the protected default', () => {
  assert.equal(normalizeConfig({ noProxy: '' }).noProxy, DEFAULT_NO_PROXY)
  assert.equal(normalizeConfig({ noProxy: '   ' }).noProxy, DEFAULT_NO_PROXY)
  assert.equal(normalizeConfig({ noProxy: 'localhost, example.test' }).noProxy, 'localhost, example.test')
})

test('normalizeInterval treats blank YAML values as the default, not as zero', () => {
  assert.equal(normalizeInterval(null), DEFAULT_REFRESH_MS)
  assert.equal(normalizeInterval(undefined), DEFAULT_REFRESH_MS)
  assert.equal(normalizeInterval(''), DEFAULT_REFRESH_MS)
  assert.equal(normalizeInterval(0), 0)
  assert.equal(normalizeInterval('3000'), 3000)
  assert.equal(normalizeInterval(-5), 0)
  assert.equal(normalizeInterval(MAX_REFRESH_MS * 10), MAX_REFRESH_MS)
  assert.equal(normalizeInterval('nope'), DEFAULT_REFRESH_MS)
})

test('normalizeConfig validates proxyUrl and records a diagnostic', () => {
  const socks = normalizeConfig({ proxyUrl: 'socks5://127.0.0.1:1080' })
  assert.equal(socks.proxyUrl, '')
  assert.equal(socks.notes.length, 1)
  assert.match(socks.notes[0], /not an http\(s\) proxy URL/)

  const secret = normalizeConfig({ proxyUrl: 'socks5://alice:secret@127.0.0.1:1080' })
  assert.equal(secret.proxyUrl, '')
  assert.doesNotMatch(secret.notes[0], /alice|secret/)
  assert.match(secret.notes[0], /\*\*\*:\*\*\*@/)

  const pinned = normalizeConfig({ proxyUrl: '127.0.0.1:7890' })
  assert.equal(pinned.proxyUrl, 'http://127.0.0.1:7890')
  assert.deepEqual(pinned.notes, [])
})

test('normalizeConfig warns about credentials without printing them', () => {
  const config = normalizeConfig({ proxyUrl: 'http://alice:secret@127.0.0.1:8080' })
  assert.equal(config.proxyUrl, 'http://alice:secret@127.0.0.1:8080')
  assert.equal(config.notes.length, 1)
  assert.match(config.notes[0], /credentials/)
  assert.doesNotMatch(config.notes[0], /alice|secret/)
})

test('normalizeConfig accepts booleans as opt-out flags', () => {
  const config = normalizeConfig({
    enabled: false,
    autoDetect: false,
    nodeUseEnvProxy: false,
  })
  assert.equal(config.enabled, false)
  assert.equal(config.autoDetect, false)
  assert.equal(config.nodeUseEnvProxy, false)
})
