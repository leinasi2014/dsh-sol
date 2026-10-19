# 装载前检查（dsh-sol 从未在真实 DSH 里加载过）

日期：2026-10-18，14:59 前后的文件快照。只读检查，没装、没跑 DSH。
- `asar:` 指 `app.asar` 里 `dsh/node_modules/@deepseek-ai/<包>/lib/index.js`。
- `official/` 指 `<DSH official plugin docs>\`。
- 结论分**已核实**（读过原文）和**推断**。

## 0. 结论

能过的：清单、patch、导出形状、工具定义的注册校验、三个监听的签名，都和 DSH 源码对得上。没发现会让插件加载失败的问题。【已核实】

要改的有 3 处，都不大：
1. **【中】Reducer 用了 `ctx.llm`，但 `inject` 里没写 `llm`。** 接入口时要么把 `llm` 加进 `inject`，要么用 `ctx.inject(['llm'], …)` 把 reducer 包起来（dsh-ops 就是这么做的）。不改的话，cordis 会沿着父 fiber 往上找，多半也能找到，但 profile 里没有 llm 服务时会直接抛错，不会安静地不激活。见第 1 节。
2. **【低】嵌套调用没有 signal 时会抛 TypeError。** `nestedExecution` 只在外层有 signal 时才传；registry 在 `callerCancelled` 里直接读 `callerSignal.aborted`。agent loop 的调用总是带 signal，所以实际碰不到；但 PTC 子调用或者别的插件调我们的工具时可能缺。见第 4 节。
3. **【低】locale 的描述还停在“计量和 Fusion”**，最后一步统一改。

## 1. index.js 的导出形状

| 项 | dsh-sol | 依据 | 结论 |
|---|---|---|---|
| 导出形式 | `export function apply(ctx, rawConfig)`，加 `export const name` 和 `export const inject`；没有 default 导出，没有 `Config` | `official/cordis-plugin-development/references/host-plugin.md:59-62`：apply 和 Service 类两种形式只能选一种，`inject`、`Config` 可选 | 合规【已核实：`index.js:24-58`】 |
| 资源注册 | 全部包在一个 `ctx.effect(() => …, 'dsh-sol: mechanisms')` 里，cleanup 倒序调用、每个都 try | `host-plugin.md:64` | 合规【已核实：`index.js:40-57`】 |
| 全关时 | 直接 return，一个资源都不注册 | report.md 3.7 规则 5 | 合规【已核实：`index.js:39`】 |
| inject | `['sessionProjections', 'tools']` | `official/.../practices.md:20`：可选服务写进 inject，没有时插件不激活，不会抛错。cordis 把数组转成 map（`asar:cordis:1491-1497`） | 对已接入的 Meter 和 Fusion 够用【已核实】 |
| 未 inject 的服务 | `lib/reducer.js:557` 读 `ctx.llm` | cordis 的 get trap：store 里没有，就沿父 fiber 往上找；某一层在 `inject` 里声明了却没实现，抛 `cannot get required service`；找到顶还没有，抛 `cannot get property "llm" without inject`（`asar:cordis:673-697`） | **要改**，见第 0 节第 1 条。【已核实：查找规则；推断：llm 在根上一定能找到】 |
| config 校验 | 没导出 `Config`，用 `lib/config.js` 手写校验。不合法时在 apply 里抛错，这个 fiber 失败（`asar:cordis:1359-1363`） | report.md 3.1 已写明代价：激活前 DSH 不校验，设置页也看不到字段 | 已知取舍【已核实】 |

OCC 接进来时还会用到 `compaction`、`agentPresets`、`tokenMeter`、`llm.resolveModelInfo`。compaction 按 preset 隔离（`<desktop-profile>/cordis.yml:843-845` 等），根上拿不到，所以不能写进 `inject`。只能照 step5-facts 2.2 节的做法，用 `ctx.get(...)` 拿，拿不到就跳过。【已核实：隔离配置】

## 2. cordis.patch.yml 那一行

```yaml
- insert:
    - id: sol
      name: dsh-sol
      disabled: true
      config: { meter: { enabled: false }, actionFusion: { enabled: false } }
```

| 项 | 依据 | 结论 |
|---|---|---|
| `insert` 在顶层，往根列表里追加一行 | `official/cordis-composition-reference/SKILL.md:14`；官方模板 `templates/decoration/cordis.patch.yml:1-3` 是同样的形状 | 合规【已核实】 |
| `name: dsh-sol` 是包名，按包解析 | `SKILL.md:18`：`name` 是插件的包标识；dsh-ops 也是用包名加子路径，比如 `name: dsh-ops/shell`（`dsh-ops/cordis.patch.yml:5`） | 合规【已核实】 |
| `id: sol`，在 desktop 和 web 的 cordis.yml 里都没有同名行 | grep 0 命中 | 不撞【已核实】 |
| `disabled: true` | `SKILL.md:21`：disabled 可以是布尔值；行被禁用时不读必填的 config | 装上以后什么都不发生【已核实】 |
| 覆盖时整份 config 替换，不做合并 | `SKILL.md:15` | README 已写明【已核实】 |

## 3. package.json 的清单字段

| 字段 | 值 | 依据 | 结论 |
|---|---|---|---|
| `name`、`version`、`type: "module"`、`private` | `dsh-sol`、`0.1.0`、module、true | `host-plugin.md:9-17` | 合规 |
| `exports` | `.`、`./locale/*.json`、`./icon` | `host-plugin.md:35` | 合规 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | `host-plugin.md:3`、`:16` | 合规 |
| `dsh.manifestVersion` | 1 | `asar:dsh-package-manifest/README.md`（可选字段） | 合规 |
| `files` | index.js、lib、scripts、patch、locale、icon、docs | `host-plugin.md:35`：从本地目录安装是链接方式，`files` 不起过滤作用；只在打包时生效 | 合规，`README.md` 由 npm 自动带上 |
| `engines.dsh` | `>=0.2.1-rc.2 <0.3.0` | `asar:dsh-app-boot:279-285`：声明了 `engines.dsh` 就只看它；含预发布版本（`:276-278`）；运行时版本取自 app-boot 的 package.json，是 `0.2.1-rc.2` | 当前版本满足【已核实】 |
| `engines.node` | `^22.19 \|\| >=24` | app-boot 不检查它（grep 0 命中） | 不影响加载【已核实】 |
| 依赖 | 无 | `host-plugin.md:7` | 合规 |

## 4. 普通对象工具定义 vs `ctx.tools.register` 的校验

`register` 只查这些（`asar:dsh-tools:2974-2985`）【已核实】：
1. 必须有 `output` 对象，`output.render` 是函数；`presentationMeta` 写了就得是函数。否则抛 `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }`。
2. `output.schema` 只能用支持的子集（`assertSupportedJsonSchema`，`:323-327`）：`type/oneOf/properties/required/additionalProperties/items/enum/const`，外加注解。别的关键字抛 `JsonSchemaError`（`:206`）。
3. `timeoutMs` 写了就得是正数。
4. 名字不能叫 `run_code`。
5. 同一层重名抛错（`:2731`）。

**register 不查 `parameters`。** 模型看到的是 `schemaOf` 原样投出去的 `name/description/parameters`（`:3134-3145`），只要求是无损 JSON。参数写坏了，注册不会报错，要等发请求时 provider 那边才报。【已核实】

逐个工具：

| 工具 | output | schema 子集 | parameters | 重名 | 结论 |
|---|---|---|---|---|---|
| `edit_then_run` / `write_then_run` | `{schema: OUTPUT_SCHEMA, render}`（`lib/fusion.js:507-510`） | 只用了 type、properties、required、additionalProperties、enum（`:439-455`） | 同样在子集内（`:476-495`），嵌套的 `then_run` 也是（`:428-436`） | 全局层没有同名工具 | 能注册【已核实】 |
| `obs_recall` | `{schema: RECALL_OUTPUT_SCHEMA, render}`（`lib/observation.js:500-503`） | 没有逐行查 `RECALL_OUTPUT_SCHEMA`【推断：同一个作者、同一套写法】 | 在子集内（`:491-499`） | 不重名 | 能注册 |

还有几点：
- 没有 `isConcurrencySafe`，默认独占执行（`asar:dsh-tools:3155`）。改文件的工具本来就该这样【已核实】。
- `execute` 的返回值要符合 `output.schema`，否则抛 `ToolOutputError`（`:3637-3640`）。之后才调 `render`。两个文件都写了针对这点的测试（step2-delivery）。
- **signal**：`nestedExecution` 只在外层有 `signal` 时才传（`lib/fusion.js:360`）。registry 的 `callerCancelled` 直接读 `state.callerSignal.aborted`（`asar:dsh-tools:3372-3377`），而且是在 `prepareExecution` 的 try 之外调的（`:3313`）。callerSignal 是 undefined 时，嵌套的 `ctx.tools.execute` 会直接 reject。agent loop 调用时一定带 signal，所以平时碰不到。**建议**：没有 signal 时传 `new AbortController().signal`，再补一条测试。【已核实：读取位置；推断：哪些调用方会缺 signal】

## 5. 监听签名

| 事件 | DSH 怎么调 | dsh-sol 怎么接 | 结论 |
|---|---|---|---|
| `tools/post-execute` | waterfall，参数 `(exec, result, next)`，返回决定对象（`asar:dsh-tools:3600`） | observation 和 reducer 都接 `(exec, result, next)` | 对得上【已核实】。Chief 定的是“只挂一个监听，先 Reducer 后 ObservationPack”，SolDev 这一轮正在合并 |
| `session/event` | `(session, event)`，在 commit 里同步通知，每个监听单独隔离异常（`asar:dsh-session:1579-1592`） | `onEvent(session, event)`，全程 try，写盘不等待（`lib/meter.js:472-527`） | 对得上【已核实】 |
| `session/created` | `(session)`；返回 Promise 被 reject 时只打 warn（`asar:dsh-session:1901-1922`） | `onCreated(session)` | 对得上【已核实】 |
| `session/disposed` | `(session)`，异常隔离（`asar:dsh-session:1925-1933`） | `onDisposed(session)`（`lib/meter.js:453`） | 对得上【已核实】 |

工具注册在根上。preset 只隔离 compaction、toolResultPruner、planMode、workflowEngine（`<desktop-profile>/cordis.yml:782-861`），不隔离 `tools`，所以每个 preset 的 agent 都能看到我们的工具。dsh-ops 也是在根上注册的。【已核实：隔离清单；推断：可见性，要装上看】

## 6. 只有装上以后才能验证的

1. 本地目录安装以后，`name: dsh-sol` 能不能解析到链接进来的包。
2. 插件列表里的中英文标题、描述、图标显示对不对（`host-plugin.md:53`）。
3. 整行打开、写了 config 以后能激活，没有 warnings。config 写错时，界面上看到的报错长什么样。
   - 正例：五个键 `meter`、`actionFusion`、`observationPack`、`reducer`、`occ` 各写一次，都能激活（`lib/config.js:30`，`RESERVED_KEYS` 已经清空，`:27`）。
   - 反例要用真拼错的键，比如 `observatonPack`、`meterr`，确认抛 `ConfigError`，整行不激活。不能拿 `observationPack` 当反例，它现在是合法键（2026-10-18 SolQA 指出，Chief 改）。
4. 每个 preset 的会话里都能看到 `edit_then_run`、`write_then_run`（PTC preset 除外）。
5. Meter 第一次读 `tokenUsage` 投影就能拿到数据（report.md 3.1 是推断的）。
6. 嵌套调用 `edit` 和 `ops_bash` 走完了真实的审批和沙箱。
7. 改代码以后要不要重启才生效（`host-plugin.md:70`：替换已安装的包要重启）。
8. Reducer 和 OCC 拿到的 `llm`、`compaction`、`tokenMeter`、`agentPresets` 是不是真实的服务。

## 7. 对一遍 README 的安装步骤

| README 步骤 | 对照结果 |
|---|---|
| 1. 把 desktop patch 里的两段拷到 web profile 的 `cordis.patch.yml` | 可以。这是用户自己的 patch 层，文件头写着 “Your patch layer for this dsh profile”（`<desktop-profile>/cordis.patch.yml:1-3`）。dsh-plugin-guide 说的“不要手写 profile 文件”针对的是 Bot 代装插件，不是用户改自己的配置。web profile 现有的 cordis.yml 只有 4 行，补上这两段是必须的【已核实】 |
| 2. 装 dsh-ops | 没问题 |
| 3. 用插件管理从本地目录装 | 对得上 `host-plugin.md:35`、`:68`。界面上具体点哪里没看过【推断】 |
| 4. 检查 peer 有没有缺 | 对得上 ab-plan 第 7 节第 3 步。dsh-sol 零依赖，不受影响 |
| 5. 看插件列表 | 对得上第 3 节，但只有装上才能验证（第 6 节第 2 条） |
| 6. 打开整行、写全 config | 对得上第 2 节。五个模块的键现在都收（`lib/config.js:30`）。只有拼错的键会让整行不加载（2026-10-18 更新，原文写的“只认 meter 和 actionFusion”已经过期） |
| 冒烟检查 · Fusion：“新开会话工具列表里有两个工具” | 对得上第 5 节的“工具注册在根上”，但只有装上才能验证 |

README 和这份检查**没有冲突**。安装第 6 步那句提醒已经补进 README。

## 8. 分析账本前要先剔除 relay 合成会话

有些会话的账本是「有回合、无用量」：`requests > 0`，而 `usageTotal` 四桶全 0。**这不是漏记，也不能读成「某个 provider 不上报用量」。**

判别（两步，可复现）：

1. 数 `toolu_relay_` 前缀的 tool-call：这类会话有上千条（实测 7241 / 1237 / 6192）。
2. 数 `assistant/attempt`：**这类会话是 0**。也就是说里面没有真实模型响应，消息是 relay 拼接出来的。

根因在 `lib/meter.js:69-70`：

```js
export function bucketsFromUsage(usage) {
  if (usage === undefined || usage === null) return zeroBuckets()
```

合成消息本来就不带 usage，记 0 是忠实投影。`requests` 数的是 `assistant/message` 事件数，与有没有 usage 无关，所以照数。

**反例（防止过度推广）**：同一个库里其他 provider 的会话绝大多数正常报用量，实测 458/459、736/737、300/301、123/124、53/54。所以「全 0」是这类会话的特征，不是某条路由的属性。

**做 A/B 选会话时**：先剔除 `requests > 0` 且 `usageTotal` 全 0 的会话，否则它们会把分母拉大、把节省率压低。
