/**
 * Read the "system proxy" setting that browsers obey and command-line tools never see.
 *
 * - macOS: `scutil --proxy` describes the current primary service, so no network-service name is
 *   needed. HTTP/HTTPS entries are preferred; SOCKS-only configurations are reported as unsupported.
 * - Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` holds the same
 *   value under `ProxyEnable` / `ProxyServer` / `ProxyOverride`.
 *
 * @module @local/dsh-auto-proxy/lib/system-proxy
 */

import { execFile } from 'node:child_process'

import { parseBypassList, parseProxyServer, parseScutilProxy } from './proxy.js'

/** Windows registry key holding the system proxy. */
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/**
 * @typedef {object} SystemProxyReading
 * @property {string | undefined} url - the usable proxy URL.
 * @property {boolean} disabled - the OS setting exists but HTTP/HTTPS proxying is off.
 * @property {string[]} overrideEntries - bypass entries the shipped policy can match.
 * @property {'macos' | 'windows' | string} platform - the reading platform.
 * @property {string | undefined} source - the `net_proxy` source label.
 * @property {boolean} [socksOnly] - only a SOCKS proxy is configured.
 * @property {boolean} [pacEnabled] - a PAC/auto-discovery setting is on.
 * @property {boolean} [invalid] - HTTP/HTTPS is enabled but the host/port is unusable.
 * @property {boolean} [unreadable] - the OS command failed.
 * @property {boolean} [unsupported] - this platform has no detector.
 * @property {string} [error] - a short diagnostic when `unreadable` is true.
 */

/**
 * Read the system proxy for this process's platform.
 * @returns {Promise<SystemProxyReading>} the reading.
 */
export async function readSystemProxy() {
  if (process.platform === 'darwin') return readMacSystemProxy()
  if (process.platform === 'win32') return readWindowsSystemProxy()
  return {
    url: undefined,
    disabled: false,
    overrideEntries: [],
    platform: process.platform,
    source: undefined,
    unsupported: true,
  }
}

/**
 * Read the macOS proxy settings through SCUTIL.
 * @param {(file: string, args: string[]) => Promise<string | undefined>} [run] - command runner, injectable for tests.
 * @returns {Promise<SystemProxyReading>} the reading.
 */
export async function readMacSystemProxy(run = runText) {
  const output = (await run('/usr/sbin/scutil', ['--proxy'])) ?? (await run('scutil', ['--proxy']))
  if (output === undefined) {
    return {
      url: undefined,
      disabled: false,
      overrideEntries: [],
      platform: 'macos',
      source: 'macos-system-proxy',
      unreadable: true,
      error: 'scutil --proxy failed',
    }
  }
  const parsed = parseScutilProxy(output)
  return {
    ...parsed,
    platform: 'macos',
    source: 'macos-system-proxy',
  }
}

/**
 * Read the Windows Internet Settings proxy values.
 * @param {(valueName: string) => Promise<string | undefined>} [query] - registry reader, injectable for tests.
 * @returns {Promise<SystemProxyReading>} the reading.
 */
export async function readWindowsSystemProxy(query = queryRegistry) {
  const enabled = await query('ProxyEnable')
  const disabled = enabled === undefined ? false : !/^(?:0x)?0*1$/i.test(enabled.trim())
  if (disabled) {
    return {
      url: undefined,
      disabled: true,
      overrideEntries: [],
      platform: 'windows',
      source: 'windows-system-proxy',
    }
  }
  const [server, override] = await Promise.all([query('ProxyServer'), query('ProxyOverride')])
  const url = parseProxyServer(server)
  return {
    url,
    disabled: false,
    overrideEntries: parseBypassList(override),
    platform: 'windows',
    source: 'windows-system-proxy',
    invalid: url === undefined && typeof server === 'string' && server.trim() !== '',
  }
}

/**
 * Read one value from the Internet Settings key.
 * @param {string} valueName - the registry value name.
 * @returns {Promise<string | undefined>} its data, or undefined when absent or unreadable.
 */
function queryRegistry(valueName) {
  return runText('reg.exe', ['query', INTERNET_SETTINGS, '/v', valueName]).then(stdout => {
    if (stdout === undefined) return undefined
    const match = /REG_[A-Z_]+\s+([^\r\n]*)/.exec(stdout)
    return match === null ? undefined : match[1].trim()
  })
}

/**
 * Run one short diagnostic command and resolve its stdout, or undefined on any failure.
 * @param {string} file - the executable.
 * @param {string[]} args - its arguments.
 * @returns {Promise<string | undefined>} stdout on success.
 */
function runText(file, args) {
  return new Promise(resolve => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        resolve(error ? undefined : String(stdout))
      },
    )
  })
}
