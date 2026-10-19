# dsh-sol：SoL 省 token 工具

dsh-sol 是 DeepSeek Harness（DSH）的一个插件，目标是让模型干同样的活少花 token，同时不丢证据。思路来自 NVlabs 的 [SoL-Pi](https://github.com/NVlabs/SoL-Pi)（MIT 许可），按 DSH 0.2.1-rc.2 的扩展点重新写了一遍。代码基本是重写的，只有 `lib/reducer.js` 里的两个正则（`FAILURE_SIGNAL`，以及 `LIKELY_SECRET` 的起点，后来扩充过）取自 SoL-Pi，源码里有注释标明，SoL-Pi 的许可声明附在 [LICENSE](LICENSE) 末尾。本项目以 MIT 许可发布。

它做五件事：记账、改完文件顺手跑校验、大段输出换成可回读的句柄、长失败日志压成带原文引用的回执、在计划步骤做完时提前压缩上下文。**装上以后什么都不会变**：整个插件默认关闭，每个模块也各有开关、默认关闭，要用哪个就单独打开哪个。

架构图和流程图见 [docs/diagrams.html](docs/diagrams.html)，设计细节见 [docs/report.md](docs/report.md)。

## 五个模块

| 模块 | 做什么 | 配置键（默认值） |
|---|---|---|
| Meter 计量 | 每回合往账本记一行 token 用量，原生计量漏掉的压缩成本也补上。只观察，不改任何东西 | `meter.enabled`（false）、`meter.home`（不填就是 `$DSH_HOME`；**所有模块**的账本和存档都写在它下面，Meter 关着也一样） |
| Action Fusion 改完就测 | 多了两个工具 `edit_then_run`、`write_then_run`：改完文件，在同一次调用里接着跑一条校验命令，省掉一轮模型请求 | `actionFusion.enabled`（false）、`actionFusion.shells`（`["ops_bash","pwsh","bash"]`） |
| ObservationPack 大输出换句柄 | 超过阈值的工具输出存进本地存档，模型看到的是一个固定的占位符（头尾预览加编号），要看全文就用 `obs_recall` 按页读 | `observationPack.enabled`（false）、`observationPack.thresholdBytes`（10240） |
| Reducer 失败日志压缩 | 失败且很长的命令输出，发给你**指定的模型**压成回执，回执里每句引文都要和原文逐字一致，校验不过就保留原输出 | `reducer.enabled`（false）、`reducer.provider`、`reducer.model`（**都没有默认值，必须自己填**）、`reducer.timeoutMs`（20000） |
| OCC 提前压缩 | 计划里某一步刚做完、上下文又占得比较满时，主动压缩旧历史。默认只记账，不真压 | `occ.enabled`（false）、`occ.thresholdRatio`（0.5）、`occ.dryRun`（true） |

几点说明：
- `actionFusion.shells` 是跑命令时挑 shell 的顺序，取第一个装好的。没装 dsh-ops 时，自动跳过 `ops_bash`。Reducer 也用这份列表判断“这是不是一条 shell 命令的结果”，不另外配。
- 写错键名会报“unknown key”，整行都不加载。
- 数据都放在 `$DSH_HOME/dsh-sol/<会话 id>/` 下：账本 `ledger.jsonl`，存档 `objects/<sha256>.txt`（ObservationPack 和 Reducer 共用，同样的内容只存一份）。不写会话目录，不碰别的插件的目录。

## 安装（建议先装进 web profile 试）

建议先装进一个单独的 profile（比如 web profile）试，确认没问题再装进日常用的 profile，免得试验数据和日常会话混在一起。

1. **给试用的 profile 配上模型。** 新建的 web profile 是空的。把你日常 profile 的 `cordis.patch.yml` 里 `agent-default-model` 和 `llm-pi-ai` 两段拷到它的 patch 里，不拷的话选不到模型。
2. **装 dsh-ops（可选，但建议装）。** 装了它，Fusion 才会走 `ops_bash`。
3. **装 dsh-sol。** 在 DSH 的插件管理里，从本地目录安装 `<你克隆的目录>`（例如 `git clone https://github.com/leinasi2014/dsh-sol` 得到的目录）。DSH 官方的安装方式是 `plugin_manager install_bundle`，本地目录会以链接的方式装进去，改了代码重启就能生效。不要手写 profile 的 `package.json`，也不要在 profile 目录里跑 pnpm。
4. **检查有没有缺包。** web profile 的 `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`，装 dsh-ops 时它依赖的包不会自动带进来。装完看一眼安装结果里的 warnings，或者 profile 的 `node_modules` 里有没有缺包。dsh-sol 本身零依赖，不受影响。
5. **看插件列表。** 应该出现一行“SoL 省 token 工具”（英文界面是“SoL Token Saver”），带插件自己的图标（深色圆角方块里一个金色圆盘），状态是关闭。
6. **打开插件，写配置。** 先把整行打开，再写 config。注意 patch 是**整行替换**的：你写的 config 会完全替换默认的那份，要用的模块都得写全。建议一次只开一两个，看账本确认没问题再开下一个。五段写全是这样：

   ```yaml
   meter:
     enabled: true          # 先开这个，其他模块的效果要靠它对比
   actionFusion:
     enabled: true
     shells: [ops_bash, pwsh, bash]
   observationPack:
     enabled: false
     thresholdBytes: 10240  # 超过 10 KiB 的输出才换成占位符
   reducer:
     enabled: false
     # provider: <provider id>   # 打开前必须自己填：DSH 里已经配好的 provider id
     # model: <model id>         # 打开前必须自己填：这个 provider 下的模型 id
     timeoutMs: 20000             # 超时就保留原输出
   occ:
     enabled: false
     thresholdRatio: 0.5
     dryRun: true           # true 只记账不真压；改成 false 才会真的压缩
   ```

   Reducer 开着、却没填 provider 或 model 时，它一个请求都不发，只当没开。provider 和 model 就填你在 DSH 里选模型时看到的那组 id，建议挑一个便宜的。不要写成空字符串 `""`，空字符串会被当成配置错误，整行都不加载；不打算用就把这两行注释掉。`occ.thresholdRatio` 只能写 0 到 1 之间的数，可以等于 1，不能等于 0。

## 冒烟检查：开了以后怎么确认它在干活

**Meter**
- 随便跑一个回合，然后看 `$DSH_HOME/dsh-sol/<会话 id>/ledger.jsonl` 有没有新行，`kind` 是 `turn`，带四个 token 桶和 `requests`。
- 出汇总：在插件目录里跑 `node scripts/report.js`，可以加 `--home <目录>`、`--group 名字=会话id前缀`、`--json`。
- 账本里标 `baseline: "unknown"` 的会话（比如插件装上之前就开着的会话），汇总时会单独列出来，不混进对比。这是正常的。

**Action Fusion**
- 新开一个会话，工具列表里应该出现 `edit_then_run` 和 `write_then_run`。没出现的话，先看 `actionFusion.enabled` 是不是 true，再看当前是不是 PTC 模式（见下面的限制）。
- 让模型改一个文件，并要求它“改完跑一下测试”。结果末尾应该有一行标记：
  - `[then_run:succeeded]`：命令跑了，成功了。
  - `[then_run:failed]`：命令跑了，失败了（包括超时，以及超时以后转到后台继续跑的情况，这时会带上后台任务的 id）。
  - `[then_run:not_run]`：命令没跑成，后面附原因，比如被拒绝、被策略拦下、找不到能用的 shell。
  - `[then_run:skipped]`：文件改好了，但改完又被别处改了，所以没跑命令。
- 改文件本身失败时，整个调用直接报错，不会出现标记，也不会跑命令。
- Fusion 跑命令走的是正常的工具调用，审批和沙箱规则和模型自己调 shell 时完全一样。

Fusion 不写账本，看工具结果里的标记就行。

**ObservationPack**
- 让模型跑一个输出超过 10 KiB 的命令（比如列一个大目录）。模型看到的结果开头是 `[large tool result replaced; the original is archived and readable]`，后面是编号、大小、头尾预览。
- 账本里多一行 `kind: "observation"`，带 `id`、原始字节数、占位符字节数和 `archiveKey`。`$DSH_HOME/dsh-sol/<会话 id>/objects/` 下多一个 `<archiveKey>.txt`。
- 让模型用 `obs_recall` 读这个编号，每读一页账本记一行 `kind: "observation-recall"`。一直读到 `eof`，拼起来应该和原文逐字节一致。
- 不会被替换的：报错的结果、`read` 的结果、带图片的结果、Fusion 的结果、Reducer 的回执、`obs_recall` 自己的结果。

**Reducer**（要先填好 provider 和 model）
- 让一条命令失败，而且输出超过 4 KiB（比如故意跑挂一组测试）。
- 压成功了：模型看到的是一份带 `dsh-sol_evidence_receipt_v1` 标记的回执。账本记一行 `kind: "reducer"`，带用的模型、原文和回执各多少字节、`usage`、`archiveKey`。原文存在 `objects/` 里。
- 没压：模型看到原输出，账本记一行 `kind: "reducer-fallback"`，`reason` 写明原因：
  - 没发请求：
    - `likely-secret`：疑似有密钥；
    - `the output was truncated`：输出被 shell 截断了，不压残片；
    - `source-over-max-chars`：原文太长；
    - `llm-unavailable`：拿不到模型服务。
  - 发了请求，但模型没给出可用的结果：
    - `model-call-timeout`：超时；
    - `unexpected tool call`、`no finish chunk`、`empty reply`、`model-call-failed`；
    - 处理过程中抛了异常（包括模型服务报错、存档写失败），记成 `error: <原因>`。
  - 回执没通过校验，整份作废：`invalid-json`、`schema-mismatch`、`unverifiable-quote`、`missing-failure-evidence`、`receipt-not-smaller`。
- 只有真的发了请求才会有 `usage`，失败的请求也会记。这些行就是外发记录，可以拿来审计。
- 成功的命令、输出不到 4 KiB 的命令、转到后台还在跑的命令，都不处理，也不记账。

**OCC**（默认干跑）
- 要在**普通会话**里试，Bot 会话不起作用。让模型用 todo 列一个计划，做完其中一步并把它标成 completed。
- 账本里出现 `kind: "occ-dry"` 的行。只有“刚过了计划边界”或者“上下文占用过了触发线”时才记，不是每步都记。
- 看 `decision` 字段：`would-compact` 表示真压的话这里会压；其他值说明为什么没压，比如 `no-boundary`、`below-threshold`、`no-window`、`retain-too-large`（留尾比触发线还大，压了也不省）、`no-engine`（拿不到压缩服务）、`no-range`（选不出一个不断开工具调用的范围）。
- 同一行还有 `occupancy`：当前用了多少 token、窗口多大、原生压缩的触发线、OCC 的触发线。上下文不够满时，一般只会看到 `below-threshold`，这是正常的。
- `dryRun: false` 时真压。压成功了，记一行 `kind: "occ"`，带压掉的范围和 `shadowedTokenCount`。原生压缩正在进行（busy），或者在 Bot 会话里被拒绝，都不记账，只打一条 warn；被拒一次以后，这个会话不再试。

## Reducer 会把日志发出去，开之前要想清楚

- 只有同时写了 `reducer.enabled: true`、`reducer.provider` 和 `reducer.model` 才会发请求。插件不会替你挑模型，也不会借用当前会话的模型。
- 一旦打开，**所有失败、输出超过 4 KiB 的顶层命令输出**都会发给你配的模型，不只是测试和构建的日志。
- 发之前会做一次疑似密钥检测，命中就不发。这个检测只是尽力而为，不保证能拦住所有东西。和 DS Bot 一起装时，DS Bot 登记过的密钥会在发出前被抹掉，但内网地址、路径、别的 token 照样会发出去。

## 已知限制

- **OCC 只管非 Bot 会话。** DS Bot 接管了 Bot 会话的压缩，外部插件来压会被拒绝。OCC 被拒一次就记住这个会话，以后不再试。如果你平时用的都是 DS Bot 的 Bot 会话，OCC 在那里不起作用。
- **OCC 默认干跑**（`dryRun: true`），只记“本来会压”，不真压。等干跑数据把触发线校准好，再考虑关掉干跑。
- **Fusion 只在 native 模式下有用。** PTC 模式下，模型只能直接调 `run_code`，`edit_then_run` 得从 `run_code` 的程序里调。PTC 本来就能连着调用，Fusion 在那里省不下什么。
- **Fusion 的结果没有 diff 卡片。** 插件不引用任何 DSH 内部包，工具是按普通对象注册的，界面上显示的是通用卡片。edit 原本的输出文本会一字不改地放在结果最前面。
- **Meter 认 fork 会话靠一个实现细节。** 判断“这是刚 fork 出来的会话”用的是 `session.firstLifecycleSeq`。它是公开字段，但不在 DSH 文档的契约里，换 DSH 版本时要复查。
- **只支持 DSH 0.2.1-rc.2 到 0.3.0 之前的版本**（`engines.dsh`）。
- **存档是本地明文**，存的是模型本来就会看到的那份内容。v1 不会自动清理，需要的话手动删 `$DSH_HOME/dsh-sol/`。

## 开发

- 纯 JS（ESM），零依赖，不用 npm install。
- 跑测试：在插件目录里执行 `node --test`。测试用假 ctx，不需要启动 DSH。
- 设计依据和源码核实笔记都在 `docs/` 和 `docs/notes/` 里。
