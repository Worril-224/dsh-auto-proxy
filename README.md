# dsh-auto-proxy

让 DeepSeek Harness 里的 agent 访问 GitHub、Hugging Face、npm、PyPI 时自动走这台电脑上已经开着的本地代理，而不是去找镜像。

## 它做什么

加载时依次确定一条线路：

1. 插件配置里的 `proxyUrl`；
2. 已导出的 `HTTPS_PROXY` / `HTTP_PROXY`（`ALL_PROXY` 作为兜底）；
3. Windows 的“系统代理”设置（`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`）——代理软件写的那一份，`curl`、`git`、`pip` 从来不读。

找到之后，它用 DSH 自带的 `@deepseek-ai/dsh-http-proxy` 策略把这条线路安装到整个进程：Node 的 `fetch`（网页抓取、搜索、模型调用）走代理，同时把代理变量写进进程环境，此后 agent 启动的每个 shell（bash / PowerShell / 后台作业）以及其中的 `git`、`curl`、`pip`、`npm` 都会继承。

它每分钟重新检测一次，所以代理软件重启后换了端口，不需要重启 DSH 也能自动跟上。

## `net_proxy` 工具

- `status`：当前线路、来源、是否已经接管进程内的 fetch、直连例外、可直接粘贴的导出语句；
- `refresh`：立刻重新检测并安装（怀疑代理换了端口时用）；
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
| `autoDetect` | `true` | 是否读取 Windows 系统代理设置 |
| `noProxy` | `deepseek.com` | 追加直连域名，逗号或空格分隔；loopback 永远直连 |
| `nodeUseEnvProxy` | `true` | 是否设置 `NODE_USE_ENV_PROXY=1`，让 npm 这类 Node 子进程也读变量 |
| `refreshIntervalMs` | `60000` | 重新检测间隔；`0` 关闭 |
| `enabled` | `true` | `false` 时完全不安装线路 |

## 边界

- 只支持 `http://` / `https://` 代理。SOCKS、PAC 会被报告并保持直连。
- 只对**之后新开**的 shell 生效。已经开着的 shell、以及终端面板（它跑在自己的进程里）保持启动时的环境，可以 `export` `net_proxy` 返回的那几行，或再开一个 shell。
- 代理地址会作为进程环境变量存在，任何命令都能读到，包括里面可能带的密码。
- 模型调用默认直连（`noProxy` 含 `deepseek.com`），代理挂掉不会带走会话。
