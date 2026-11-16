# dsh-auto-proxy

让 DeepSeek Harness 里的 agent 访问 GitHub、Hugging Face、npm、PyPI 时自动走这台电脑上已经开着的本地代理，而不是去找镜像。

支持 **macOS** 与 **Windows**：macOS 读 `scutil --proxy`，Windows 读
`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`。两个平台使用同一份插件代码，在运行时按
`process.platform` 分派；`release/` 里的两个版本只是按平台标注、分别打包，安装任意一个都能在两种系统上运行。

## 它做什么

加载时依次确定一条线路：

1. 插件配置里的 `proxyUrl`；
2. 已导出的 `HTTPS_PROXY` / `HTTP_PROXY`（`ALL_PROXY` 作为兜底）；
3. 操作系统的“系统代理”设置——代理软件写的那一份，`curl`、`git`、`pip` 从来不读：
   - **macOS**：`scutil --proxy` 的 `HTTPSEnable` / `HTTPEnable`，优先 HTTPS，其次 HTTP；
   - **Windows**：注册表的 `ProxyEnable` / `ProxyServer` / `ProxyOverride`，`https=` 优先于 `http=`。

找到之后，它用 DSH 自带的 `@deepseek-ai/dsh-http-proxy` 策略把这条线路安装到整个进程：Node 的 `fetch`（网页抓取、搜索、模型调用）走代理，同时把代理变量写进进程环境，此后 agent 启动的每个 shell（bash / PowerShell / 后台作业）以及其中的 `git`、`curl`、`pip`、`npm` 都会继承。

它每分钟重新检测一次。代理软件重启后换了端口，或者系统绕过列表变了，都会自动跟上，不需要重启 DSH。

## `net_proxy` 工具

- `status`：当前线路、来源、是否已经接管进程内的 fetch、直连例外、可直接粘贴的导出语句；
- `refresh`：立刻重新检测进程环境和系统代理并安装（插件配置在挂载时已经固化，不会重读 YAML）；
- `test`：用当前线路真实抓取一个 URL，报告状态码与耗时。

## 配置

写在 `cordis.patch.yml` 的那一行下面，例如：

```yaml
- insert:
    - id: dsh-auto-proxy
      name: '@local/dsh-auto-proxy'
      config:
        proxyUrl: 'http://127.0.0.1:22789'
        noProxy: 'deepseek.com'
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `proxyUrl` | `''` | 固定一个代理；留空则自动检测 |
| `autoDetect` | `true` | 是否读取 macOS / Windows 的系统代理设置 |
| `noProxy` | `deepseek.com` | 追加直连域名，逗号或空格分隔；显式留空会回退到默认值，避免模型调用被代理拖垮 |
| `nodeUseEnvProxy` | `true` | 是否设置 `NODE_USE_ENV_PROXY=1`，让 npm 这类 Node 子进程也读变量 |
| `refreshIntervalMs` | `60000` | 重新检测间隔；`0` 关闭，`null` 或留空按默认值处理 |
| `enabled` | `true` | `false` 时完全不安装线路 |

插件带有 `Config` schema，挂载时会校验这些字段；如果当前 DSH 的插件面板为该行提供配置页，会使用这份 schema。
`proxyUrl` 里如果带 `user:pass@`，报告和 `shellExports` 会用 `***:***@` 占位，真实凭据只留在进程环境里。

## 平台差异

### macOS

- `scutil --proxy` 读的是当前主服务，不需要知道 Wi-Fi / 以太网的服务名，也没有多网卡歧义。
- `HTTPSEnable=1` 优先用 `HTTPSProxy:HTTPSPort`；否则用 `HTTPEnable` 对应的 HTTP 项。
- 只有 SOCKS 开启、HTTP/HTTPS 都关时，会明确报告“SOCKS-only，不支持”，并保持直连——不会把 URL 拼成
  `socks5://` 然后被策略包拒掉。
- `ExceptionsList` 里的 `127.0.0.1`、`localhost`、`<local>` 会被过滤；`*.local`、`*.example.com` 这类
  策略包能匹配的前缀通配会保留。
- PAC / 自动发现会被告知并忽略。

### Windows

- `ProxyEnable=0` 时报告“系统代理已关闭”，不会拿旧的 `ProxyServer` 继续用。
- `ProxyServer` 支持 `host:port` 和 `http=host:port;https=host:port` 两种写法；SOCKS 项会被跳过。
- `ProxyOverride` 里策略包匹配不了的条目（中间通配、CIDR、带空格、`<local>`）会被丢弃；`*.foo` 和
  `.foo` 前缀形式会保留。

## 安装

### 插件面板

打开 DSH 的 **插件** → **添加插件**，选择 `release/macos/dsh-auto-proxy` 或
`release/windows/dsh-auto-proxy` 目录。安装后重启 DSH（替换已装载的 JS 模块需要重启；首次安装通常可以热加载）。

### 交给 agent / `plugin_manager`

```text
plugin_manager install_bundle target: "<本仓库绝对路径>/release/macos/dsh-auto-proxy"
```

装完把 `@local/dsh-auto-proxy` 加进 profile 的 `dsh.profile.bundles`（`set_bundle`）。

### 本地开发

```sh
# 不碰 profile 的装载测试
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tools/mount-test.mjs src '{}'

# 纯函数测试
cd src && npm test
```

## 构建 release

```sh
node tools/build-release.mjs
```

输出：

```text
release/
├── macos/dsh-auto-proxy/           # 可直接“添加插件”的目录
├── windows/dsh-auto-proxy/         # 同上
├── dsh-auto-proxy-1.1.0-macos.zip
├── dsh-auto-proxy-1.1.0-windows.zip
├── SHA256SUMS.txt
└── README.md
```

## 边界

- 只支持 `http://` / `https://` 代理。SOCKS、PAC 会被报告并保持直连。
- 只对**之后新开**的 shell 生效。已经开着的 shell、以及终端面板（它跑在自己的进程里）保持启动时的环境，可以
  `export` `net_proxy` 返回的那几行，或再开一个 shell。
- 代理地址会作为进程环境变量存在，任何命令都能读到，包括里面可能带的密码（报告与导出语句会脱敏，但环境变量本身不会）。
- 模型调用默认直连（`noProxy` 含 `deepseek.com`），代理挂掉不会带走会话。
- 系统代理检测覆盖 macOS 和 Windows；其他平台只读配置与环境变量。
