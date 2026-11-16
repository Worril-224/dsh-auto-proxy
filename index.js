/**
 * dsh-auto-proxy — keep the agent's outbound traffic on this machine's local proxy.
 *
 * DSH reads `HTTPS_PROXY` / `HTTP_PROXY` only at launch, so a proxy that appears later (or whose
 * port changes when the proxy application restarts) leaves every request direct. This plugin
 * resolves the route at load time — explicit config, then an already-exported variable, then the
 * operating system's proxy setting (macOS `scutil --proxy`, Windows Internet Settings) — and
 * installs it for the whole process through the shipped `@deepseek-ai/dsh-http-proxy` policy,
 * which publishes the variables that every child process (bash, pwsh, terminals, git, curl, pip)
 * inherits and routes Node's `fetch` through the proxy too.
 *
 * It re-checks on a timer so a proxy that comes back on a different port, or whose bypass list
 * changes, is picked up without a restart, and exposes `net_proxy` so the agent can inspect,
 * repair, and test the route itself.
 *
 * @module @local/dsh-auto-proxy
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { normalizeConfig } from './lib/config.js'
import {
  DEFAULT_NO_PROXY,
  DEFAULT_REFRESH_MS,
  MAX_REFRESH_MS,
  hasProxyCredentials,
  maskCredentialsInText,
  maskProxyUrl,
  normalizeProxyUrl,
  shExports,
} from './lib/proxy.js'
import { readSystemProxy } from './lib/system-proxy.js'

/** Cordis plugin name; also the loader row id this package mounts under. */
export const name = 'dsh-auto-proxy'

/** Required services: the tool registry. `shellEnv` is looked up optionally. */
export const inject = ['tools']

/** The shipped package that owns this installation's transport policy. */
const PROXY_PACKAGE = '@deepseek-ai/dsh-http-proxy'

/** The shipped schema package that validates this plugin's row config when the loader loads it. */
const SCHEMA_PACKAGE = '@deepseek-ai/schemastery'

/** Length of the probe request's own budget, in milliseconds. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * Optional config schema. `@deepseek-ai/schemastery` ships with DSH, not with this profile
 * package, so it is resolved from the installation at module load. When that resolution fails the
 * plugin still mounts and `normalizeConfig` validates the same fields.
 */
const schema = await importPackage(SCHEMA_PACKAGE)
const z = schema?.default ?? schema
export const Config =
  typeof z?.object === 'function'
    ? z.object({
        enabled: z.boolean().default(true),
        autoDetect: z.boolean().default(true),
        proxyUrl: z.string().default(''),
        noProxy: z.string().default(DEFAULT_NO_PROXY),
        nodeUseEnvProxy: z.boolean().default(true),
        refreshIntervalMs: z
          .union([z.number().min(0).max(MAX_REFRESH_MS), z.never()])
          .default(DEFAULT_REFRESH_MS),
      })
    : undefined

/** One mutable record of what this plugin installed, so every action reports the same truth. */
class ProxyController {
  /**
   * @param {ReturnType<typeof normalizeConfig>} config - normalized plugin configuration.
   */
  constructor(config) {
    /** @type {ReturnType<typeof normalizeConfig>} */
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
    /** @type {string | undefined} */
    this.installedNoProxy = undefined
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
   * Resolve the route from the current machine state and install it when anything visible to
   * consumers changed: the proxy URL or the effective bypass list.
   * @returns {Promise<void>}
   */
  async refresh() {
    if (!this.config.enabled) return
    const detected = await this.detect()
    const nextNoProxy = this.effectiveNoProxy()
    if (
      detected.url === this.url &&
      this.dispose !== undefined &&
      nextNoProxy === this.installedNoProxy
    ) {
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
      this.error = maskCredentialsInText(error instanceof Error ? error.message : String(error))
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
    // Clear the previous OS note here rather than only inside setSystemNotes: a config or
    // environment route returns before the OS is read, and a stale note would otherwise survive.
    this.notes = this.notes.filter(note => !note.startsWith('system proxy'))
    if (this.config.proxyUrl) return { url: this.config.proxyUrl, source: 'config' }
    const ambient = readAmbientProxy()
    // A value this plugin published itself is not an independent source; without this the timer
    // would keep re-deriving its own output and never notice the system setting change.
    if (ambient !== undefined && ambient !== this.url) return { url: ambient, source: 'environment' }
    if (this.config.autoDetect) {
      const system = await readSystemProxy()
      this.systemOverrideEntries = system.overrideEntries
      this.setSystemNotes(system)
      if (system.url !== undefined) return { url: system.url, source: system.source ?? 'system-proxy' }
    }
    return { url: undefined, source: 'none' }
  }

  /**
   * Record what the operating system contributed, without letting stale notes accumulate.
   * @param {import('./lib/system-proxy.js').SystemProxyReading} system - the OS reading.
   */
  setSystemNotes(system) {
    const kept = this.notes.filter(note => !note.startsWith('system proxy'))
    this.notes = kept
    if (system.unsupported) {
      this.notes.push(
        `system proxy detection is not available on ${system.platform}; set proxyUrl or export HTTPS_PROXY`,
      )
      return
    }
    if (system.unreadable) {
      this.notes.push(
        `system proxy setting could not be read${system.error === undefined ? '' : `: ${system.error}`}`,
      )
      return
    }
    if (system.disabled) {
      this.notes.push(
        system.platform === 'windows'
          ? 'system proxy setting is switched off (ProxyEnable = 0)'
          : system.platform === 'macos'
            ? 'system proxy setting is switched off (HTTPEnable = 0, HTTPSEnable = 0)'
            : 'system proxy setting is switched off',
      )
    }
    if (system.socksOnly) {
      this.notes.push(
        'the system proxy is SOCKS-only; this plugin supports HTTP/HTTPS proxies, so it stays direct',
      )
    }
    if (system.pacEnabled) {
      this.notes.push('a PAC file or auto-discovery is configured; PAC routing is not supported and is ignored')
    }
    if (system.invalid) {
      this.notes.push('the system proxy setting does not name a usable host:port pair; staying direct')
    }
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
      this.installedNoProxy = noProxy
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
      this.installedNoProxy = noProxy
      for (const message of diagnostics) this.notes.push(maskCredentialsInText(message))
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
    this.installedNoProxy = undefined
    if (dispose !== undefined) {
      try {
        await dispose()
      } catch (error) {
        this.notes.push(
          `restoring the previous proxy state failed: ${maskCredentialsInText(
            error instanceof Error ? error.message : String(error),
          )}`,
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
    const loaded = await importPackage(PROXY_PACKAGE)
    if (loaded !== undefined && typeof loaded.installProxyFromEnvironment === 'function') {
      this.packageModule = loaded
      return loaded
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
    if (active && this.url !== undefined && hasProxyCredentials(this.url) && !notes.some(note => note.includes('credentials'))) {
      notes.push(
        'the proxy URL carries credentials; they are masked in this report and in shellExports — ' +
          'replace *** with the real username and password before pasting the export lines',
      )
    }
    if (active) {
      notes.push(
        'a shell the agent starts from now on inherits this route; an already-running shell, and ' +
          'the terminal panel (which boots in its own process), keep the environment they started ' +
          'with — open a new shell, or export the variables above',
      )
    } else {
      const systemSetting =
        process.platform === 'darwin'
          ? 'the macOS system proxy setting (scutil --proxy)'
          : process.platform === 'win32'
            ? 'the Windows system proxy setting (Internet Settings)'
            : 'an operating-system proxy setting'
      notes.push(
        'no proxy route is installed: nothing was found in the plugin config, the proxy ' +
          `environment variables, or ${systemSetting}`,
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
    if (typeof value !== 'string' || value.trim() === '') continue
    const normalized = normalizeProxyUrl(value)
    if (normalized !== undefined) return normalized
  }
  return undefined
}

/**
 * Import one package that ships with DSH, resolving it from this installation first.
 *
 * A profile-installed bundle cannot resolve `@deepseek-ai/*` from its own directory: those
 * packages live inside the DSH installation (and inside `app.asar` in Desktop), so every anchor
 * this process can name is tried before giving the bare specifier a chance.
 *
 * @param {string} specifier - the package name.
 * @returns {Promise<any>} the module namespace, or undefined when unreachable.
 */
async function importPackage(specifier) {
  for (const anchor of installationAnchors()) {
    try {
      const require = createRequire(pathToFileURL(path.join(anchor, 'package.json')).href)
      const resolved = require.resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch {
      // Try the next anchor; the final fallback covers a plain Node installation.
    }
  }
  try {
    return await import(specifier)
  } catch {
    return undefined
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
  remember(process.env.DSH_PROFILE_DIR ?? '')
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
          'status reports the current route without changing it; refresh re-detects the process ' +
          'environment and the operating system proxy setting and installs the result (the plugin ' +
          'config itself is fixed when the row mounts); test fetches one URL through the current ' +
          'route and reports status and latency.',
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
      headers: { 'user-agent': 'dsh-auto-proxy probe' },
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

  ctx.effect(
    () => {
      controller.start()
      return () => controller.stop()
    },
    'dsh-auto-proxy: outbound proxy route and its re-check timer',
  )

  ctx.effect(() => ctx.tools.register(buildTool(controller)), 'dsh-auto-proxy: the net_proxy tool')

  const shellEnv = ctx.get('shellEnv')
  if (shellEnv !== undefined) {
    ctx.effect(
      () =>
        shellEnv.register({
          name: 'dsh-auto-proxy',
          variables: {
            DSH_PROXY_URL: {
              description: 'The outbound proxy URL this session routes through; empty when none is active.',
            },
          },
          resolve: () => (controller.url === undefined ? {} : { DSH_PROXY_URL: controller.url }),
        }),
      'dsh-auto-proxy: the DSH_PROXY_URL shell fact',
    )
  }
}
