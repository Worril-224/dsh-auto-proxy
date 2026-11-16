/**
 * Pure proxy-URL, bypass-list, and SCUTIL parsing helpers.
 *
 * Everything here is deterministic and side-effect free, so the plugin's runtime behavior can be
 * tested without booting DSH or touching the host's network settings.
 *
 * @module @local/dsh-auto-proxy/lib/proxy
 */

/** Bypass entries always kept direct: the model API is domestic and must not depend on the proxy. */
export const DEFAULT_NO_PROXY = 'deepseek.com'

/** How often the detected route is re-checked, in milliseconds. */
export const DEFAULT_REFRESH_MS = 60_000

/** Upper bound accepted for `refreshIntervalMs` (one hour). */
export const MAX_REFRESH_MS = 3_600_000

/** Loopback spellings a proxy can never meaningfully reach; the policy package adds these itself. */
const LOOPBACK_BYPASS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  '0.0.0.0',
  '::',
])

/**
 * Accept only an `http:` or `https:` proxy URL, adding `http://` to a bare `host:port`.
 * @param {unknown} value - the candidate.
 * @returns {string | undefined} a usable proxy URL without a bare trailing slash.
 */
export function normalizeProxyUrl(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.hostname === '') return undefined
  const href = parsed.href
  return href.endsWith('/') && parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
    ? href.slice(0, -1)
    : href
}

/**
 * Whether a proxy URL carries a username or password.
 * @param {unknown} value - the candidate URL.
 * @returns {boolean} true when credentials are present.
 */
export function hasProxyCredentials(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const parsed = new URL(value)
    return parsed.username !== '' || parsed.password !== ''
  } catch {
    return false
  }
}

/**
 * Hide a proxy password before the value reaches the model, a tool result, or the session log.
 * @param {string} value - the proxy URL.
 * @returns {string} the URL with any credentials replaced by `***:***`.
 */
export function maskProxyUrl(value) {
  if (!hasProxyCredentials(value)) return value
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1***:***@')
}

/**
 * Quote one value for a POSIX shell assignment.
 * @param {string} value - the value to quote.
 * @returns {string} the single-quoted value.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Render the variables as shell lines, so a shell that predates the install can be repaired.
 * Credentials are never printed: the line keeps a `***:***` placeholder and a comment explains it.
 * @param {string} url - the proxy URL.
 * @param {string} noProxy - the bypass list.
 * @returns {string} newline-separated `export` lines.
 */
export function shExports(url, noProxy) {
  const value = maskProxyUrl(url)
  const lines = []
  if (value !== url) {
    lines.push(
      '# this proxy URL carries credentials; replace *** with the real username and password before pasting',
    )
  }
  lines.push(`export HTTPS_PROXY=${shellQuote(value)}`, `export HTTP_PROXY=${shellQuote(value)}`)
  if (noProxy !== '') lines.push(`export NO_PROXY=${shellQuote(noProxy)}`)
  return lines.join('\n')
}

/**
 * Hide credentials inside free-form text (diagnostics, thrown error messages) before it reaches a
 * tool result or the session log.
 * @param {unknown} value - the text to sanitize.
 * @returns {string} the text with `scheme://user:pass@` replaced by `scheme://***:***@`.
 */
export function maskCredentialsInText(value) {
  return String(value ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1***:***@')
}

/**
 * Turn a Windows `ProxyServer` value into one proxy URL: either a bare `host:port` or the
 * per-scheme `http=host:port;https=host:port` form. HTTPS wins, matching the macOS branch.
 * @param {string | undefined} raw - the registry value.
 * @returns {string | undefined} the proxy URL, or undefined when it names no usable proxy.
 */
export function parseProxyServer(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const value = raw.trim()
  if (!value.includes('=')) return normalizeProxyUrl(value)
  const perScheme = new Map()
  for (const piece of value.split(';')) {
    const separator = piece.indexOf('=')
    if (separator < 0) continue
    perScheme.set(piece.slice(0, separator).trim().toLowerCase(), piece.slice(separator + 1).trim())
  }
  return normalizeProxyUrl(perScheme.get('https') ?? perScheme.get('http') ?? '')
}

/**
 * Keep only the bypass entries the shipped policy can actually match.
 *
 * The policy matches an entry against a host and all of its subdomains, and accepts a leading `.`
 * or `*.` for the same meaning. Middle wildcards, CIDR notation, and whitespace cannot be matched,
 * and OS placeholders such as `<local>` are not host names, so those are dropped here instead of
 * being published as rules that silently match nothing.
 *
 * @param {string | string[] | undefined} raw - a `ProxyOverride` string or SCUTIL array values.
 * @returns {string[]} the usable entries, in input order, with case-insensitive duplicates removed.
 */
export function parseBypassList(raw) {
  /** @type {string[]} */
  const pieces = Array.isArray(raw)
    ? raw.map(piece => String(piece))
    : typeof raw === 'string'
      ? raw.split(/[;,\r\n]+/)
      : []
  /** @type {string[]} */
  const entries = []
  for (const piece of pieces) {
    const entry = piece.trim().replace(/^"|"$/g, '')
    if (!isUsableBypassEntry(entry)) continue
    if (!entries.some(existing => existing.toLowerCase() === entry.toLowerCase())) entries.push(entry)
  }
  return entries
}

/**
 * @param {string} entry - one trimmed bypass token.
 * @returns {boolean} true when the policy package can match this entry.
 */
function isUsableBypassEntry(entry) {
  if (entry === '' || entry.startsWith('<')) return false
  if (/[\s/]/.test(entry)) return false
  if (entry === '*') return false
  if (entry.includes('*') && !entry.startsWith('*.')) return false
  const lower = entry.replace(/^\[|\]$/g, '').toLowerCase()
  if (LOOPBACK_BYPASS.has(lower)) return false
  if (lower === 'localhost' || lower.endsWith('.localhost')) return false
  if (/^127\./.test(lower)) return false
  return true
}

/**
 * Parse the output of `scutil --proxy`.
 *
 * SCUTIL prints one `<dictionary>` with scalar keys and a nested `<array>` of exceptions. The
 * plugin prefers HTTPS, then HTTP, and always builds an `http://` proxy URL: the proxy itself
 * speaks an HTTP CONNECT tunnel, and a `socks5://` value would be rejected by the policy package.
 *
 * @param {string} raw - stdout of `scutil --proxy`.
 * @returns {{
 *   url: string | undefined,
 *   disabled: boolean,
 *   socksOnly: boolean,
 *   pacEnabled: boolean,
 *   invalid: boolean,
 *   overrideEntries: string[],
 * }} the parsed system setting.
 */
export function parseScutilProxy(raw) {
  const text = String(raw ?? '')
  const fields = parseScutilFields(text)
  const httpEnabled = fields.get('HTTPEnable') === '1'
  const httpsEnabled = fields.get('HTTPSEnable') === '1'
  const socksEnabled = fields.get('SOCKSEnable') === '1'
  const pacEnabled =
    fields.get('ProxyAutoConfigEnable') === '1' || fields.get('ProxyAutoDiscoveryEnable') === '1'
  const disabled = !httpEnabled && !httpsEnabled
  const fromHttps = httpsEnabled
    ? proxyUrlFrom(fields.get('HTTPSProxy'), fields.get('HTTPSPort'))
    : undefined
  const fromHttp = httpEnabled ? proxyUrlFrom(fields.get('HTTPProxy'), fields.get('HTTPPort')) : undefined
  const url = fromHttps ?? fromHttp
  return {
    url,
    disabled,
    socksOnly: socksEnabled && disabled,
    pacEnabled,
    invalid: !disabled && url === undefined,
    overrideEntries: parseBypassList(parseScutilArray(text, 'ExceptionsList')),
  }
}

/**
 * Parse the top-level scalar keys of SCUTIL output.
 * @param {string} text - the command output.
 * @returns {Map<string, string>} key to raw value.
 */
function parseScutilFields(text) {
  /** @type {Map<string, string>} */
  const fields = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (match !== null) fields.set(match[1], match[2])
  }
  if (fields.size === 0) {
    for (const match of text.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:\s*(<[^>]+>|[^\s{}]+)/g)) {
      fields.set(match[1], match[2])
    }
  }
  return fields
}

/**
 * Extract the values of one named SCUTIL `<array>` block.
 * @param {string} text - the command output.
 * @param {string} key - the array key, such as `ExceptionsList`.
 * @returns {string[]} the values inside the block.
 */
function parseScutilArray(text, key) {
  const keyAt = text.indexOf(key)
  if (keyAt < 0) return []
  const open = text.indexOf('{', keyAt)
  if (open < 0) return []
  let depth = 0
  let end = -1
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end < 0) return []
  const body = text.slice(open + 1, end)
  /** @type {string[]} */
  const values = []
  for (const match of body.matchAll(/(?:^|\s)\d+\s*:\s*(<[^>]*>|[^\s{}]+)/g)) values.push(match[1])
  return values
}

/**
 * Build an HTTP proxy URL from a SCUTIL host/port pair.
 * @param {string | undefined} rawHost - the host value.
 * @param {string | undefined} rawPort - the port value.
 * @returns {string | undefined} the proxy URL.
 */
function proxyUrlFrom(rawHost, rawPort) {
  const host = typeof rawHost === 'string' ? rawHost.trim() : ''
  if (host === '' || host.startsWith('<')) return undefined
  const portText = typeof rawPort === 'string' ? rawPort.trim() : ''
  if (!/^\d{1,5}$/.test(portText)) return undefined
  const port = Number(portText)
  if (port < 1 || port > 65_535) return undefined
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return normalizeProxyUrl(`${bracketed}:${port}`)
}
