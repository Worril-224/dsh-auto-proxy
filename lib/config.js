/**
 * Normalize the loader row's raw configuration.
 *
 * The `Config` export in `index.js` gives the settings panel a typed form, but this normalizer
 * stays in place for installations where that optional schema cannot load and for values the
 * schema deliberately lets through (an empty string or `null` in `refreshIntervalMs`).
 *
 * @module @local/dsh-auto-proxy/lib/config
 */

import {
  DEFAULT_NO_PROXY,
  DEFAULT_REFRESH_MS,
  MAX_REFRESH_MS,
  hasProxyCredentials,
  maskProxyUrl,
  normalizeProxyUrl,
} from './proxy.js'

/**
 * @typedef {object} NormalizedConfig
 * @property {boolean} enabled - whether to install any route at all.
 * @property {boolean} autoDetect - whether to read the operating system proxy setting.
 * @property {string} proxyUrl - a pinned proxy URL, or an empty string for auto-detection.
 * @property {string} noProxy - the configured bypass list.
 * @property {boolean} nodeUseEnvProxy - whether to export `NODE_USE_ENV_PROXY=1`.
 * @property {number} refreshIntervalMs - re-check interval; `0` disables it.
 * @property {string[]} notes - diagnostics to surface through `net_proxy`.
 */

/**
 * @param {unknown} raw - the row's `config` object.
 * @returns {NormalizedConfig} the normalized configuration.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  /** @type {string[]} */
  const notes = []
  let proxyUrl = ''
  if (typeof input.proxyUrl === 'string' && input.proxyUrl.trim() !== '') {
    const normalized = normalizeProxyUrl(input.proxyUrl)
    if (normalized === undefined) {
      notes.push(`config proxyUrl "${maskProxyUrl(input.proxyUrl)}" is not an http(s) proxy URL; ignoring it`)
    } else {
      proxyUrl = normalized
      if (hasProxyCredentials(normalized)) {
        notes.push(
          'config proxyUrl carries credentials; they stay in the process environment and are ' +
            'masked in reports and in shellExports',
        )
      }
    }
  } else if (
    input.proxyUrl !== undefined &&
    input.proxyUrl !== null &&
    String(input.proxyUrl).trim() !== ''
  ) {
    notes.push('config proxyUrl must be a string; ignoring it')
  }

  const configuredNoProxy = typeof input.noProxy === 'string' ? input.noProxy.trim() : ''
  return {
    enabled: input.enabled !== false,
    autoDetect: input.autoDetect !== false,
    proxyUrl,
    // An explicitly empty value means "use the safe default" instead of dropping the model
    // bypass: a proxy outage must never take the DeepSeek API down with it.
    noProxy: configuredNoProxy === '' ? DEFAULT_NO_PROXY : configuredNoProxy,
    nodeUseEnvProxy: input.nodeUseEnvProxy !== false,
    refreshIntervalMs: normalizeInterval(input.refreshIntervalMs),
    notes,
  }
}

/**
 * Treat a blank YAML value (`null` or `''`) as "use the default" rather than `Number(null) === 0`,
 * which would silently disable the re-check timer.
 * @param {unknown} value - the raw interval.
 * @returns {number} a finite interval within bounds.
 */
export function normalizeInterval(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_REFRESH_MS
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_REFRESH_MS
  return Math.min(Math.max(number, 0), MAX_REFRESH_MS)
}
