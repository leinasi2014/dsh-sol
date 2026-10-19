# SoL-Pi → DSH 插件（dsh-sol）研究报告

日期：2026-10-18。研究已完成。同一天，用户让 Chief 统筹开工，开工定稿见 3.1、3.7、4.3。

**2026-10-18 16:20 开发完成**：5 个模块都写完了，也都接进了入口，每个默认关闭。当天 421 条测试连跑两遍全过，SolQA 终审通过。还没有装进任何 profile，也没提交。各步的交付说明在 `notes/step*-delivery.md`、`notes/step45-wiring.md`，装载前检查在 `notes/load-check.md`，安装和自检步骤在仓库根目录的 `README.md`。下文是设计过程和定稿，先研究后实现，结论以每节里的“v1 定稿”和“实现时容易踩的坑”为准。
**2026-10-19 真机验证**：在云主机上跑完阶段 1（装载）、2a（单插件）、2b（和 dsh-ops 一起装）、2c（Reducer）四轮，每个模块都在真实 DSH 里生效，真机查出的 bug 都已修好。现在 439 条测试全过（`npm test` 口径；其中 438 条是真实用例，多出的 1 条来自辅助模块 `test/fake-ctx.js`）。插件已装进桌面版（只开 Meter 和 actionFusion），代码已开源到 GitHub 的 `leinasi2014/dsh-sol`。结果和发现见第 5 节。
基准版本：DSH 桌面版 **0.2.1-rc.2**（安装目录下的 `resources/app.asar`，包内 `dsh/node_modules/@deepseek-ai/dsh/package.json`）。早先参考过的资料基于 0.2.0-rc.2，两版的差异会逐条写明。
标注：**【已核实】** 表示读过代码或文档，附证据；**【推断】** 表示从代码结构推出来的，没有实际跑过。

证据来源：
- `asar:<包>/<文件>:行`：app.asar 里 `dsh/node_modules/@deepseek-ai/<包>/` 下的文件，用只读 header 解析脚本读取，没有解包。
- 详细笔记：
  - [notes/solpi.md](notes/solpi.md)：SoL-Pi 源码拆解，`src/sol-pi` 下 21 个文件全部读过。
  - [notes/extension-points.md](notes/extension-points.md)：DSH 工具层、存储、配置。
  - [notes/extension-points-tools.md](notes/extension-points-tools.md)：工具注册、遮蔽、结果后处理（中途停掉的子代理写的，内容完整）。
  - [notes/extension-points-context.md](notes/extension-points-context.md)：上下文、压缩、生命周期。
- SoL-Pi：<https://github.com/NVlabs/SoL-Pi>（main 分支，通过 raw.githubusercontent 读取），博客 <https://nvlabs.github.io/SoL-Pi/>，论文 <https://arxiv.org/html/2609.20519v1>。

---

## 0. 一句话结论

SoL-Pi 依赖的是 Pi 的扩展 API。DSH 只用了 Pi 的 `pi-ai`，作为 LLM 适配层，**没有 Pi 的扩展 API**，所以没有代码可以直接复用，只能按 DSH 的原生 Cordis 扩展点重写【已核实：`asar:dsh-llm-pi-ai/package.json:46` 依赖 `@earendil-works/pi-ai@^1.1.0`，asar 里没有 pi-coding-agent】。

四个机制里：
- Action Fusion、Reducer、OCC 可以纯插件实现。
- ObservationPack 不能做成 Pi 那种“临时投影”，只能做成“持久替换”。好在 SoL-Pi 的占位符本来就是稳定、单调的，两种语义的效果基本相同。
- 每一项都不需要改 DSH 核心。

建议的顺序：
1. 先做插件骨架和 token 计量。没有计量，后面无法证明省没省。
2. 再做 Action Fusion。
3. 然后是 ObservationPack 和 OCC。
4. 远程 Reducer 最后做，或者不做。

---

## 1. DSH 实际的扩展点

| # | 扩展点 | 用法 | 证据 | 状态 |
|---|---|---|---|---|
| 1 | 插件形态 | npm 包。`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`（`- insert: [{id,name,config,disabled}]`）。Host 面是 `dist/index.mjs`，导出 `name/inject/Config/apply`；浏览器面是 `exports["./client"]` 加 `dsh.client{platform:'web'}` | `asar:dsh-base/cordis.patch.yml:1-15`；`asar:dsh-client-ui-plan/package.json:21-43` | 已核实 |
| 2 | 版本闸门 | 有 `engines.dsh` 时只看它；没有时，每一个 `@deepseek-ai/dsh-*` peer 都必须满足运行时版本，否则整个 bundle 被跳过 | `asar:dsh-app-boot/lib/index.js:279-299`（本轮复查过原文） | 已核实 |
| 3 | 注册工具 | `ctx.tools.register(defineTool({...}))`。按 scope 注册，`ctx.tools.get(name, scope)` 解析 | `asar:dsh-tools/lib/index.js:2974`；`asar:dsh-tools/README.md:85` | 已核实 |
| 4 | 工具调用流水线 | `tools/pre-execute`（allow/deny/ask）→ `guard` → `tools/execute`（包住执行）→ `tools/post-execute`（可以替换 content 或 value，也可以 block、追加 additionalContexts）→ `finalizeContent` → `tools/result`（只读） | `asar:dsh-tools/README.md:89-91`；`lib/index.js:3321/3017/3427/3600-3632/3513` | 已核实 |
| 5 | 参数不可改写 | `pre-execute` 不能改 `exec.arguments` | `asar:dsh-tools/README.md:233`（本轮复查过原文） | 已核实 |
| 6 | 长输出落盘（原生） | `dsh-spill-policy` 挂在 post-execute（prepend，先 `await next()`）。超过 `maxInlineTokens`（本机 12500）就把全文写进 `tmpdir/dsh-spill-*/session-<sha12>/`，模型拿到头尾预览和**本机绝对路径**；`read` 的结果放行；失败时保留原文 | `asar:dsh-spill-policy/lib/index.js:24-27,141-260`；`asar:dsh-spill-local/lib/index.js:30-79`；desktop profile 的 `cordis.yml` | 已核实 |
| 7 | 压缩时剪大结果（原生） | `tool-result-pruner` 只在压缩触发时运行，>8192 字符时保留头 4096、尾 1024。做法是 surface replace，原文留在日志里，可以通过 `sourceEventSeqs` 回溯 | `asar:dsh-compaction-tool-result-pruner/lib/index.js:137-191` | 已核实 |
| 8 | 压缩服务 | `ctx.compaction` 是可替换的 Service，提供 `compactIfNeeded / compactNow（要求空闲）/ compactRegion（要求回合打开）`。`BasicCompactionEngine` 已导出，可以继承；**唯一的覆写钩子是 `summarize()`**，没有 customInstructions | `asar:dsh-compaction/lib/index.js:169-173`；`asar:dsh-compaction-basic/lib/index.js:800-1025,899-903,831-832` | 已核实 |
| 9 | 自动压缩（原生） | basic 在每个 `agent/pre-step` 检查：阈值 `min(0.8W, W−O−65536)`，保留尾部 16%；上下文溢出时压缩再 retry；有 `auto` 开关。本机每个 agent preset 都有一个隔离的 compaction group | `asar:dsh-compaction-basic/lib/index.js:839-887`；`cordis.yml:840-855`（另见 1004、1092、1267 行） | 已核实 |
| 10 | 生命周期 | `agent/pre-step`（waterfall，只能替换本步的新输入）、`agent/request`、`agent/request-error`、`agent/turn-stopping`、`agent/status`（idle/running）；会话事件 `turn/start/end`、`step/start/end`；agent 句柄 `followup/steer/inject/cancel/whenIdle/runMaintenance` | `asar:dsh-agent-loop/lib/index.js:790-875,909,1001,1136,1191` | 已核实 |
| 11 | provider 请求钩子 | `llm/stream` waterfall，每次 provider 尝试都会触发，可以观察或包装流、读 usage。**不能改写 messages**：请求被深冻结，`next()` 不接收参数 | `asar:dsh-llm/lib/index.js:2393-2398`；`asar:cordis/lib:317-325`；`asar:dsh-agent-loop/lib/index.js:1274-1288` | 已核实 |
| 12 | token 和窗口 | `ctx.tokenMeter.measure(session).totalTokens`；`ctx.llm.resolveModelInfo(p,m).context.contextWindow`。会话 tokenUsage 只统计 `assistant/message` 和 `assistant/attempt` | `asar:dsh-token-meter/lib/index.js:368-372,722`；`asar:dsh-compaction-basic/lib/index.js:936-940` | 已核实 |
| 13 | 插件内调用模型 | `ctx.llm.stream({provider,model,messages,purpose,signal})` 配合 `BlockAssembler`，复用宿主的路由和凭据。范本是 `summarizeWithLlm` | `asar:dsh-compaction-basic/lib/index.js:292-338`；`asar:dsh-llm/README.md:12` | 已核实 |
| 14 | 会话存储 | 日志在 `$DSH_HOME/sessions/<项目>/<id>/*.jsonl`，**插件拿不到会话目录的公开 API**。`appendPluginRecord` 存在（0.2.1 新增），但 README 写明**外部插件不得调用**。状态可以用 `ctx.sessionProjections.register(fold)` 重放 | `asar:dsh-session-persistence-jsonl/lib/index.js:908-932`；`asar:dsh-session/README.md:68-70`（本轮复查过原文） | 已核实 |
| 15 | 插件私有存储 | `ctx.storageDomain.open(defineDomain(...))`（json 后端，`$DSH_HOME/storages`），或者自己建 `$DSH_HOME/<插件>/`。team-studio 用的是后者 | `asar:dsh-storage-domain/README.md:12,36-58`；`<reference-plugin>/dist/index.mjs:10863-10865` | 已核实 |
| 16 | 配置 | `Config = z.object(...)`（schemastery）加 `.default()`；值写在 patch 行的 `config:` 下，**整行替换，不合并**；可以在行上写 `disabled: true`。设置 UI 只显示 `.volatile()` 字段 | `asar:dsh-base/cordis.patch.yml:6-10`；`asar:dsh-settings/README.md:12,39` | 已核实 |
| 17 | 浏览器面 | `ctx.slots`（main/sidebar/settings/plugins.*）和 `tool.call.toolview`（按工具名注册卡片，没注册的用通用卡片） | `asar:dsh-client-ui-tool/README.md:36-50` | 已核实 |
| — | hooks 桥 | `dsh-hook-protocol`、`dsh-hooks-claude-code`、`dsh-hooks-codex` **0.2.1 的 asar 里没有**，只在 devDependencies 中出现 | `asar:dsh/package.json:115-116` | 已核实 |

0.2.0 和 0.2.1 的差异：
- `appendPluginRecord` 是 0.2.1 新增的。
- hooks 包在 0.2.1 里没有打包进去。
- asar 里没有 `.d.ts`，签名只能参考 0.2.0 的副本，同名事件已经在 0.2.1 的 JS 里确认存在。
- team-studio 的 peer 钉在 0.2.0-rc.2，按条目 2 的规则，它在 0.2.1 上会被跳过【推断：规则已核实，没有实际看到 skippedBundles】。

---

## 2. 四个机制逐个对照

### 2.1 Action Fusion：编辑或写文件后，在同一次调用里跑校验命令

- **Pi 侧**：用 `registerTool` 覆盖内置的 edit 和 write，加一个可选参数 `then_run:{command,timeout?}`，按文件排队；修改前后各算一次 sha256，内容变了就跳过命令；结果上标 `[then_run:succeeded|failed|skipped]`【已核实，solpi.md】。
- **DSH 对应**：`pre-execute` 不能改参数（扩展点 5），post-execute 也拿不到模型没传的参数。要让模型能传 `then_run`，只能**注册一个带新 schema 的工具**。有两种做法：
  - a) 新起一个工具名，比如 `write_then_run`、`edit_then_run`。内部用嵌套的 `ctx.tools.execute({ name: 'edit' | 'pwsh', parent: exec.token, ... })` 依次调用内置工具，两步都走完整的 pre-execute 审批、guard 和超时【已核实：`asar:dsh-tools/lib/index.js:3212`、`:3310-3352`】。不直接调 `ctx.shell`：那样拿到的是部署默认的沙箱策略，不是当前会话的，也不会弹审批【已核实：`asar:dsh-pwsh-sandbox/lib/index.js:140-148`】。命令没跑成时返回 `[then_run:not_run]`，并原样附上原因。“没跑成”包括用户拒绝、被策略拦下、没有可用的 shell、沙箱准备失败、被取消。这是 DSH 版新加的标记。用户拒绝和策略拦截不再分开标：两者都从 pre-execute 返回 `isError` 加 `Error: <原因>`，插件分不出来，原因原文已经足够模型判断【已核实：`asar:dsh-tools/lib/index.js:3326-3352`】。跑命令时，按 `actionFusion.shells` 的顺序挑 shell，默认先 `ops_bash`，见 3.3、3.7。（2026-10-18 开工定稿修订）
  - 结果怎么分（2026-10-18 按 SolDev 的 step2-facts 定稿）：
    - 嵌套 shell 调用返回 `isError: true`，就是命令没跑成，标 `not_run`。拒绝、取消都在这一类。非 0 退出码不算出错，只在内容里标出来【已核实：`asar:dsh-tool-pwsh/lib/index.js:132-136`；`dsh-ops/lib/shells.js:861`】。
    - 注意 ops_bash 起不来时**不**走 `isError: true`：它返回 `isError: false`，`value` 里有 `error`，没有 `exitCode`【已核实：`dsh-ops/lib/shells.js:1098-1105`；2026-10-19 真机 2b 现场见 notes/live-load-2b.md 问题 1】。正常退出时 `exitCode: 0` 一定在：只有退出事实未知时才省略这个键【已核实，SolQA 反证、SolDev 复核：`dsh-ops/lib/shells.js:1091`、`dsh-ops/CHANGELOG.md:255`、`asar:dsh-subprocess-local/lib/index.js:480-495`；真机 r5 `exit 0` 标 `succeeded`】。
    - `isError: false` 时看 `value`，**按下面的顺序判断，先看 `kind`**（和 `lib/fusion.js` 的 `classify` 一致）：
      1. `value` 不是对象：标 `failed`，没有东西能证明命令成功。
      2. `kind` 是 `"promoted"` 或 `"background"`：标 `failed`，把 `jobId` 原样带给模型，并写明命令还在后台跑。这两种结果里没有 `exitCode`，也没有 `timedOut`【已核实，SolDev：`asar:dsh-tool-pwsh/lib/index.js:503-535`】。
      3. `timedOut` 为真：标 `failed`，写明超时。
      4. `value.error` 是非空字符串：标 `not_run`，原因用 `error` 原文。
      5. `signal` 存在：标 `failed`，写明信号名。信号优先于退出码 0：pwsh 的 schema 要求 `exitCode` 和 `signal` 都必填，两个可能同时出现。
      6. `exitCode === 0`：标 `succeeded`。
      7. 其余（非 0、`null`、缺这个键）：标 `failed`。
    - **总原则：成功必须由退出码 0 证明，缺什么都不算成功。** 2026-10-19 修订：旧规则“退出码没给就算成功”，把 ops_bash 起不来误标成了 `succeeded`（2b 真机发现）。模型看到成功会以为命令跑过了，这比误标成 `failed` 更危险。
    - pwsh 超时以后转后台，是 pwsh 插件的部署配置 `promoteOnTimeout`，默认开着，单次调用关不掉（`asar:dsh-tool-pwsh/lib/index.js:245-248`）。`background` 只在显式要求后台运行时出现，Fusion 不传这个参数，这一支只是防御。
    - 细节和证据见 [notes/step2-facts.md](notes/step2-facts.md)。
  - 接口定稿（2026-10-18，回答 SolQA 验收清单里的 4 个问题）：
    - **四个标记**：
      - `succeeded`、`failed`：命令跑了。
      - `not_run`：发出了 shell 调用，但没跑成，或者根本找不到可用的 shell。
      - `skipped`：改文件成功了，但改完以后文件又被别处改了，Fusion 决定不跑命令。
      - 区分 `not_run` 和 `skipped`，模型才知道该处理环境问题，还是该先看文件。
      - **改文件失败时不返回标记，整个工具调用直接报错**，错误信息用 edit 自己的原文（2026-10-18 采纳 SolDev 的实现）。如果返回“成功 + skipped”，模型会以为文件已经改好了。
    - **出错让路的具体做法**（SolDev 实现，Chief 认可）：普通对象注册的工具，返回值必须符合自己声明的 `output.schema`，否则会抛 `ToolOutputError`（`asar:dsh-tools/lib/index.js:3637-3640`），所以没法把 edit 的结果对象原样交回。实际做法是：一字不改地保留 edit 渲染出来的文本，放在最前面，后面接 Fusion 的说明。代价是界面上显示的是通用卡片，没有 diff 卡片。要 diff 卡片就得用 `defineTool`，那就违反了 3.2。
    - **`classify(result)`**：传入嵌套 shell 调用返回的完整结果（含 `isError`），只返回 `not_run`、`succeeded`、`failed` 三者之一。`skipped` 在调用 shell 之前就决定了，不经过 `classify`。
    - **then_run 的参数**：只有 `{ command, timeout? }`。`command` 是非空字符串，`timeout` 以毫秒为单位，原样传给 shell 的 `timeoutMs`。不收 `script_path`，所以传给 `ops_bash` 的参数里永远不会同时出现 `command` 和 `script_path`。参数不合法时，在改文件之前直接报错，文件不动。
    - **“文件被别处改过”的判断**：edit 和 write 成功时都会返回 `{ path, after }`（`asar:dsh-tool-fs/lib/index.js:714-733`、`:564-588`）。跑命令之前重读一次 `path`，内容和 `after` 不一样，就标 `skipped`。重读失败（比如路径在沙箱或远程环境里，宿主读不到），不拦，照常跑命令。这只是一层兜底：工具本来就是独占调度的，同一步里不会有别人并发改文件。这一步只做比较，不存内容，不扩大暴露面。 `edit`/`write` 覆盖祖先 scope 的定义。自己这一层注册的工具会盖过从全局层和祖先层继承来的同名工具【已核实：`asar:dsh-tools/lib/index.js` 的 `view()`，约 3055-3081 行】。但内置 edit/write 是由 preset 注册的，它对 agent 来说算祖先层还是同一层没有核实；如果是同一层，重复注册会抛错【推断，见 notes/extension-points-tools.md:73-74】。
- **原生同类能力**：没有。DSH 的模型可以在下一步调 `pwsh`，但这样多一轮模型请求，正是 Fusion 要省掉的那一轮【已核实：内置工具清单里没有组合执行的工具】。
- **纯插件**：可以。建议用 a)，不碰内置工具的名字，风险最小【推断】。
- **注意**：Windows 下 `bash` 被禁用（`asar:dsh-base/cordis.patch.yml:281-283`），命令要走 pwsh【已核实】。pwsh 的 `description` 参数是必填项，由插件代填【已核实：`asar:dsh-tool-pwsh/lib/index.js:466-472`】。命令必须经过宿主的沙箱策略。SoL-Pi 自己不做沙箱，只是把命令原样交给 bash【已核实】。
- **收益**：论文的反事实估计是模型轮次 −10.8%，token −11.5%【已核实：论文文字；数字本身是论文作者的估计，不是我们测的】。

### 2.2 ObservationPack：大段输出换成稳定句柄，可以分页精确回读

- **Pi 侧**：在 `context` 事件里改写**每次请求的投影**，不动历史。纯文本、非错误、大于 10 KiB 的结果，前 2 次请求照常发全文，从第 3 次起换成固定的占位符（句柄、大小、头尾各 512B），再配一个 `obs_recall{id,offset}`，每页最多 16 KiB 或 400 行。存档写在 `<sessionDir>/sol-pi/<id>/observation-pack/`，带 ledger【已核实，solpi.md】。
- **DSH 对应**：没有 `context` 那样的临时投影钩子（扩展点 11）。可行的路有三条：
  - 执行时替换：在 post-execute 里直接换成句柄。这样等于没有“前 2 次全文”。
  - pruner 式 surface replace：在 `agent/pre-step` 里把旧的 `tool/result` 持久替换掉，原文留在日志里（扩展点 7）。
  - 自定义事件类型配 `ctx.sessions.registerMessageProjection`：改的是派生历史，不动原始事件。代价是会话从此离不开这个插件，日志里有这类事件而插件没加载时，派生会直接报错【已核实，notes/extension-points-tools.md:139】。
  SoL-Pi 的占位符从第 3 次请求起就稳定不变、不会再被改写，所以“持久替换”和它的实际效果等价，KV cache 失效的位置也一样【推断】。
- **原生同类能力**，重叠程度高：
  - spill-policy 已经在执行时做了“超长输出只给头尾，加落盘路径”，模型用 `read` 加 offset/limit 就能回读（扩展点 6）。
  - pruner 在压缩时也会剪大结果。
- **还剩的增量**：
  1. 阈值。SoL-Pi 是 10 KiB，大约 2.5k token。本机 spill 是 12500 token，大约 50 KB。中间这一段（10–50 KB）DSH 现在每次请求都全量重发【已核实：两个阈值；推断：这一段的输出很常见，需要实测】。
  2. 存档稳定。spill 文件在 tmp 里，按进程建目录，30 天清理，跨进程会断；SoL 的存档是按内容哈希、和会话绑定的【已核实】。
  3. “先全文后折叠”。spill 一开始就截断，模型第一次就看不到全文；SoL 先给两次全文【已核实】。
  4. 精确回读。spill 给的是路径，`read` 本身就能按行精确读回原文，所以这一项增量很小【推断】。
- **纯插件**：Pi 的临时投影语义做不到。持久替换版本可以纯插件实现，但 **surface replace 不是给外部插件准备的 API**：pruner 是通过 compaction 的契约去做的，`session.append` 会校验 surfaceOp。没有官方说明允许外部插件这样调，属于政策风险【已核实：没有找到说明；推断：能不能跑通】。
- **v1 定稿（2026-10-18，依据 Researcher 的 [step3-facts.md](notes/step3-facts.md)）**：
  - 在 post-execute 里替换。超过 `thresholdBytes` 就替换，第一次出现也替换。不做“前 2 次发全文”。
    - Researcher 推荐的另一种做法是：同样的内容第 N 次出现才替换。没采纳，原因有二。一是一份大输出通常只出现一次，按这个规则几乎不会触发。二是 spill 已经在 12500 token 以上做了同样的事，模型从第一次起看到的就是头尾预览，这个代价可以接受。
  - 跳过：`isError`、嵌套调用、含图片、`read` 工具、Fusion 的结果（不只替换 `[then_run:*]` 后面那一段，免得两个模块缠在一起），以及 Reducer 的回执。
  - 替换时把 `additionalContexts` 原样带上，repeat-tool-reminder 会往里面加提醒。
  - 整段 try/catch，出错就把原结果交回（防护规则 3）。
  - 工具名用 `exec.name`，会话 id 用 `exec.agent?.session.header.id`。exec 上没有 `toolName` 和 `sessionId` 字段。
  - `obs_recall` 照 `todo_write` 的写法在全局注册，写成普通对象（见 3.2）。
  - 规格见 [notes/step34-spec.md](notes/step34-spec.md)（SolArch）。2026-10-18 定的几条：
    - `obs_recall` 只收 `id` 和 `offset`，每页固定最多 16 KiB 或 400 行，不收 `limit`。
    - 不能砍掉它，改让模型用原生 `read`：`read` 会把超过 2000 字符的行截断（`asar:dsh-tool-fs/lib/index.js:17,28-30`），压缩过的日志常是单行长 JSON，一截就丢证据。
    - 两种结果永远不替换：Fusion 的结果（`edit_then_run`、`write_then_run`），以及 Reducer 的回执（标记行 `dsh-sol_evidence_receipt_v1`，`sol_pi_` 前缀的也认）。
    - ObservationPack 和 Reducer 共用一个 `objects/` 目录，同样的内容只存一份。

### 2.3 Evidence-Preserving Reducer：长诊断日志压成带逐字引文的回执

- **Pi 侧**：挂在 `tool_result` 上。只处理诊断命令（pytest、cargo、make、npm test 等），日志大于等于 4 KiB，并且不含疑似密钥。把日志发给低成本模型，返回 JSON 回执；回执要做确定性校验：schema、源哈希、状态，每条 quote 都必须是原文的精确子串，失败时必须带 failure 证据，回执还必须比原文小。任何一项不通过，都保留原结果。原文按 sha256 存档，回执里给出存档路径【已核实，solpi.md】。
- **DSH 对应**：`tools/post-execute`（扩展点 4）加 `ctx.llm.stream`（扩展点 13），存档放插件私有目录（扩展点 15）。所有校验都是纯函数，可以直接照搬【推断】。
- **原生同类能力**：没有语义摘要。spill 和 pruner 都只做头尾截断【已核实】。
- **纯插件**：可以【推断】。注意几点：
  - 嵌套调用不计入会话 tokenUsage（扩展点 12），省下多少、花了多少都要插件自己记。
  - post-execute 的耗时算不算进工具超时，没有核实。推断不算，因为超时策略只包住了 `tools/execute`。
  - 这次调用不进会话日志，Meter 读不到它。Reducer 按返回的 usage 自己往账本记一行（kind: reducer），A/B 对比时算进成本。Meter 不包 `llm/stream`，见 3.1。
- **安全**：会把日志全文发给远程模型。SoL-Pi 的密钥检测只是一个正则，SECURITY.md 自己也说它“不是完整的扫描器”【已核实】。
- **v1 定稿（2026-10-18，依据 Researcher 的 [step4-facts.md](notes/step4-facts.md)）**：
  - 只有显式配了 `reducer.provider` 和 `reducer.model` 才发请求。不抄 compaction 的“没配就用当前会话模型”的回退。
  - 请求必须设 `purpose`，不传 sessionId。否则在群会话里，请求会被 ds-bot 的群转发钩子截走（`ds-bot/src/host/groups.js:846`）。
  - post-execute 外面没有超时。所以把 `exec.signal` 和自己的超时（`reducer.timeoutMs`）合在一起，超时或取消就保留原结果。
  - 直接读流，不 import `BlockAssembler`（见 3.2）。
  - 只处理没被截断的结果（3.5），Fusion 的结果不处理。
  - 处理哪些结果（2026-10-18 采纳 SolArch 的 [step34-spec.md](notes/step34-spec.md)）：不用诊断命令的正则清单，改成同时满足以下几条：
    1. 顶层调用的 shell 结果；
    2. 判定为失败，直接复用 Fusion 的 `classify(result)`；
    3. 不是转后台（`kind` 不是 `promoted`、`background`），因为转后台时输出还不完整；
    4. 输出 ≥ 4 KiB；
    5. 没有疑似密钥。
    - 正则清单总有漏网的，比如 bun、vitest、dotnet，而失败的输出才最需要保留证据。成功的输出不压。
    - 代价：一旦开启，所有超过 4 KiB 的失败命令输出都会发给配置的模型，不只是测试和构建的。这条写进 3.5。
    - **实现时容易踩的坑**（2026-10-18，SolArch 和 SolQA 审查第 4 步时查出）：
      - “失败”不能用 `result.isError === true` 来判断。命令跑完但退出码非 0 时，结果是 `isError: false`，退出码放在 `value` 里。`isError: true` 只在命令根本没跑成时出现，这时也没有输出（2.1）。按 `isError` 判，测试失败的长日志一条都压不到，压到的反倒只有不带输出的报错。正确的顺序是：
        1. 工具名在 `actionFusion.shells` 里；
        2. `isError` 不为 true；
        3. `value.kind` 不是 `promoted` 或 `background`；
        4. `classify(result) === 'failed'`。
      - 疑似密钥的检测要放宽。原来的正则漏了 19 种常见写法里的 11 种（SolQA 实测）。补上：
        - 关键词：`password`、`passwd`、`pwd`、`token`、`private_key`、`cookie`、`session_id`；
        - 不需要 `=` 或 `:` 也能命中的写法：`-----BEGIN … PRIVATE KEY-----`、`sk-…`、`ghp_…`、`AKIA…`，以及 URL 里带的 `user:pass@`。
        - 误判的结果只是这条不压缩，原样保留，所以宁可多判。它仍然只是尽力而为，不能当成脱敏。
      - `ctx.llm` 在调用时用 `ctx.get('llm')` 取，取不到就跳过，账本记一条原因。不写进 `inject`：写进去的话，Reducer 没开、只开了 Meter 时，缺 llm 也会让整个插件不激活（Researcher 的 [load-check.md](notes/load-check.md)）。
  - 默认超时 `reducer.timeoutMs: 20000`（SoL-Pi 是 90000）。卡住的是用户这一步，等 90 秒太久。超时用 `AbortSignal.any([exec.signal, AbortSignal.timeout(...)])`，读流的循环里也要检查 `signal.aborted`。
  - 回执的五项校验（JSON、schema、引文是原文的精确子串、失败时必须带证据、比原文小），有一项不过，整份回执就作废，保留原结果。

### 2.4 Online Context Compact：计划步骤完成后，按经济性主动压缩并继续

- **Pi 侧**：
  - 计划边界：注册 `update_plan` 工具，某个已登记的步骤从未完成变成 completed，就算一个边界。
  - 判定：在 `turn_end` 里按“压缩后的缓存重写成本”和“剩余请求里能省下的量”算经济性（`cacheWriteReadRatio`，默认 12.5）；冷却期是 2 次请求；离窗口上限不到 16384 token 时强制压缩。
  - 执行：先 `abort`，在 `agent_settled` 里调 `compact`，成功后发一条隐藏消息并 `triggerTurn`，开新一轮继续。状态写进 custom entry【已核实，solpi.md】。
- **DSH 对应**：
  - 计划边界：监听 `session/event` 里的 `todo/write`，它每次都是整表替换（`asar:dsh-tool-todo/lib/index.js:170-173`），对比前后两份就能识别边界。也可以自己注册 `update_plan`。
  - 判定：在 `agent/pre-step` 里用 `tokenMeter` 加 `resolveModelInfo` 做经济性判断。
  - 执行：调 `compaction.compactRegion` 或 `compactIfNeeded`。**回合本来就开着，压完直接进下一步**，不需要 Pi 那套 abort、settled、triggerTurn 的流程，比 Pi 简单（扩展点 8、9、10）。
  - 请求计数改成数会话事件里的 `assistant/message`。不包 `llm/stream`，因为 ds-bot 会把请求重发一遍（见 3.7）。
  - **只管非 Bot 会话**：Bot 会话的压缩由 ds-bot 接管，外部调用 `compactRegion` 会被直接拒绝；普通会话和子代理不受影响【已核实：`ds-bot/src/host/parts.js:178-182,186-221`】。被拒一次，这个会话就不再试。v1 也不覆写 `summarize()`，因为 ds-bot 同样包了这一层（`:222-227`）。
  【已核实：每个 API 都存在；推断：组合起来能不能跑通】
- **原生同类能力**：basic 已经有按压力触发、溢出恢复、pruner、`/compact`、checkpoint 摘要。SoL 的增量只有两样：一是“在步骤边界、按经济性**提前**压”，二是定制摘要指令（要继承 `summarize()`）。原生大约覆盖 60–70%【推断】。
- **纯插件**：可以，有三个限制：
  - compaction 按 preset 隔离（`isolate: {compaction: true}`），插件得在 agent scope 里拿服务，或者挂进同一个 group【推断】。
  - basic 的 `auto` 不关，两边会抢锁（busy）。
  - 状态不能写进会话日志（扩展点 14），只能放 storageDomain，按 sessionId 做键。
- **收益前提**：经济性模型依赖“缓存写入比读取贵 12.5 倍”这个 Anthropic 式的计价。实际用的 provider 各不相同，各自的缓存计价没有核实，`cacheWriteReadRatio` 必须按实际 provider 配置，否则判定会失真【推断】。
- **v1 定稿（2026-10-18，采纳 SolArch 的 [step5-facts.md](notes/step5-facts.md)）**：砍到最小，先只记录、不真压。
  - 砍掉：经济性模型（`cacheWriteReadRatio`，本机的缓存计价没核实，套用 12.5 一定失真）、冷却期、请求计数、隐藏消息续跑、覆写 `summarize()`、自己注册 `update_plan`、跨回合重建 todos、状态持久化。
  - 规则：
    1. 内存里记每个会话最近一份 todos。`todo/write` 到来时和上一份按 content 对比，有一条从“未完成”变成 `completed`，就记一个边界。不能靠 todos 投影，它在 `turn/start` 时会被清空（step5-facts 第 5 条）。
    2. 下一个 `agent/pre-step`：有边界，并且上下文占用 ≥ 触发线，就选一段旧历史。窗口大小拿不到时跳过，不报错。
       - 触发线 = min(`thresholdRatio` × W, 0.85 × 原生触发线)。`thresholdRatio` 默认 0.5。原生触发线 = min(0.8W, W − O − 65536)，W 是窗口，O 是最大输出。
       - 为什么要加 0.85 这一层：本机主力模型 W = 1,000,000，O = 384,000，原生在 550,464，也就是 55% 就压了，不是 80%。小窗口更明显：128k 窗口配 8k 输出，原生在 42.5% 就压。只用 0.5 的话，OCC 永远比原生晚，等于不起作用【已核实：SolArch 查了三个真实会话的 `request/header`；0.85 是推断，由干跑数据来校准】。
    3. `dryRun: true`（默认）：每做一次判定往账本记一行（kind: occ-dry），带上占用率、两条触发线、选中的范围和 `decision`。不是每回合都记，也不调压缩。字段见 step5-facts 第 10.3 节。
    4. `dryRun: false`：compaction 服务按 `agentPresets.serviceFor(agent, 'compaction')`、`ctx.get('compaction')` 的顺序取，调 `compactRegion`。返回 busy 就让路，不重试；被 ds-bot 拒绝，就记住这个会话，以后不再试。
    5. pre-step 里无论走哪条路，都 `return next()`。
    6. **选范围时，工具调用是否成对自己算，不 import `toolPairingBalanced*`**（那是 `@deepseek-ai/dsh-compaction` 的导出，见 3.2）。算法照原生的写：按 surface 顺序数还没闭合的 tool-call，归零的位置就是可以切的点（`asar:dsh-compaction/lib/index.js:19-58`）。算不出来就返回 null，跳过这次，不报错。伪代码见 step5-facts 第 10.1 节。
  - 原生的自动压缩，在本机主力模型上 55% 左右就动手了，不是 80%。OCC 的增量只在“还没到原生触发线，但已经过了计划边界”这一段，比原来估的更窄。所以先用干跑数据定阈值，再打开真压。

### 汇总

| 机制 | DSH 挂点 | 原生重叠 | 纯插件 | 增量 |
|---|---|---|---|---|
| Action Fusion | 新工具 `*_then_run` + 嵌套 `ctx.tools.execute` | 无 | 可以 | 每次“改完就测”省一轮请求 |
| ObservationPack | post-execute 或 pre-step 的 surface replace，外加 `obs_recall` | 高（spill + pruner） | 只能做持久替换版；surface replace 有政策风险 | 10–50 KB 区间、稳定存档、先全文后折叠 |
| Reducer | post-execute + `ctx.llm.stream` | 无 | 可以 | 诊断日志的语义压缩；要把日志外发 |
| OCC | pre-step + compaction 服务 + todo 事件 | 中高（basic 自动压缩） | 可以，要调 preset 配置 | 在步骤边界、按经济性提前压缩 |

---

## 3. 推荐方案

### 3.1 顺序

2026-10-18 开工定稿。用户让 Chief 统筹，范围定为第 1、2 步，后面几步看计量数据再定。

1. **骨架 + 计量**：只观察，零风险。
   - 不包 `llm/stream`。ds-bot 会把带密钥的请求换掉密钥后重发一遍（`bot/src/host/secrets.js:465-473`），包在那里会重复计数、分错类。
   - 主循环的 token 直接读原生的 `tokenUsage` 投影：`ctx.sessionProjections.stateOf(session, 'tokenUsage')`。它已经按四个桶记好，重试也处理过了【已核实：`asar:dsh-token-meter/lib/index.js:393-426,689-696`】。
   - 外部插件读这个投影没有时序问题：投影可以晚注册，第一次读取时会从内存里的日志补算【已核实：`asar:dsh-session-projection/lib/index.js:32-42,120-131`】。
   - 自己只补一样：压缩那次调用的 usage（`compaction/summary` 事件，原生不计）。
   - 每回合结束往账本记一行：sessionId、turn、`turn/end` 的 seq、四个桶的累计数、压缩累计数。离线脚本按会话汇总出 A/B 报告。
   - 实现细节（SolQA 预审，Chief 核实，2026-10-18）：
     - 四个桶在 `stateOf(...)` 返回值的 `.totals` 里，不在顶层。返回的是活对象，拷一份再用，不要留着引用【已核实：`asar:dsh-token-meter/lib/index.js:349-356,393-399`】。
     - fork 出来的会话：投影是从整份日志从头折的，累计数里含父会话那段（`init` 不看 `inheritedEventCount`）。做法：
       - 在 `session/created` 时读一次 totals 当基线，之后每行记“当前累计 − 基线”。
       - 什么时候能取基线（2026-10-18 第二次修订，SolQA 查出，Chief 核实）：
         - 没 seed 的会话：基线是 0，什么时候第一次见到都一样。
         - 有 seed 且 `session.firstLifecycleSeq < session.firstLiveSeq`：这是新 fork 出来的会话，在 `session/created` 时取基线，标 `fork`。
         - 有 seed 但两者相等：这是从磁盘恢复的 fork。投影折的是“父前缀 + 子会话自己恢复前的历史”，拿它当基线，会把恢复前的量全丢掉。所以标 `unknown`，不参加对比。
         - 有 seed 但第一次见到时不在 `session/created`：标 `unknown`。
         - 证据【已核实】：`firstLifecycleSeq` 是公开字段，源码注释写明“新 fork 包含自己的 seed 标记和收尾事件；恢复的会话从完整的存储前缀之后开始”（`asar:dsh-session/lib/index.js:1361-1366`）；只有 snapshot 模式加 isSeeded 才设成 `inheritedEventCount`（`:1426`）；fork 的 seed 在前缀后补 `session/end-seed` 和收尾事件（`:927-936`）。它不在 README 的契约里，换版本时要复查【推断：风险】。
         - 两种写法不能用：`seq === inheritedEventCount`（seed 后面多了标记事件，永远对不上）；`firstLiveSeq === seq`（恢复的 fork 也成立，分不出来）。投影 README 也明说过，不要从 `firstLiveSeq` 推断 fork 的切点（`asar:dsh-session-projection/README.md:54`）。
         - 完全正确的做法是自己注册一个投影，`apply` 跳过 `seq < inheritedEventCount` 的事件（范本：`dsh-subagent/lib/index.js:789-795`）。但那样要抄一份 token-meter 的折叠逻辑（重试替换、桶名），以后会和原生漂移，所以放到 v2。
       - 测试必须用真实形状：新 fork 用 snapshot 构造，`seq = inheritedEventCount + 1 + 收尾事件数`；恢复的 fork 两个字段相等。不能手写假会话。
       - 压缩只数 seq ≥ `inheritedEventCount` 的 `compaction/summary`。
       - 行里带上 `isSeeded` 和 `parentSession`。
       - 证据【已核实】：fork 会带 seed、`inheritedEventCount`、`parentSession`、`isSeeded`（`asar:dsh-session/lib/index.js:2006-2022`）。
       - 插件加载时已经开着的会话没有基线，这类行标 `baseline: "unknown"`，汇总时单独列，不混进对比。
       - 子代理会不会走 fork，要实测【推断】。
     - 重复行：`report.js` 按 `(sessionId, seq)` 去重。同一个包挂进多个 preset 时会实例化多份（`asar:dsh-session-projection/lib/index.js:39-42`）。
     - `session/event` 是在 commit 里同步通知的。监听器里不做同步 IO，也不回头 `session.append`。写盘用异步，不等待，带 catch【已核实，SolQA：`asar:dsh-session/lib/index.js:1567,1592`】。
     - `Config`：v1 先用 `lib/config.js` 手写校验，不导出 `Config`。
       - 代价：激活前 DSH 不校验 config，设置页也看不到字段【已核实：`asar:dsh-app-boot/lib/index.js:2447-2451` 只认 schemastery 标记】。
       - `@deepseek-ai/schemastery` 在 asar 里有，但外部插件 link 安装后能不能 import 到它，还没核实。第一次装进 web profile 时一起验，能用再补上导出。
2. **Action Fusion**：与原生没有重叠，不碰上下文和压缩，代码量最小（SoL-Pi 里约 380 行），本身无存档、不调远程模型。跑命令优先用 `ops_bash`（见 3.7）。
3. **ObservationPack**：先做执行时版本（在 post-execute 里替换，阈值可配，收到的内容存进插件存档，加 `obs_recall`），不走 surface replace，避开政策风险。先用计量数据确认 10 KiB 到 spill 阈值之间的输出真的常见，不常见就不做。
4. **Reducer**：可选。要做也只走用户明确指定的模型，日志外发前必须显式开启。
5. **OCC**：最后做。只对非 Bot 会话有用，而日常主要用的是 Bot 会话。等 1 积累出真实的请求和缓存数据，再定 `cacheWriteReadRatio`。

### 3.2 插件结构

纯 JS（ESM），不编译，零依赖，和官方模板一样（`official/cordis-plugin-development/templates/decoration/package.json`）。这样不需要 `dist/`，也不用 npm install（本机网络不稳）。

```
dsh-sol/
  package.json          # name, version, type:module, exports(. / ./locale/*.json / ./icon), files,
                        # dsh.manifestVersion:1, dsh.bundle.patch, engines.dsh ">=0.2.1-rc.2 <0.3.0"
  cordis.patch.yml      # - insert: [{ id: sol, name: dsh-sol, disabled: true, config: {...} }]
  icon.svg              # 原创图标
  locale/en.json        # meta.title / meta.description
  locale/zh.json
  index.js              # name, inject, apply(ctx, config)：按开关装配各机制
  lib/
    config.js           # resolveConfig：补默认值、校验（照 dsh-ops 的做法，不引 schema 库）
    ledger.js           # 账本：$DSH_HOME/dsh-sol/<sessionId>/ledger.jsonl，追加写
    meter.js            # 读 tokenUsage 投影 + compaction/summary，每回合一行
    fusion.js           # edit_then_run / write_then_run；classify 也给 reducer 用
    archive.js          # objects/<sha256>.txt，O_EXCL 写入；按账本反查 id → archiveKey，不另建索引文件
    observation.js      # post-execute 替换 + obs_recall（只收 id、offset）
    reducer.js          # 失败的 shell 输出压成回执，五项校验
    occ.js occ-range.js # 计划边界 + 触发线；工具调用是否成对自己数（occ-range 是纯函数）
  index.js 的 composePostExecute：只挂一个 post-execute 监听，按“Reducer → ObservationPack”的顺序依次调用
  scripts/report.js     # 离线汇总账本，出 A/B 对比
  test/*.test.js        # node --test，用假 ctx，不加载 DSH
  docs/
```

- lib 里的逻辑写成纯函数，不 import DSH 的包，这样测试不用启动 DSH。
- **整个插件不 import 任何 `@deepseek-ai/*` 包**（2026-10-18 定，照 dsh-ops 的做法）：
  - 工具（`edit_then_run`、`write_then_run`、`obs_recall`）写成普通对象，用 `ctx.tools.register` 注册，不用 `defineTool`。
  - 代价：这条注册路径只校验输出，不校验参数，模型传来的参数原样进 `execute`。所以每个工具都要自己严格校验参数，碰到没声明的参数直接报错，不能悄悄忽略。
  - Reducer 直接读 `ctx.llm.stream` 返回的流，自己拼文本、取 usage，不用 `BlockAssembler`。
  - 宿主服务一律用 `ctx.get(...)` 或 `inject` 拿。
  - 依据：dsh-ops 是外部插件，同样不 import，见 `dsh-ops/lib/shells.js:800-810`（plain definition 的参数不会被校验）、`:944-952`、`lib/tools.js:184-191`【已核实】。外部插件能不能解析 `@deepseek-ai/*`，至今没验证过，这样做就不用验了。
- 不需要浏览器面，工具结果用通用卡片显示就够（扩展点 17）。配置页以后再说。

### 3.3 配置（默认全关）

- patch 行写 `disabled: true`。schema 里每个机制都有一个 `enabled: z.boolean().default(false)`，和 SoL-Pi 一样四个开关默认全关。
- 示例键：`meter.enabled`、`actionFusion.{enabled, shells:["ops_bash","pwsh","bash"]}`、`observationPack.{enabled, thresholdBytes:10240}`、`reducer.{enabled, provider, model, timeoutMs:20000}`、`occ.{enabled, thresholdRatio:0.5, dryRun:true}`。（2026-10-18 修订：ObservationPack 去掉 `fullSends`，OCC 去掉 `cacheWriteReadRatio`，理由见 2.2、2.4）
- `actionFusion.shells`：按顺序取第一个已注册的 shell 工具，用公开的 `ctx.tools.get(name, exec.agent)`。必须带上当前 agent：`ops_bash` 注册在 agent scope 上，不带 scope 查的是全局视图，会返回 undefined【已核实：`asar:dsh-tools/lib/index.js:3092`；`dsh-ops/lib/session-shells.js:72,87-91`；SolArch、SolDev 报】。每次调用都重新查，不缓存：会话权限一变，`ops_bash` 可能被撤下（`session-shells.js:18-25,108`）。代码里不写死任何插件的工具名，只在默认值里出现。（2026-10-18 采纳 Researcher 的建议）
- 要注意，patch 是**整行替换**，用户覆盖时必须写全整个 config（扩展点 16）。
- `lib/config.js` 只收已经实现的模块的键，写了不认识的键会直接报错，整行不加载（SolQA 查出：`asar:cordis/lib/index.js:1359-1363`）。所以每实现一个模块，都要同一轮把它的键加进 `TOP_LEVEL_KEYS`。
- 用 `engines.dsh` 写范围，不把每个 peer 钉死（扩展点 2），避开 team-studio 遇到的版本跳过问题。

### 3.4 证据和存档放在哪

- 存档：`$DSH_HOME/dsh-sol/<sessionId>/objects/<sha256>.txt`，写入用 O_EXCL；已存在时校验哈希。符号链接一律拒绝，id 先过正则校验再拼路径。这几条都照搬 SoL-Pi。
- 权限：目录 0700、文件 0600 只在 Unix 上生效。Windows 上 Node 的 mode 只管只读位，靠的是用户目录 `$DSH_HOME` 默认的 ACL【已核实，SolQA】。
- 只存模型本来会看到的那份：存档在 post-execute 里做。ds-bot 的脱敏挂在 `tools/execute` 上，post-execute 在它之后才运行，所以和 ds-bot 同装时，存进来的已经是脱敏后的内容【已核实：`asar:dsh-tools/lib/index.js:3427`（execute 包住工具体）、`:3464`（之后才 post-execute）；`bot/src/host/secrets.js:444-457`】。
- 账本：同一目录下的 `ledger.jsonl`，记录事件 turn（token）、full、placeholder、recall、fusion、reducer、reducer-fallback 等，以及原始字节数和替换后字节数。
- 不写会话目录，不调 `appendPluginRecord`（扩展点 14）。
- 不依赖 spill-local 的 tmp 目录。

### 3.5 安全边界

- **Reducer 会把日志发出去**：
  - 默认关闭。只有同时配了 `reducer.enabled:true` 和明确的 provider/model 才生效，不提供默认的远程模型。
  - 外发范围：开启后，所有顶层 shell 调用里失败、输出超过 4 KiB、又没被密钥检测拦下的结果，都会发出去，不只是测试和构建的日志（2.3）。开之前要清楚这一点。
  - 发送前做密钥检测，命中就不发。要在文档里写明这个检测是尽力而为，不是保证。
  - 每次外发都在账本里记一行：命令哈希、字节数、模型，方便审计。
- **Fusion 执行命令**：必须通过嵌套 `ctx.tools.execute` 调现有的 shell 工具（有 `ops_bash` 用它，没有用内置 pwsh），和模型直接调走同一套审批和会话级沙箱，不能绕开。不直接调 `ctx.shell`，否则只能拿到部署默认策略，也不会弹审批【已核实：`asar:dsh-pwsh-sandbox/lib/index.js:140-148`】。
- **Reducer 不读 shell 自己落盘的全文**：输出被 shell 截断时，全文是 shell 在执行过程中直接写的文件，没经过 ds-bot 的脱敏（脱敏只改 `tools/execute` 的返回值）【推断：没读 shell 写文件的代码】。所以 Reducer 只处理没被截断的结果，被截断的保持原样。
- **存档**：是本地明文，可能含有密钥（原始输出本来就在会话日志里，暴露面没有扩大）。需要一个清理策略，比如按天数清理，可配置。
- **插件不开任何 webServer 路由**，所以不涉及鉴权问题。

### 3.6 怎么证明省了 token，又没丢证据

SoL-Pi 仓库里没有 benchmark 脚本，测法要我们自己做【已核实：已读的 scripts 里只有 compat 和配置检查】。

- **省 token（A/B）**：
  - 准备一个固定任务集（建议 10–20 个），放在一个干净的 git 仓库里，每个任务从同一个 commit 开始。
  - 分 off 和 on 两组各跑 N 次。数据取会话 jsonl 里 `assistant/message` 的 usage 和第 1 步的计量账本，比较请求数、input、cached、output、按 provider 计价折算的成本，以及任务通过率。
  - 只有在“通过率不下降”的前提下，token 下降才算数。论文里平均分只有 Pi 的 93.7%，也就是说省 token 是有代价的，必须同时报告质量。
- **没丢证据（确定性测试，不依赖模型）**：
  - ObservationPack：分页 `obs_recall` 拼起来，必须和原文逐字节相等（含多字节字符）；存档 sha256 等于原文哈希；同一结果多次替换得到的占位符完全相同。照搬 SoL-Pi 已有的测试。
  - Fusion：结果里必须有校验命令的退出状态和输出；修改失败时命令调用 0 次；文件被外部改动时命令被跳过。
  - Reducer：每条 quote 都是存档的精确子串；编造的 quote 必须回退成原文；失败日志里必须有 failure 证据。可以用固定的假模型输出来测，**不调远程模型**。
  - 账本自检：每条 placeholder 都能在存档里找到对应对象。

### 3.7 和 dsh-ops、ds-bot 共存（2026-10-18 开工定稿）

不关 dsh-ops，也不改 ds-bot。两个都是日常在用的，关掉以后测出来的结果不代表真实使用。7 个冲突点都在 dsh-sol 这一侧绕开，详见 [notes/compat-dsh-ops.md](notes/compat-dsh-ops.md)，图见 diagrams.html 第 7 张。

| 冲突点 | dsh-sol 的做法 |
|---|---|
| dsh-ops 的 deny-host-shell 会拒掉 pwsh/bash，`ops_bash` 不受影响 | Fusion 按配置 `actionFusion.shells` 的顺序取第一个已注册的 shell，默认 `["ops_bash","pwsh","bash"]`。代码里不出现 dsh-ops 的名字，装不装它都能跑。都用不了时返回 `[then_run:not_run]` 加原因 |
| 模型批量改文件用 `ops_replace` | v1 不包它。dsh-ops 自己的提示也写着“精确改动用宿主 edit”，Fusion 只出 edit/write 两个版本，看计量数据再定要不要扩 |
| PTC 模式下工具都折叠进 `run_code` | 照常注册。文档写明 Fusion 只在 native 模式下有增量 |
| ds-bot 接管 Bot 会话的压缩 | OCC 只管非 Bot 会话，被拒一次就停手；不覆写 `summarize()` |
| ds-bot 会重发带密钥的请求 | Meter 不包 `llm/stream`，读原生 tokenUsage |
| ds-bot 在 execute 里脱敏 | 存档只在 post-execute 做；不读 shell 自己落盘的原始文件 |
| 名字和存储 | 只用全新的工具名，数据只写 `$DSH_HOME/dsh-sol/`。v1 不加提示段；以后要加，段名用 `sol:` 前缀，order 放在 3300 段（同名注册会抛错：`asar:dsh-system-prompt/lib/index.js:203`） |

五条防护规则，每条都要写进代码和测试：
1. 先探测再用：调用 shell 之前先查工具名在不在（`ctx.tools.get`），还要查它的返回 Fusion 读不读得懂：`output.schema` 顶层是 `type: 'object'`，或者 `oneOf`/`anyOf` 的每个分支都是对象，才算能用；返回字符串的（minimal preset 里的 persistent 版 shell）跳过，试下一个，都不能用就标 `not_run`（2026-10-19 补，`lib/fusion.js` 的 `readsObjectValue`）。依据：`ctx.tools.get()` 拿到的就是注册时的定义原对象（`asar:dsh-tools/lib/index.js:2974-2982`、`:3091-3093`）；内置 pwsh/bash 的 schema 是 `oneOf` 包着对象，没有顶层 `type`（`asar:dsh-tool-pwsh/lib/index.js:503-508`、`asar:dsh-tool-bash/lib/index.js:530-535`）。只看公开的工具名和定义，不读别的插件的私有数据（比如 ds-bot 的 Symbol）。
2. 不抢位置：不注册同名工具，不覆写 `summarize()`，不改别人的配置；数据只写自己的目录。
3. 出错就让路：dsh-sol 自己出错时，原结果原样交回，只在账本记一行，不让会话坏掉。
4. 不扩大暴露面：只存模型本来就看得到的内容，不复制别的插件或工具落盘的原始文件。
5. 每个机制单独开关，默认全关：出了冲突，关一个开关就能隔离。

验证分两次：先装进干净的 web profile（`<web-profile>`，只有 dsh-base 和 dsh-web-app，没有 dsh-ops 和 ds-bot），确认能加载、能用；再和 dsh-ops 一起测上表里的几条。安装由用户来做，团队手上没有 plugin_manager。

---

## 4. 工作量、风险、待拍板

### 4.1 工作量（推断，一人，含测试）

| 步骤 | 估计 |
|---|---|
| 骨架 + 计量 + 安装验证 | 0.5–1 天 |
| Action Fusion | 1–2 天 |
| ObservationPack（执行时版本） | 2 天 |
| A/B 测法与任务集 | 1–2 天 |
| OCC | 3–5 天，主要花在 preset 隔离和调参 |
| Reducer（可选） | 2–3 天 |

### 4.2 风险

- **rc 版本漂移**：0.2.0 到 0.2.1 之间已经去掉了 hooks、新增了 plugin record。内部事件签名随时可能变，没有 `.d.ts` 也就没有编译期保护【已核实：差异；推断：后续还会变】。
- **服务覆盖规则**：同名 Cordis service 有多个实现时谁生效，以及工具同名覆盖，都没有核实。OCC 换 compaction 实现时会碰到这个问题。
- **compaction 按 preset 隔离**：插件能不能在 agent scope 里拿到 compaction 服务，还要实测。
- **ObservationPack 的增量可能很小**：spill 已经覆盖了 50 KB 以上的输出。先用计量数据确认值不值得做。
- **省 token 不等于省钱、不降质**：缓存计价因 provider 而异，论文本身也有约 6% 的得分损失。
- **没有实际跑过**：本轮只读了代码，一个插件都没有加载过。所有“能实现”的结论都是 API 层面的推断，第一步骨架就是要把这些推断变成已核实。（2026-10-19 更新：已经在云主机上真机验证过，见第 5 节。）

### 4.3 拍板情况（2026-10-18 更新）

已定（用户让 Chief 按判断统筹）：
1. **范围**：先做骨架、计量和 Action Fusion。ObservationPack、Reducer、OCC 看计量数据再定。
2. **Fusion 的形态**：新开工具名 `edit_then_run`/`write_then_run`。同名覆盖走不通：全局 scope 注册同名工具会抛错（`asar:dsh-tools/lib/index.js:2731`）。
3. **装到哪个 profile 测**：先装 web profile，再和 dsh-ops 一起测（见 3.7）。
4. **OCC**：只做非 Bot 会话，不碰 ds-bot。
5. **ops_replace**：Fusion v1 不覆盖。

还要用户定：
1. **Reducer**：已经做了，默认关着。真机测试用的是 `zai-coding-cn` / `glm-5.3-flash`（2026-10-19，用户一小时没回编号，Chief 按推荐项定的，外发的只有云主机上的测试文本）。正式使用时开不开、用哪个模型，能不能接受把构建和测试日志发出去，还要用户定。
2. **A/B 任务集**：用哪个仓库、哪些任务？跑 A/B 会消耗真实的 token 额度。

## 5. 真机验证结果（2026-10-18～19）

只回答“在真实 DSH 里能不能用、有没有按规则工作”，不回答“省了多少”，那是 A/B 的事。

**证据**：每轮的完整记录在 [notes/live-load-1.md](notes/live-load-1.md)、[notes/live-load-2a.md](notes/live-load-2a.md)、[notes/live-load-2b.md](notes/live-load-2b.md)、[notes/live-load-2c.md](notes/live-load-2c.md)。下面的截图、会话日志、账本拷贝和证据包是团队内部资料，**没有随仓库发布**；正文里的哈希和数字都能在这些笔记里对上。

**环境**：一台 Windows Server 2025 云主机，装 DSH 0.2.1-rc.2 官方安装包，用 web profile。2a 起模型统一用 `zai-coding-cn` / `glm-5.3-flash` / high。2b、2c 加装 npm 上的 `dsh-ops@0.3.0`。每轮都有 MANIFEST、原始命令和输出，SolQA 逐轮独立复核。

### 5.1 每个模块的结论

| 模块 | 真机结论 | 证据 |
|---|---|---|
| 装载 | 能装、能卸，卸干净。中英文标题、图标显示正常；配置键拼错时只有这一行不加载，别的插件照常；全关时一个工具都不注册；工具数 31 → 34 → 31 | [notes/live-load-1.md](notes/live-load-1.md) |
| 和 dsh-ops 共存 | 没有报错，没有重名。工具数 36 → 39；卸掉 dsh-sol，dsh-ops 的 5 个工具一个不少 | [notes/live-load-2b.md](notes/live-load-2b.md) 1–3 |
| Meter | 6 个会话 13 个回合，和原生 usage 逐轮比对全部相等，包括 3 次压缩的用量。模块关着或卸载后不生成账本 | [notes/live-load-2a.md](notes/live-load-2a.md) 4；live-load-1.md |
| Fusion | 成功、失败、参数写错三种情况都对。装了 dsh-ops 时走 ops_bash，被截断时 spillPath 原样带出；被沙箱拦下的命令标 `failed`；ops_bash 起不来标 `not_run`（修 bug 以后） | live-load-2a.md 1；live-load-2b.md 4–5 和“最终规则的真机验证” |
| ObservationPack | 16500 字节换成 1414 字节的占位符；`obs_recall` 分两页取回，拼起来、存档、重新生成的原文三者 sha256 一致。走 ops_bash 也能换 | live-load-2a.md 2；live-load-2b.md 6 |
| Reducer | 20127 字节的失败日志压成 1212 字节的回执，3 条引文都是原文的逐字片段。输出被截断、带疑似密钥、不到 4 KiB、命令成功、调用超时，五种情况都按规则不压；超时时原文进存档，可以取回 | [notes/live-load-2c.md](notes/live-load-2c.md)（SolQA 独立重算通过） |
| OCC | dry run 只记录不压缩。真压 3 次，账本和会话日志一一对得上；压完以后模型仍然答对了任务，被压掉的细节确实丢了 | live-load-2a.md 3a–3c |

### 5.2 真机查出来、单元测试没抓到的问题

| 问题 | 怎么修的 | 为什么单测没抓到 |
|---|---|---|
| 不配 `meter.home` 时，ObservationPack 存档写了但没替换，机制悄悄不工作 | 先解析 home 再写账本；几处账本写入从 fire-and-forget 改成 await | 每条测试都显式传了 home，比真实配置宽松 |
| ops_bash 起不来时，Fusion 标成 `succeeded` | `classify` 改成只认 `exitCode === 0`，`value.error` 标 `not_run`（2.1） | 假结果是照 schema 注释猜的，不是照真实返回写的 |
| Reducer 的账本写入没有 await，异步出错接不住 | 7 处补 await，加两条异步 reject 的时序测试（r6，真机回归通过） | 真机上 7 行都写进去了，没出事，是读代码发现的；原来的测试用同步 throw，测不出缺 await |
| OCC 不压时三种原因都记 `no-range`，分不清 | 拆成 `retain-too-large`、`no-engine`、`no-range` | 不是 bug，是账本读不出原因 |

另有一个潜伏问题：minimal preset 里的 persistent 版 shell 返回字符串，Fusion 读不懂。现在的配置下走不到，但改了 preset 就会把成功的命令标成 `failed`。已修：探测 shell 时只认返回对象的那种（见 3.7 第 1 条）。内置 pwsh/bash 的 schema 没有顶层 `type`，只看顶层会把它们一起误判，Fusion 整体失效，有测试钉着（r6，真机回归时 ops_bash 和内置 pwsh 都选得中）。

教训：假 ctx 和假结果必须照真实返回的形状写，不能照注释或文档猜。收紧规则以后，有些防御分支会变得测不到，要专门补一条用例。

### 5.3 对以后使用和 A/B 有影响的发现

- **1M 窗口下 OCC 很难触发**：触发线是 `min(thresholdRatio × W, 0.85 × 原生线)`，1M 窗口下要几十万 token，短会话碰不到。真机测试是把窗口声明成 200000 才测到的（live-load-2a.md 环境一节）。
- **“能压多少”不能用“真实占用减留尾”来估**：占用用的是上一次请求的真实 usage，留尾和压缩范围用的是按节点的启发式估算。十六进制这类内容，真实 token 大约是估算的 2 倍（推断），所以第一次真压只压掉了 827 token。原生压缩选范围也用同一套估算，不是 dsh-sol 自己的偏差。
- **压缩摘要的进度会落后一拍**：原生摘要只看到被压掉的那一段，看不到留尾里的最新进度（推断）。这次没导致答错，但压完以后模型有可能被它误导。这是 DSH 原生的行为。
- **装了 dsh-ops 以后，Reducer 只处理 4 KiB 到 64000 字节之间的失败日志**：ops_bash 超过 64000 字节就截断（`dsh-ops/lib/shells.js:79`），Reducer 看到截断就不压（2c 场景 2 证实）。更大的日志只走 ObservationPack。
- **Reducer 的延迟**：压缩成功的那次工具调用 4.8 秒，不压的 1.2–1.4 秒，推断调模型大约占 3.4 秒。
- **账本里 `requests > 0` 而 `usageTotal` 全 0 的会话要剔除**：这类会话的消息是 relay 拼接的（判据：`assistant/attempt` 为 0、`toolu_relay_` 前缀的 tool-call 上千条），本来就不带 usage，`bucketsFromUsage(undefined)` 返回全 0 是定义行为，不是漏记，也不代表某个 provider 不上报用量。分析账本或做 A/B 时先过滤掉它们，否则会把分母拉大、把节省率压低。详见 [load-check.md 第 8 节](notes/load-check.md)。
- **超过 64 KB 的输出是 dsh-ops 截断 + ObservationPack 替换，串联两道，不是各管一段**：dsh-ops 先把正文（stdout、stderr 各算）截到 64000 字节，末尾追加 `[output truncated; full output: <spillPath>]`（`dsh-ops/lib/shells.js:79`、`:1077-1078`）；这段文本仍远大于 ObservationPack 的 10240 字节阈值，所以接着被换成占位符。实测 77055 字节的输出，占位符写的是 `original_bytes: 64136`（64000 + 136 字节标记），正是「先截后归档」。**标记行通常落在尾预览里，但不保证**：截断标记**不是**最后一个完整行——命令同时失败时，它后面还跟着 `[exit code: N]`（实测 `original_bytes: 64151` = 64000 + 136 + 15）；这两行都很短、合起来约 150 字节，一般会一起落进占位符尾部 512 字节的预览，标记落到预算之外时才需要 `obs_recall` 那一跳。标记文本见 `dsh-ops/lib/shells.js:846`，那里的标签位在拿不到路径时写的是 `(unavailable)` 而不是路径。恢复链路本身是通的：占位符 → `obs_recall` 读回那段含 `spillPath` 的文本 → `read` 该文件；`read` 在 `NEVER_REPLACE` 里，所以这条链不会自噬（`lib/observation.js:58-63`）。
- **哪些结果不会被换成占位符**：`read`、`obs_recall`、`edit_then_run`、`write_then_run` 四个工具；`isError` 为真的结果、嵌套调用（Fusion 的内层命令）、带 Reducer 回执的结果、小于阈值的文本（`lib/observation.js:58-63`、`:349-357`）。注意 DSH 只对**工具级**错误打 `isError`；**命令非零退出不算**，这类结果仍会进占位符——好在**退出码通常落在尾预览里、能直接看到**，全文可以用 `obs_recall` 取回。

### 5.4 还没做的

- 除 web 默认 preset 以外的 preset。
- A/B：到底省了多少 token，质量有没有下降。
- **v0.2：让 `spillPath` 在占位符里确定可见**。现在它**通常**落在尾部 512 字节的预览里（截断标记和可能的 `[exit code: N]` 两行都很短、约 150 字节），但这取决于路径长度和剩余空间，不是保证；下一版在占位符里显式写出该路径，不再依赖预览是否覆盖到。本次不改代码。
- **v0.2：归档回收与去重**。`objects/` 只增不减（没有 unlink、prune 或保留期）；而且超过 64 KB 的输出会**存两份**——dsh-ops 的 spill 文件加 ObservationPack 的归档，内容寻址只对完全相同的内容去重。长会话的磁盘因此是双份增长。下一版加保留策略。

### 5.5 ObservationPack 的 A/B：在这组任务上无效（净增成本 ≈80%）

ObservationPack 会把超过 10240 字节的工具结果换成占位符，模型需要时用 `obs_recall` 读回。**省不省取决于模型是否真的用不到那段内容**，这只能对照着量。

**怎么做的**

- 落点 `dsh --profile headless`（一次性会话、不开端口），云主机 Windows Server 2025、2 核 2 GB；模型钉死 `zai-coding-cn` / `glm-5.3-flash`、`reasoningEffort: high`、窗口 1M、`DSH_TOOLS_MODE=native`。
- 两臂**只差 `observationPack.enabled`**：Meter 两臂都开，Fusion / Reducer / OCC 两臂都关。采集与切换分离——Control 臂跑完 6 个，只切一次配置，验活后再跑 Treatment 臂 6 个。
- 12 个 run 全部由**同一个** `schtasks` 任务在桌面会话里串行拉起，启动方式固定成一个参数并逐 run 记进 MANIFEST（启动方式会改变工具行为，不能让它变成一个没受控的变量）。
- 预注册先锁定、跑完不改：任务集、两臂定义、度量口径、有效性门、样本量与判定门槛。预注册文件哈希换过几次，以最后一个为准：

| 版本 | sha256 | 状态 |
|---|---|---|
| 初版（任务只写类别） | `5d466efb…` | 作废 |
| §3 改成六个具体命令 | `b0f16546…` | 作废 |
| §5 加「`requests ≥ 1` 且用量非零」 | `0781ce16…` | 作废 |
| §5 加「必须出现 shell 工具调用」 | **`f690e0c5…`** | **有效** |

**任务集**由确定性夹具生成（600 个文件 / 8000 行日志 / 40 个用例其中 14 个失败 / 120 个提交），裸输出都在 10–64 KB，用裸命令 `wc -c` 标定、不跑会话：

| 任务 | 命令 | 裸输出 | 答案 |
|---|---|---|---|
| t1 | `grep -rn NEEDLE tree/` | 25,256 | 400 行 / 24 个目录 |
| t2 | `node --test suite/fail.test.mjs` | 32,099（机上裸输出 31,737；原样 31,752 = 31,737 + 15 字节包装） | 失败 14 / 通过 26 |
| t3 | `node checker.mjs .` | 36,901 | 288 条告警 |
| t4 | `git --no-pager -C gitrepo log --stat` | 34,211 | 120 个提交 / 最早 `change 1` |
| t5 | `find tree -type f` | 15,600 | 600 个文件 / 24 个目录 |
| t6 | `grep -n ERROR logs/app.log` | 22,877 | 200 行 / `E1003` 47 次 |

**结果**（`usageTotal`，两臂各 1 次）：

| 任务 | Control | Treatment | Δ | recall 次数 | 回读字节 / 原文 | `omittedBytes` |
|---|---|---|---|---|---|---|
| t1 | 23,509 | 44,323 | **+88.5%** | 2 | 25,256 / 25,256（100%） | 23,829 |
| t2 | 23,368 | 45,257 | **+93.7%** | 2 | 31,744 / 31,752（99.97%） | 30,323 |
| t3 | 22,225 | **12,326** | **−44.5%** | 0 | 0 | 35,556 |
| t4 | 26,317 | **19,626** | **−25.4%** | 0 | 0 | 32,809 |
| t5 | 20,224 | 40,006 | **+97.8%** | 2 | 15,600 / 15,600（100%） | 14,188 |
| t6 | 37,941 | 87,998 | **+131.9%** | 2 | 22,877 / 22,877（100%） | 21,541 |

中位数：**23,438.5 → 42,164.5（+79.9%）**；`outputTokens` +24.8%；`requests` 中位数 2 → 4。

**敏感性（离群点）**：`t6` 的 treatment 那次是 316 秒 / 5 次请求 / `outputTokens` 15,428（其余 run 的 output 都不到 3k）。去掉它重算——全 6 对中位数 **+79.9%** → 去掉 t6 整对 **+71.2%** → 只去掉 t6-treatment **+70.7%**；逐对差值中位数 6 对 **+91.1%**、去掉 t6 **+88.5%**。**方向和量级都不变**，它只贡献约 9 个百分点。

`outputTokens` 那一条更值得说明：去掉 t6 整对后中位数从 **+24.8% 变成 +39.2%**——**这个离群点在掩盖 output 的上升，不是在支撑它**。所以 ④ 的结论也不依赖它，去掉之后反而更不利。再做**留一法**（逐对去掉重算）：去掉任意一对，`usageTotal` 中位数都在 **+71% ~ +90%** 之间——**结论不依赖任何单个 run**。判据不因它改变：§5 没有、也不该有「剔除离群点」这条。

**§7 五条判定**（机械执行，不因局部为正改判）：

| 条 | 结果 |
|---|---|
| ① 质量不降 | **成立**——盲判 12/12 全「答对」，两臂零差异 |
| ② 机制真触发 | **成立**——六对 `ΣomittedBytes` 14,188–35,556 |
| ③ `usageTotal` 中位数降 ≥10% | **不成立**——反向 **+79.9%** |
| ④ `outputTokens` 涨 ≤10% | **不成立**——+24.8% |
| ⑤ 额外回合不抵消收益 | **不成立**——requests 2→4 且更贵 |

> **结论：在当前的占位符设计下，ObservationPack 在这个任务集上无效，净增成本约 80%，且没有换来任何质量提升。**

**为什么亏**（事后分组，只作解释、不作判据）

单因子：**答案能不能从占位符自带的 512 字节尾预览里算出来**。能（t3、t4）⇒ 模型不回读 ⇒ 省 25%–45%；不能（t1、t2、t5、t6）⇒ 只能把全文读回来 ⇒ 亏 88%–132%。「不能」还分三种情形：t1、t5 的输出里**根本没印总数**（要数 400 行 / 600 个文件）；t2 **印了，但 `fail 14` 距末尾 9,030 字节**，落在 512 之外；t6 见下一段。六对零例外，回读比例 0% 与 ≈100% 正好对应。

这条判据本身是**当前设计（占位符只暴露尾部 512 字节）的直接推论 + 事后拟合**，不是新规律：答案不在预览里就必然回读，方向几乎是定义性的，只有**幅度**是实测的。下一轮要预注册两件事再验：① 把「答案距末尾多少字节」写成跑前就能算的规则；② 加一个「答案在预览里、模型仍然选择 recall」的任务——只有这样才能把「距离」和「模型行为」拆开。

成本可以写成三项：**省下的内容量 − 额外请求的成本 × 请求数增量 − 回读内容的量**。t3 是最干净的对照（零回读、请求数不变），省的 9,899 token 与被归档内容的 36,901 字节（≈9.2k token）几乎相等——**没有回读时，省下的量与那份内容相当（差约 7%，按 4 B/token 估，不是精确等式），账基本是平的**；回读 ≈100% 时后两项把它原样吃回去并倒挂。t4 是「多一次往返」的对照：零回读、省 **6,691 token**，而被归档内容约 **8.5k token**——差额 **≈1.9k**，量级上相当于一次额外请求（同样是量级对照，不是精确归因）。

**亏的不是占位符本身，是回读之后的重新发送**：在 `uncachedInputTokens` 上，t3 第一步就从 **4,399 降到 372**（零回读，占位符当场省下 4,027），而 t1 多花的 **6,988** 全部落在回读之后的第 2–4 步。**这两个口径不能混用**：t3 的 `usageTotal` 只降 44.5%，而它的 `uncachedInputTokens` 降了约 93%——差额来自 `cacheRead`，两者不是同一个指标。

**这条判据可以离线预判**：给定夹具和命令，量一下「答案串距末尾多远、要不要数全文」，不用跑会话就能说出这一对是省还是亏。t6 是判别性样本——它的答案串 `E1003` 距末尾 **510 字节**（量到串首；量到串尾是 505 B，预览 512 B，余 2 字节），但题目要的是「出现 47 次」，**串在预览里、数不在**，所以照旧回读、照旧最贵；即便哪天这个串掉出预览，它仍然是「要数 47 次 → 回读 → 贵」，结论不变。**距离本身不要当精确值**：不同机器与 Node 版本量到的数差几十到几百字节（t2 9,012 / 9,030 / 9,363；t3 1 / 12；t6 **510 量到串首 / 505 量到串尾**），**距离一律量到答案串开头**——那才是「能不能塞进 512」的保守边界；主值一律用归档，分类不变。

**适用范围**（三条都不能省）

1. 这是**刻意造出来的任务集**，六个里四个要求「读全文或数一遍」，因此这句话**不能推广成「机制没用」**。
2. 桌面版继续保持开启**是一个判断，不是已证实的净省**——早先那三条真机证据（工具表只多 `obs_recall`、13,806 字节结果被归档、分页回读成功）证明的是**机制触发了**，没有对照臂，不构成省钱的证据。
3. **v0.2 的方向**：只加**文本自身的元信息**（总行数、总字节数），不加 `hits=288`、`fail=14` 这类任务相关摘要——插件不知道用户在找什么，按测试集去猜统计量是过拟合。「加 `lines=` 能让 t1/t5 免回读」目前是**推断**（这两题的答案恰好就是行数与文件数），需下一轮预注册后验证。

**方法学留痕**（这几条都是本轮踩出来的）

- **门必须自报分母**：扫描要报「扫了多少文件 + 命中数」，账本结论要报 `requests` 与 usage。今天出现过「扫 0 个文件报 `TOTAL 0`」「没有 provider 适配器时账本照样建行但 `requests: 0`」两种假绿。
- **有效性门要三条**：`turn` 行 + `requests ≥ 1` + `usageTotal > 0`（仅「账本有行」不够）；Treatment 臂另需 `ΣomittedBytes > 0`；每 run 还要有一条 shell 工具调用——模型改用原生工具时结果会被封顶（实测原生 `grep` 封顶 250 条），两臂会一起答错。
- **提示词保真**：三条互不相干的路径各算一遍——从锁定的任务文件抽、从会话日志的首条 user 文本抽、独立复算——12 个 run 全等。口径是「**同一个任务、内容等价**」，不是「逐字节相同」：BOM 和一个换行确实经 stdin 进了会话，两臂同样受影响，所以对比不受影响。
- **盲判**：两臂答案去标记、随机编号后交判，映射单独保管。本轮判分期间映射曾被误贴进群，判者声明未使用；因为结果是 12/12 全对、臂间无差异，偏倚的空间为零，但这条按「已发生、已记录」留痕。
- **T2 不做字节校验**：`node --test` 的输出带每用例耗时，同机自身就在抖（32,042–32,121），跨机器差约 350 字节；它只按答案键与配对比较。
- **字节数一律从归档推，不从本机重跑取**：**包装固定 15 字节**（归档末尾实证：`\n[exit code: 1]`，`originalBytes 31,752 = 裸输出 31,737 + 15`）。本机那次算出 +22，是因为拿的是**另一次运行**的 stdout（31,730，与归档里的 31,737 差 7 字节）——即 **22 = 15 字节包装 + 7 字节重跑抖动**，包装本身仍是 15；裸输出本身有 ±50 抖动，所以 offset 只作参考、不作判据。`fail 14` 距末尾：**归档 9,030 字节**（本机复跑那版 32,127 字节时量到 9,363），报告一律用归档值。其余五对全部 exit 0、无 stderr，包装增量为 0。
- **夹具文档的四处已知不精确**（不影响本轮结果，下一轮修，冻结产物本轮不改）：① `index.md` 把 t2 的失败构成写成「8 抛错 + 6 assert」，实际是 **10 抛错（`i%4===0`，`fixture.mjs:99`）+ 4 assert（`i%7===0` 且非 4 倍数，`:107`）**；② `fixture.mjs:75` 的注释「40 用例，10 失败」也错，实跑 14；③ `suiteFailures`（`:170`）只数抛错分支（10）；④ `t2.md` 答案键下面那句成因说明同样写成「8 个显式抛错 + 6 个 assert」，而且同一句里与「10 个显式组」自相矛盾——**答案键本身（14 / 26 / 失败编号）是对的**，判档不受影响。判分以 `index.md` 的 **14** 为准，`fixture.mjs` 的该字段不可用。
- **作废批次的账**：本轮共作废 **6 个批次**（环境不对 ×3：`valid1`/`main1`/`run2`；`run3` 的 `tool_mix` 含逗号导致 CSV 列错位；`run4` 的 `command_ran` 匹配太死造成假 `void`；`run5` 的提示词被 GBK 读成乱码），全部不进统计。逐批记录在云主机的 `<lab>\runs\` 与本机复现层的那份复现说明里（两者都不进公开仓库）。这些返工来自环境与工具链，不是机制本身；记下来，下一轮不重复踩。

