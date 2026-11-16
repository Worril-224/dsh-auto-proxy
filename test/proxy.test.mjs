import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasProxyCredentials,
  maskCredentialsInText,
  maskProxyUrl,
  normalizeProxyUrl,
  parseBypassList,
  parseProxyServer,
  parseScutilProxy,
  shExports,
  shellQuote,
} from '../lib/proxy.js'

const SCUTIL_SAMPLE = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : <local>
  }
  FTPPassive : 1
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

test('normalizeProxyUrl accepts http(s) hosts and adds a default scheme', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:18275'), 'http://127.0.0.1:18275')
  assert.equal(normalizeProxyUrl('http://127.0.0.1:18275/'), 'http://127.0.0.1:18275')
  assert.equal(normalizeProxyUrl('https://user:pass@example.test:8080/'), 'https://user:pass@example.test:8080')
  assert.equal(normalizeProxyUrl('http://example.test:8080/path/'), 'http://example.test:8080/path/')
})

test('normalizeProxyUrl rejects non-http schemes and junk', () => {
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), undefined)
  assert.equal(normalizeProxyUrl('pac+http://example.test/proxy.pac'), undefined)
  assert.equal(normalizeProxyUrl(''), undefined)
  assert.equal(normalizeProxyUrl(undefined), undefined)
  assert.equal(normalizeProxyUrl(null), undefined)
})

test('maskProxyUrl never leaks credentials', () => {
  assert.equal(maskProxyUrl('http://alice:secret@127.0.0.1:8080'), 'http://***:***@127.0.0.1:8080')
  assert.equal(maskProxyUrl('https://alice@example.test:8443'), 'https://***:***@example.test:8443')
  assert.equal(maskProxyUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(hasProxyCredentials('http://alice:secret@127.0.0.1:8080'), true)
  assert.equal(hasProxyCredentials('http://127.0.0.1:8080'), false)
})

test('maskCredentialsInText sanitizes diagnostics and error messages', () => {
  assert.equal(
    maskCredentialsInText('failed through http://alice:secret@127.0.0.1:8080/proxy'),
    'failed through http://***:***@127.0.0.1:8080/proxy',
  )
  assert.equal(maskCredentialsInText('contact alice@example.test'), 'contact alice@example.test')
})

test('shExports masks credentials but keeps a pasteable placeholder', () => {
  const lines = shExports('http://alice:secret@127.0.0.1:8080', 'deepseek.com')
  assert.match(lines, /replace \*\*\* with the real username and password/)
  assert.match(lines, /export HTTPS_PROXY='http:\/\/\*\*\*:\*\*\*@127\.0\.0\.1:8080'/)
  assert.doesNotMatch(lines, /alice|secret/)
  assert.match(lines, /export NO_PROXY='deepseek\.com'/)
})

test('shExports leaves a credential-free URL untouched', () => {
  const lines = shExports('http://127.0.0.1:8080', '')
  assert.equal(lines, "export HTTPS_PROXY='http://127.0.0.1:8080'\nexport HTTP_PROXY='http://127.0.0.1:8080'")
})

test('shellQuote escapes embedded single quotes', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
})

test('parseProxyServer handles bare and per-scheme registry values', () => {
  assert.equal(parseProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(
    parseProxyServer('http=127.0.0.1:7890;https=127.0.0.2:7891'),
    'http://127.0.0.2:7891',
  )
  assert.equal(parseProxyServer('http=127.0.0.1:7890;socks=127.0.0.3:1080'), 'http://127.0.0.1:7890')
  assert.equal(parseProxyServer(''), undefined)
  assert.equal(parseProxyServer(undefined), undefined)
})

test('parseBypassList keeps supported wildcards and drops unmatchable entries', () => {
  assert.deepEqual(
    parseBypassList('127.0.0.1;localhost;*.local;10.0.0.0/8;middle.*.bar;*.example.com;foo.com;<local>'),
    ['*.local', '*.example.com', 'foo.com'],
  )
  assert.deepEqual(parseBypassList(['*.local', 'localhost', '<local>', '127.0.0.1']), ['*.local'])
  assert.deepEqual(parseBypassList('two words;ok.test'), ['ok.test'])
  assert.deepEqual(parseBypassList(''), [])
})

test('parseScutilProxy reads the real macOS HTTPS setting', () => {
  const parsed = parseScutilProxy(SCUTIL_SAMPLE)
  assert.equal(parsed.url, 'http://127.0.0.1:18275')
  assert.equal(parsed.disabled, false)
  assert.equal(parsed.socksOnly, false)
  assert.equal(parsed.invalid, false)
  assert.deepEqual(parsed.overrideEntries, [])
})

test('parseScutilProxy falls back to the HTTP entry when HTTPS is off', () => {
  const parsed = parseScutilProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 192.168.1.2
  HTTPSEnable : 0
}`)
  assert.equal(parsed.url, 'http://192.168.1.2:7890')
  assert.equal(parsed.disabled, false)
})

test('parseScutilProxy reports SOCKS-only, PAC, disabled, and broken settings', () => {
  const socksOnly = parseScutilProxy(`
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}`)
  assert.equal(socksOnly.disabled, true)
  assert.equal(socksOnly.socksOnly, true)
  assert.equal(socksOnly.url, undefined)

  const pac = parseScutilProxy(`
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
}`)
  assert.equal(pac.disabled, true)
  assert.equal(pac.pacEnabled, true)

  const broken = parseScutilProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 99999
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 1
  HTTPSProxy : <missing>
}`)
  assert.equal(broken.url, undefined)
  assert.equal(broken.invalid, true)
})

test('parseScutilProxy filters exception values through the shared bypass rules', () => {
  const parsed = parseScutilProxy(`
<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
    3 : 10.0.0.0/8
    4 : *.example.com
    5 : <local>
  }
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : 127.0.0.1
}`)
  assert.deepEqual(parsed.overrideEntries, ['*.local', '*.example.com'])
})
