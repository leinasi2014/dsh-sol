# 真机加载验证 1：dsh-sol 装进真实 DSH 以后能不能用（不依赖模型的部分）

> 公开版说明：真机证据包（tgz、截图、会话日志）和远端环境配置是内部资料，没有放进公开仓库；文中的机器、路径、账号都换成了占位符。

日期：2026-10-18。执行人：Researcher。复核：SolQA 第一轮 8 项通过，Meter 一条打回；22:29 补了证据（见下面“复核后补充”），SolQA 复核后确认成立，阶段 1 共 9 项，全部通过。

## 证据位置

- run 目录：云主机 `<lab>\runs\20261018-2140-researcher-live-load-1\`。本机打包以 v2 为准：[20261018-2140-researcher-live-load-1.v2.tgz]（sha256 `027a52d2f88a…`）。v1 的 [tgz] 留着不动，v2 只多了 `ledger/` 目录和 `cmd.txt` 末尾的补充段。里面有：
  - `MANIFEST.txt`：机器、DSH 版本、node 版本、profile，以及 dsh-sol 15 个运行时文件的 sha256。
  - `cmd.txt`：每一步的原始命令；末尾 `# --- addendum` 段是复核后补的分析命令（会话日志怎么解析、账本怎么查、哈希怎么核、令牌怎么脱敏）。
  - `ledger/`：Meter 账本原文的拷贝和 `ledger-check.txt`（场景和会话的对应、文件大小、修改时间、sha256）。
  - `result.txt`：原始输出。
  - 每个场景的截图、页面文字、服务日志，访问令牌已脱敏。
  - `profile-before/`：安装前 web profile 的原始文件，包括 `cordis.yml`。
- 环境：
  - 机器：一台 Windows Server 2025 Datacenter 10.0.26100 云主机 <test-host>。
  - DSH 0.2.1-rc.2（exe 和 CLI 都是这个版本），node v24.22.0。
  - profile：web。
- 被测代码：本机 `<repo>` 的工作区（未提交），去掉 `.git` 拷到云主机 `<lab>\src\dsh-sol`。15 个运行时文件在云主机上逐一核对 sha256，全部一致，摘几个：

  | 文件 | sha256 前 12 位 |
  |---|---|
  | `index.js` | `136ae7258b79` |
  | `lib/config.js` | `bd746468a268` |
  | `lib/fusion.js` | `f73614c476ab` |
  | `lib/meter.js` | `45e9fec61a3f` |

- 模型配置（web profile 的 `cordis.patch.yml`）：sha256 `6c713d13378a`。

## 安装方式

- 用的是 DSH 自带的命令 `dsh plugin --profile web add link:<lab>/src/dsh-sol`，背后是 profile 目录里的 pnpm。
- 装完以后，`package.json` 的 `dependencies` 多了 `dsh-sol: link:...`，`dsh.profile.bundles` 自动多了 `dsh-sol`，`node_modules\dsh-sol` 是一个指向源目录的符号链接。
- 依据 `asar:dsh-app-boot/lib/index.js:1213-1217`：pnpm 跑完以后，声明了 `dsh.bundle` 的依赖会被自动追加进 bundles。

## 结论（对应 load-check.md 第 6 节）

| # | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 本地目录安装以后，`name: dsh-sol` 能不能解析到链接进来的包 | **通过**【已核实】 | `dump-all-off.yml`：组合出的配置树里有 `# == dsh-sol`、`- id: sol`、`name: dsh-sol`、`disabled: true`，config 是默认的全关 |
| 2 | 插件列表里中英文标题、描述、图标显示是否正确 | **通过**【已核实】 | 中文界面截图 [20261018-2140-plugins-detail.png]：标题“SoL 省 token 工具”，版本 v0.1.0，描述是五个模块的那段，图标正常显示，来源 `link:<lab>\src\dsh-sol`。英文界面（`k-a-plugins.txt`）显示“SoL Token Saver” |
| 3 | 整行打开、写了 config 以后能不能激活，有没有 warning；config 写错时报错长什么样 | **通过**【已核实】 | 正例 `b-meter`、`c-fusion`、`f-allfive`（五段各写一次，reducer 的 `timeoutMs: 60000`）：插件页显示“运行中”，server.err 为空。反例 `d-typo`（`observatonPack`）和 `e-typo2`（`meterr`）：插件页显示“**异常**”，server.err 里有 `dsh: warning: 1 entry did not activate`，接着是 `sol (dsh-sol): ConfigError: dsh-sol config: unknown key(s) "observatonPack" under config; accepted keys are "meter", "actionFusion", "observationPack", "reducer", "occ"`，堆栈指向 `lib/config.js:115`、`index.js:115`。整行不激活，其他插件不受影响 |
| 4 | 各个会话里能不能看到 `edit_then_run`、`write_then_run` | **通过（web 默认 preset）**【已核实】；其他 preset 没测 | 读会话日志 `request/header.tools`：全关（`h-off`）31 个工具，没有 dsh-sol 的；开了 meter、fusion、obs（`i-on`）是 34 个，多出 `edit_then_run`、`write_then_run`、`obs_recall`；卸载后（`l-uninstalled`）回到 31 个 |
| 7 | 改了代码要不要重启才生效 | **部分核实** | 显示信息（locale 标题）不用重启：同一个服务在跑，改了副本的 `en.json`，刷新页面就变成“SoL Token Saver TEST7”，重启后还是新的【已核实，`k-item7.diff`】。改完已还原，sha256 和源文件一致。**JS 代码要不要重启没测**；官方文档说替换已装的包需要重启（`host-plugin.md:70`），这一条是推断 |

**全关时注册 0 个工具**【已核实】：插件装上但所有模块关着（`h-off`），工具列表 31 个，和卸载后（`l-uninstalled`）完全一样。

**卸载后归零**【已核实】：
- `dsh plugin --profile web remove dsh-sol` 的 exit 是 0。
- `dependencies` 变空，bundles 回到只有 `dsh-base`、`dsh-web-app`。
- `dump-after-uninstall.yml` 里没有一处提到 dsh-sol。
- 会话里的工具回到 31 个。
- 有一个小尾巴：`node_modules\dsh-sol` 的符号链接还在，pnpm 没删。不在 dependencies 里，也不在 bundles 里，所以不会被加载。

验证完以后已经重新装回去，留给阶段 2 用。

## 额外看到的（Chief 要求多看的 Fusion 探测）

- **探测顺序对**【已核实】：干净的 web profile 没有 dsh-ops，所以没有 `ops_bash`。`write_then_run` 跳过了它，用的是 `pwsh`。嵌套调用走的是正规的 job：`callId` 是 `…:sol:2`，`rootCallId` 是外层调用的 id（会话事件 `#19 job/registered`）。文件写成功了。
- **结果**：`[then_run:failed] exit code: 3221225794`。
  - 这个分类是对的：命令跑了，但退出码非 0，所以是 failed，不是 not_run。
  - 但 pwsh 本身没起来。0xC0000142 是 STATUS_DLL_INIT_FAILED。
- **原因在环境，不在 dsh-sol**【已核实对照】：同样的配置下，让模型直接调内置 `pwsh` 跑 `Get-Date`（`j-plainpwsh`），也是 `exit code: 3221225794`。
  - 推断：web 服务是从 SSH 会话（session 0，没有桌面）里起的，pwsh 沙箱起的子进程初始化失败。
  - 阶段 2 要跑命令，得在 <test-user> 的桌面会话里起 web 服务，比如用计划任务，不能直接从 SSH 起。
- **Meter 有记账**【已核实，原文见 v2 包 `ledger/`】：`i-on` 会话的账本 `<home>\.dsh\dsh-sol\session-1eb61325-330c-4b2b-b21a-be272c0fa548\ledger.jsonl` 有一行 `kind: "turn"`，`baseline: "zero"`，`requests: 2`，usage 四个字段都在（`cacheWriteTokens` 为 0，那轮没写缓存）。
  - 注意 1：账本目录名带 `session-` 前缀，因为 sessionId 本身就带这个前缀。
  - 注意 2：`result.txt:54/68/82/115` 那四行 `ledger: none at …` 是我的检查脚本路径拼错了（`stage1-turn.ps1:33` 把前缀去掉了），是误报。脚本已改，阶段 2 起不会再出。

## 复核后补充（2026-10-18 22:29，回应 SolQA）

- **[中] Meter 原始数据**：两个账本原样拷进 run 目录 `ledger\`，拉回本机后解包再算一遍 sha256，和云主机原件一致【已核实】：

  | 场景 | 会话（对应依据 `result.txt` 行号） | 账本 | sha256 前 12 位 |
  |---|---|---|---|
  | `h-off`（插件开着、meter 关） | `session-83321b8a…`（:48） | 不存在 | — |
  | `i-on`（meter、fusion、obs 开） | `session-1eb61325…`（:62） | 527 字节，21:57:27，1 行 | `6bc8c2d69c51` |
  | `j-plainpwsh`（同 i-on 配置） | `session-a600e583…`（:76） | 525 字节，22:00:52，1 行 | `d55ffba83bba` |
  | `l-uninstalled` | `session-a4bf89c7…`（:109） | 不存在 | — |

  - `i-on` 那一行原文：`usage` 为 uncachedInput 9573、output 1006、cacheRead 9344、cacheWrite 0，`compactionCalls: 0`，`requests: 2`。
  - 顺带得到一条反向证据：meter 关着（`h-off`）和卸载后（`l-uninstalled`）都没有生成账本目录，`~\.dsh\dsh-sol\` 下只有这两个会话的目录【已核实，`ledger-check.txt`】。
- **[低] cmd.txt 缺分析命令**：已补在 `cmd.txt` 末尾的 addendum 段，脚本是 `<lab>\tools\stage1-addendum.ps1`。以后每个 run 的分析命令跟着执行命令一起记。
- **[低] 429 没披露**：`h-off-turn.txt:27` 那轮上游 <local-provider> 返回 429（`deepseek-v4.1-flash`，`6004 model rate limit`，`until` 22:00:26）。所以 `h-off` 那轮模型没回答，但工具数是从请求头读的，不受影响。之后的 `i-on`、`j-plainpwsh` 换成了 GLM overlay（`g-on-glm.yml`：`zai-coding-cn` / `glm-5.3-flash` / `reasoningEffort: high`），不是默认的 <local-provider> 模型。这一点原文档没写清，这里补上。

## 顺带核实的一条

- Chief 记的“配置写的推理强度是 max，界面显示 High”：现在用的模型配置（`6c713d13378a`）里写的就是 `reasoningEffort: high`。会话请求头里也是 `reasoningEffort=high`（`h-off` 用的是默认 <local-provider> 模型；`i-on` 用的是 GLM overlay，它自己也写着 high）。所以界面显示没错，这一条不算问题了【已核实】。

## 走过的弯路（都在 result.txt 里，没删）

- 第 7 项第一次跑失败了：Windows PowerShell 5.1 把不带 BOM 的脚本里的中文读成乱码，匹配不上，还原 `zh.json` 也失败了。
  - 已经从本机源文件把 `zh.json` 拷回去，15 个文件重新核对 sha256，全部一致。
  - 第二次改用英文标题，脚本里只用 ASCII。
- 服务启动时打印的访问令牌，已经从 run 目录的所有日志里替换掉了。扫过一遍，残留是 0。

## 没做的

- load-check 第 5、6、8 项要用模型跑完整流程，或者要 dsh-ops 一起装，留给阶段 2。
- 除了 web 默认 preset，其他 preset 的工具可见性没测。
- dsh-ops 和 dsh-sol 一起装的情况还没测。
