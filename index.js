/**
 * dsh-net-proxy — keep the agent's outbound traffic on this machine's local proxy.
 *
 * DSH reads `HTTPS_PROXY` / `HTTP_PROXY` only at launch, so a proxy that appears later (or whose
 * port changes when the proxy application restarts) leaves every request direct. This plugin
 * resolves the route at load time — explicit config, then an already-exported variable, then the
 * Windows system-proxy setting — and installs it for the whole process through the shipped
 * `@deepseek-ai/dsh-http-proxy` policy, which publishes the variables that every child process
 * (bash, pwsh, terminals, git, curl, pip) inherits and routes Node's `fetch` through the proxy too.
 *
 * It re-checks on a timer so a proxy that comes back on a different port is picked up without a
 * restart, and exposes `net_proxy` so the agent can inspect, repair, and test the route itself.
 *
 * @module @local/dsh-net-proxy
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Cordis plugin name; also the loader row id this package mounts under. */
export const name = 'dsh-net-proxy'

/** Required services: the tool registry. `shellEnv` is looked up optionally. */
export const inject = ['tools']

/** The shipped package that owns this installation's transport policy. */
const PROXY_PACKAGE = '@deepseek-ai/dsh-http-proxy'

/** Windows registry key holding the "system proxy" a browser obeys and a CLI tool never sees. */
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Bypass entries always kept direct: the model API is domestic and must not depend on the proxy. */
const DEFAULT_NO_PROXY = 'deepseek.com'

/** How often the detected route is re-checked, in milliseconds. */
const DEFAULT_REFRESH_MS = 60_000

/** Length of the probe request's own budget, in milliseconds. */
const PROBE_TIMEOUT_MS = 20_000

/** One mutable record of what this plugin installed, so every action reports the same truth. */
class ProxyController {
  /**
   * @param {object} config - normalized plugin configuration.
   */
  constructor(config) {
    /** @type {object} */
    this.config = config
    /** @type {string | undefined} */
    this.url = undefined
    /** @type {string} */
    this.source = 'none'
    /** @type {boolean} */
    this.dispatcherInstalled = false
    /** @type {(() => Promise<void>) | undefined} */
    this.dispose = undefined
    /** @type {string} */
    this.error = ''
    /** @type {string[]} */
    this.notes = []
    /** @type {any} */
    this.packageModule = undefined
    /** @type {string[]} */
    this.systemOverrideEntries = []
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve()
    /** @type {Promise<unknown>} */
    this.ready = Promise.resolve()
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.timer = undefined
  }

  /**
   * Serialize every route change: two overlapping installs would each restore the dispatcher the
   * other displaced, and the loser of that race would silently stop proxying.
   * @param {() => Promise<unknown>} task - the work to run once every earlier task settled.
   * @returns {Promise<unknown>} the task's own outcome.
   */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Start the initial resolution and the periodic re-check. */
  start() {
    if (!this.config.enabled) {
      this.notes.push('the plugin row is disabled (enabled: false), so no route was installed')
      return
    }
    this.ready = this.enqueue(() => this.refresh())
    if (this.config.refreshIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.enqueue(() => this.refresh())
      }, this.config.refreshIntervalMs)
      this.timer.unref?.()
    }
  }

  /** Stop the timer and restore the environment and dispatcher this plugin displaced. */
  async stop() {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.enqueue(async () => {
      await this.uninstall()
    })
  }

  /**
   * Resolve the route from the current machine state and install it when it differs.
   * @returns {Promise<void>}
   */
  async refresh() {
    if (!this.config.enabled) return
    const detected = await this.detect()
    if (detected.url === this.url && this.dispose !== undefined) {
      this.source = detected.source
      return
    }
    if (detected.url === undefined && this.dispose === undefined) {
      this.source = 'none'
      return
    }
    await this.uninstall()
    if (detected.url === undefined) {
      this.source = 'none'
      return
    }
    try {
      await this.installRoute(detected.url, detected.source)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.url = undefined
      this.source = 'none'
    }
  }

  /**
   * Decide which proxy this machine should use.
   * @returns {Promise<{ url: string | undefined, source: string }>} the winning route.
   */
  async detect() {
    this.systemOverrideEntries = []
    if (this.config.proxyUrl) return { url: this.config.proxyUrl, source: 'config' }
    const ambient = readAmbientProxy()
    // A value this plugin published itself is not an independent source; without this the timer
    // would keep re-deriving its own output and never notice the system setting change.
    if (ambient !== undefined && ambient !== this.url) return { url: ambient, source: 'environment' }
    if (this.config.autoDetect && process.platform === 'win32') {
      const system = await readSystemProxy()
      this.systemOverrideEntries = system.overrideEntries
      this.setSystemNotes(system)
      if (system.url !== undefined) return { url: system.url, source: 'windows-system-proxy' }
    }
    return { url: undefined, source: 'none' }
  }

  /**
   * Record what the registry contributed, without letting stale notes accumulate.
   * @param {{ overrideEntries: string[], disabled: boolean }} system - the registry reading.
   */
  setSystemNotes(system) {
    const kept = this.notes.filter(note => !note.startsWith('system proxy'))
    this.notes = kept
    if (system.disabled) this.notes.push('system proxy setting is switched off (ProxyEnable = 0)')
    if (system.overrideEntries.length > 0) {
      this.notes.push(
        `system proxy bypass entries that this plugin accepts: ${system.overrideEntries.join(', ')}`,
      )
    }
  }

  /**
   * Install one route: the process-wide dispatcher when the shipped package resolves, and in every
   * case the environment variables that child processes read.
   * @param {string} url - the proxy URL to route through.
   * @param {string} source - which layer supplied it.
   */
  async installRoute(url, source) {
    const values = {
      http_proxy: url,
      HTTP_PROXY: url,
      https_proxy: url,
      HTTPS_PROXY: url,
    }
    const noProxy = this.effectiveNoProxy()
    if (noProxy !== '') {
      values.no_proxy = noProxy
      values.NO_PROXY = noProxy
    }
    const modifier = await this.loadPackage()
    if (modifier === null) {
      const restore = publishEnvironment(values, this.config.nodeUseEnvProxy)
      this.dispose = async () => {
        restore()
      }
      this.dispatcherInstalled = false
      this.notes.push(
        'the shipped proxy policy package could not be loaded, so only child processes are proxied; ' +
          'in-process fetch (web_fetch, web search, model calls) stays direct until DSH is restarted',
      )
    } else {
      const diagnostics = []
      const disposePolicy = await modifier.installProxyFromEnvironment(
        { get: envName => (values[envName] === undefined ? undefined : { value: values[envName] }) },
        message => diagnostics.push(message),
      )
      const restoreNodeFlag = publishNodeUseEnvProxy(this.config.nodeUseEnvProxy)
      this.dispose = async () => {
        restoreNodeFlag()
        await disposePolicy()
      }
      this.dispatcherInstalled = true
      for (const message of diagnostics) this.notes.push(message)
    }
    this.url = url
    this.source = source
    this.error = ''
  }

  /** Undo the current route, leaving the process exactly as this plugin found it. */
  async uninstall() {
    const dispose = this.dispose
    this.dispose = undefined
    this.dispatcherInstalled = false
    if (dispose !== undefined) {
      try {
        await dispose()
      } catch (error) {
        this.notes.push(
          `restoring the previous proxy state failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * Resolve the shipped policy package. It is never installed into this profile — it ships with
   * DSH itself — so it has to be resolved from the installation this process is running out of.
   * @returns {Promise<any>} the module, or null when this installation cannot provide it.
   */
  async loadPackage() {
    if (this.packageModule !== undefined) return this.packageModule
    for (const anchor of installationAnchors()) {
      try {
        const require = createRequire(pathToFileURL(path.join(anchor, 'package.json')).href)
        const resolved = require.resolve(PROXY_PACKAGE)
        const loaded = await import(pathToFileURL(resolved).href)
        if (typeof loaded.installProxyFromEnvironment === 'function') {
          this.packageModule = loaded
          return loaded
        }
      } catch {
        // Try the next anchor; the degradation is reported by installRoute when all of them fail.
      }
    }
    try {
      const loaded = await import(PROXY_PACKAGE)
      if (typeof loaded.installProxyFromEnvironment === 'function') {
        this.packageModule = loaded
        return loaded
      }
    } catch {
      // No resolution path reached it.
    }
    this.packageModule = null
    return null
  }

  /** The bypass list this install publishes. @returns {string} */
  effectiveNoProxy() {
    const entries = []
    for (const entry of this.config.noProxy.split(/[,\s]+/)) {
      const trimmed = entry.trim()
      if (trimmed !== '' && !entries.includes(trimmed)) entries.push(trimmed)
    }
    for (const entry of this.systemOverrideEntries ?? []) {
      if (!entries.includes(entry)) entries.push(entry)
    }
    return entries.join(',')
  }

  /**
   * Whether this process's own `fetch` would currently reach `url` through the proxy.
   * @returns {boolean} true when the installed dispatcher proxies that URL.
   */
  routeIsProxied() {
    const modifier = this.packageModule
    if (this.dispatcherInstalled !== true || modifier == null) return false
    try {
      return modifier.proxyRouteFor(new URL('https://github.com')).proxied === true
    } catch {
      return false
    }
  }

  /**
   * The flat result shape the `net_proxy` tool declares.
   * @param {{ probeUrl?: string, probeStatus?: number, probeMs?: number, probeVia?: string }} [probe]
   * @returns {Record<string, unknown>} the tool value.
   */
  view(probe = {}) {
    const active = this.url !== undefined && this.dispose !== undefined
    const notes = [...this.notes]
    if (this.error !== '') notes.push(this.error)
    if (active) {
      notes.push(
        'a shell the agent starts from now on inherits this route; an already-running shell, and ' +
          'the terminal panel (which boots in its own process), keep the environment they started ' +
          'with — open a new shell, or export the variables above',
      )
    } else {
      notes.push(
        'no proxy route is installed: nothing was found in the plugin config, the proxy ' +
          'environment variables, or the Windows system proxy setting',
      )
    }
    return {
      active,
      source: this.source,
      proxy: active ? maskProxyUrl(/** @type {string} */ (this.url)) : '',
      dispatcher: active && this.routeIsProxied() ? 'fetch-routed' : active ? 'children-only' : 'none',
      noProxy: active ? this.effectiveNoProxy() : '',
      shellExports: active ? shExports(/** @type {string} */ (this.url), this.effectiveNoProxy()) : '',
      notes: notes.join(' | '),
      ...probe,
    }
  }
}

/**
 * Read the first proxy value already present in this process's environment.
 * @returns {string | undefined} the URL, or undefined when nothing is exported.
 */
function readAmbientProxy() {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  for (const envName of names) {
    const value = process.env[envName]
    if (typeof value === 'string' && value.trim() !== '') return normalizeProxyUrl(value)
  }
  return undefined
}

/**
 * Read the Windows "system proxy" setting that browsers obey and command-line tools never see.
 * @returns {Promise<{ url: string | undefined, disabled: boolean, overrideEntries: string[] }>}
 */
async function readSystemProxy() {
  const enabled = await queryRegistry('ProxyEnable')
  const disabled = enabled === undefined ? false : !/^0x0*1$|^1$/i.test(enabled.trim())
  if (disabled) return { url: undefined, disabled: true, overrideEntries: [] }
  const server = await queryRegistry('ProxyServer')
  const override = await queryRegistry('ProxyOverride')
  return {
    url: parseProxyServer(server),
    disabled: false,
    overrideEntries: parseProxyOverride(override),
  }
}

/**
 * Read one value from the Internet Settings key.
 * @param {string} valueName - the registry value name.
 * @returns {Promise<string | undefined>} its data, or undefined when absent or unreadable.
 */
function queryRegistry(valueName) {
  return new Promise(resolve => {
    execFile(
      'reg.exe',
      ['query', INTERNET_SETTINGS, '/v', valueName],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        const match = /REG_[A-Z_]+\s+([^\r\n]*)/.exec(String(stdout))
        resolve(match === null ? undefined : match[1].trim())
      },
    )
  })
}

/**
 * Turn a `ProxyServer` value into one proxy URL: either a bare `host:port` or the per-scheme
 * `http=host:port;https=host:port` form.
 * @param {string | undefined} raw - the registry value.
 * @returns {string | undefined} the proxy URL, or undefined when it names no usable proxy.
 */
function parseProxyServer(raw) {
  if (raw === undefined || raw.trim() === '') return undefined
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
 * Keep only the bypass entries this installation can actually match, so a wildcard form such as
 * `192.168.*` is not published as a rule that silently matches nothing.
 * @param {string | undefined} raw - the `ProxyOverride` value.
 * @returns {string[]} the usable entries.
 */
function parseProxyOverride(raw) {
  if (raw === undefined) return []
  const entries = []
  for (const piece of raw.split(';')) {
    const entry = piece.trim()
    if (entry === '' || entry.startsWith('<')) continue
    if (entry.includes('*') || entry.includes('/') || entry.includes(' ')) continue
    if (!entries.includes(entry)) entries.push(entry)
  }
  return entries
}

/**
 * Accept only an `http:` or `https:` proxy URL, adding `http://` to a bare `host:port`.
 * @param {string} value - the candidate.
 * @returns {string | undefined} a usable proxy URL without a trailing slash.
 */
function normalizeProxyUrl(value) {
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
  return href.endsWith('/') && parsed.pathname === '/' && parsed.search === '' ? href.slice(0, -1) : href
}

/**
 * Hide a proxy password before the value reaches the model or the session log.
 * @param {string} value - the proxy URL.
 * @returns {string} the URL with any credentials replaced.
 */
function maskProxyUrl(value) {
  try {
    const parsed = new URL(value)
    if (parsed.username === '' && parsed.password === '') return value
    parsed.username = '***'
    parsed.password = '***'
    return parsed.href
  } catch {
    return value
  }
}

/**
 * The directories this process may be running DSH out of, newest evidence first.
 *
 * `DSH_INSTALL_DIR` is only exported to shell tool calls, not to this process, so the packaged
 * Desktop layout and the boot entry are the anchors that are actually available here.
 * @returns {string[]} candidate install roots.
 */
function installationAnchors() {
  /** @type {string[]} */
  const anchors = []
  /** @param {string} candidate */
  const remember = candidate => {
    if (typeof candidate === 'string' && candidate !== '' && !anchors.includes(candidate)) {
      anchors.push(candidate)
    }
  }
  remember(process.env.DSH_INSTALL_DIR ?? '')
  if (typeof process.resourcesPath === 'string') {
    remember(path.join(process.resourcesPath, 'app.asar', 'dsh'))
    remember(path.join(process.resourcesPath, 'app', 'dsh'))
  }
  const entry = process.argv[1]
  if (typeof entry === 'string') {
    const marker = entry.toLowerCase().indexOf('app.asar')
    if (marker >= 0) remember(path.join(entry.slice(0, marker + 'app.asar'.length), 'dsh'))
  }
  return anchors
}

/**
 * Publish the proxy variables for child processes when the shipped policy package is absent.
 * @param {Record<string, string>} values - name to value.
 * @param {boolean} nodeFlag - whether to also set `NODE_USE_ENV_PROXY`.
 * @returns {() => void} restores every name this call changed.
 */
function publishEnvironment(values, nodeFlag) {
  const previous = new Map()
  for (const envName of Object.keys(values)) previous.set(envName, process.env[envName])
  const restoreNodeFlag = publishNodeUseEnvProxy(nodeFlag)
  for (const [envName, value] of Object.entries(values)) process.env[envName] = value
  return () => {
    restoreNodeFlag()
    for (const [envName, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, envName)
      else process.env[envName] = value
    }
  }
}

/**
 * Let Node children (npm, pnpm, Node MCP servers) read the variables too. Node 22.21+ and 24+ honor
 * them only under this flag, which must be present in the child's environment at its start.
 * @param {boolean} enabled - false leaves the variable untouched.
 * @returns {() => void} restores the previous value.
 */
function publishNodeUseEnvProxy(enabled) {
  if (!enabled) return () => {}
  const previous = process.env.NODE_USE_ENV_PROXY
  process.env.NODE_USE_ENV_PROXY = '1'
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_USE_ENV_PROXY')
    else process.env.NODE_USE_ENV_PROXY = previous
  }
}

/**
 * Render the variables as shell lines, so a shell that predates the install can be repaired.
 * @param {string} url - the proxy URL.
 * @param {string} noProxy - the bypass list.
 * @returns {string} newline-separated `export` lines.
 */
function shExports(url, noProxy) {
  const lines = [`export HTTPS_PROXY=${url}`, `export HTTP_PROXY=${url}`]
  if (noProxy !== '') lines.push(`export NO_PROXY=${noProxy}`)
  return lines.join('\n')
}

/**
 * Normalize the raw loader row config. Every field is optional and validated here rather than
 * through a Config schema, so a bad value degrades with a note instead of failing the mount.
 * @param {unknown} raw - the row's `config` object.
 * @returns {object} the normalized configuration.
 */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  /** @type {string[]} */
  const notes = []
  let proxyUrl = ''
  if (typeof input.proxyUrl === 'string' && input.proxyUrl.trim() !== '') {
    const normalized = normalizeProxyUrl(input.proxyUrl)
    if (normalized === undefined) {
      notes.push(`config proxyUrl "${input.proxyUrl}" is not an http(s) proxy URL; ignoring it`)
    } else {
      proxyUrl = normalized
    }
  }
  const interval = Number(input.refreshIntervalMs)
  return {
    enabled: input.enabled !== false,
    autoDetect: input.autoDetect !== false,
    proxyUrl,
    noProxy: typeof input.noProxy === 'string' ? input.noProxy.trim() : DEFAULT_NO_PROXY,
    nodeUseEnvProxy: input.nodeUseEnvProxy !== false,
    refreshIntervalMs: Number.isFinite(interval)
      ? Math.min(Math.max(interval, 0), 3_600_000)
      : DEFAULT_REFRESH_MS,
    notes,
  }
}

/**
 * Build the `net_proxy` tool over one controller.
 * @param {ProxyController} controller - the plugin's single route owner.
 * @returns {object} the tool definition for `ctx.tools.register`.
 */
function buildTool(controller) {
  return {
    name: 'net_proxy',
    description:
      'Inspect and repair the proxy route this machine\'s agent traffic uses for blocked sites ' +
      '(GitHub, Hugging Face, npm, PyPI). Call it before a large download when earlier network ' +
      'calls were slow or failed, and after the user reports their proxy application restarted. ' +
      'It routes new shells automatically, so most calls are only needed to confirm or re-detect. ' +
      '中文触发词：代理、走代理、下载慢、连不上 GitHub、Hugging Face 下载不动、刷新代理。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'refresh', 'test'],
        description:
          'status reports the current route without changing it; refresh re-reads the config, ' +
          'the environment and the Windows system proxy setting and installs the result; test ' +
          'fetches one URL through the current route and reports status and latency.',
      },
      url: {
        type: 'string',
        description:
          'URL for action test; ignored otherwise. Defaults to https://github.com. Use the host ' +
          'the download actually comes from when verifying a specific source.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['active', 'source', 'proxy', 'dispatcher', 'noProxy', 'shellExports', 'notes'],
        properties: {
          active: { type: 'boolean' },
          source: { type: 'string' },
          proxy: { type: 'string' },
          dispatcher: { type: 'string' },
          noProxy: { type: 'string' },
          shellExports: { type: 'string' },
          notes: { type: 'string' },
          probeUrl: { type: 'string' },
          probeStatus: { type: 'integer' },
          probeMs: { type: 'integer' },
          probeVia: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = []
        lines.push(
          value.active === true
            ? `proxy ${value.proxy} (source: ${value.source}, fetch: ${value.dispatcher})`
            : 'no proxy route is installed',
        )
        if (value.noProxy !== '') lines.push(`direct: ${value.noProxy}`)
        if (value.probeUrl !== undefined) {
          lines.push(
            `probe ${value.probeUrl} -> ${String(value.probeStatus)} via ${String(value.probeVia)} in ${String(value.probeMs)} ms`,
          )
        }
        if (value.shellExports !== '') lines.push('', String(value.shellExports))
        lines.push('', String(value.notes))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : 'status'
      await controller.ready
      if (action === 'refresh') {
        await controller.enqueue(() => controller.refresh())
        return controller.view()
      }
      if (action === 'test') {
        const url = typeof args.url === 'string' && args.url.trim() !== '' ? args.url.trim() : 'https://github.com'
        return controller.view(await probe(controller, url))
      }
      return controller.view()
    },
  }
}

/**
 * Fetch one URL through this process's current route, which is what proves the install.
 * @param {ProxyController} controller - the route owner.
 * @param {string} url - the URL to request.
 * @returns {Promise<{ probeUrl: string, probeStatus: number, probeMs: number, probeVia: string }>}
 */
async function probe(controller, url) {
  const started = Date.now()
  const via = controller.routeIsProxied() ? 'proxy' : 'direct'
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'user-agent': 'dsh-net-proxy probe' },
    })
    await response.body?.cancel()
    return { probeUrl: url, probeStatus: response.status, probeMs: Date.now() - started, probeVia: via }
  } catch (error) {
    return {
      probeUrl: url,
      probeStatus: 0,
      probeMs: Date.now() - started,
      probeVia: `${via}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Mount the plugin.
 * @param {any} ctx - host context carrying `tools`, and optionally `shellEnv`.
 * @param {unknown} rawConfig - the loader row's config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const controller = new ProxyController(config)
  if (config.notes.length > 0) controller.notes.push(...config.notes)

  ctx.effect(() => {
    controller.start()
    return () => {
      void controller.stop()
    }
  }, 'dsh-net-proxy: outbound proxy route and its re-check timer')

  ctx.effect(
    () => ctx.tools.register(buildTool(controller)),
    'dsh-net-proxy: the net_proxy tool',
  )

  const shellEnv = ctx.get('shellEnv')
  if (shellEnv !== undefined) {
    ctx.effect(
      () =>
        shellEnv.register({
          name: 'dsh-net-proxy',
          variables: {
            DSH_PROXY_URL: {
              description: 'The outbound proxy URL this session routes through; empty when none is active.',
            },
          },
          resolve: () => (controller.url === undefined ? {} : { DSH_PROXY_URL: controller.url }),
        }),
      'dsh-net-proxy: the DSH_PROXY_URL shell fact',
    )
  }
}
