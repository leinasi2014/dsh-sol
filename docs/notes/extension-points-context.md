# DSH 0.2.1-rc.2 扩展点调研：上下文 / 压缩 / 会话 / 配置 / 模型调用 / Host 与浏览器面

目的：把 NVlabs/SoL-Pi 用到的 Pi 扩展 API 逐项对到 DSH Cordis 插件能用的东西。
源码来源：`<DSH-install>/resources/app.asar` 里的 `dsh/node_modules/@deepseek-ai/<包>/lib/index.js`（用 `asar-peek.mjs cat` 读出，行号按整个文件算）。下文写 `<包>:行号` 时指的就是这个文件。
对照旧版：`<reference-runtime>\node_modules\@deepseek-ai\`（0.2.0-rc.2）。
标注：**已核实**＝读过代码；**推断**＝从文档或代码结构推出来、没有实际运行过。
发版包里只有编译后的 `.js`，没有 `.d.ts`（`package.json` 的 `types` 指向 `lib/types/index.d.ts`，但 asar 里没有这个文件）。所以 TS 签名都是从 JS 和 README 反推的。

---

## 0. 速查表：Pi API → DSH 对应物

| SoL-Pi 用到的 | DSH 对应物 | 状态 |
|---|---|---|
| `context` 事件（每次请求前临时改写投影，不改历史） | **没有等价物**。`llm/stream` waterfall 只能观察或替换整条流，请求是深冻结的；官方路线是 surface replace（把替换持久写进日志） | 已核实（缺口） |
| `before_provider_request`（计数） | `ctx.on('llm/stream', (options, next) => …)`，用 `isAgentLoopRequest(options)` 区分主循环请求 | 已核实 |
| `turn_end` | 会话事件 `turn/end`（`ctx.on('session/event')`）；`agent/turn-stopping`（serial，回合关闭前，可以 steer 让回合继续） | 已核实 |
| `agent_settled` | `agent/status`（status 变成 `'idle'`）；`agent.whenIdle()` | 已核实 |
| `ctx.getContextUsage()` | `ctx.tokenMeter.measure(session).totalTokens` | 已核实 |
| `ctx.model.contextWindow` | `session.requestContext()?.contextWindow`，或 `await ctx.llm.resolveModelInfo(p, m).context.contextWindow` | 已核实 |
| `ctx.compact({customInstructions})` | `ctx.compaction.compactRegion(start, end, agent, signal)`（回合内）／`compactNow(agent, signal)`（空闲时）。**不支持 customInstructions** | 已核实 |
| `ctx.abort()` | `agent.cancel(cause, { keepInbox? })` | 已核实 |
| `ctx.isIdle()` | `agent.status === 'idle'`（maintenance 阶段也算 idle） | 已核实 |
| `pi.sendMessage(hidden, {triggerTurn:true})` | `agent.followup(createUserMessage({content, source:{kind:'<自定义>'}}))`；`steer()`＝下一步并唤醒；`inject()`＝下一步不唤醒 | 已核实；能否对 UI 隐藏属**推断** |
| `pi.appendEntry` | `appendPluginRecord(session, 'plugin:<owner>/<rec>', data)`（0.2.1 新增，政策上只给 experimental 包用）；或者用自有存储 | 已核实 |
| `session_start` / `session_tree` 恢复 | `agent/created` 事件 + `ctx.sessionProjections.register(fold)`，用 `pluginRecordOf(event)` 重建 | 已核实（API）；恢复流程属推断 |
| `ctx.modelRegistry.find + complete` | `ctx.llm.resolveModelInfo` / `listModels` + `ctx.llm.stream(options)` + `BlockAssembler` | 已核实 |
| `getSessionId` / `getSessionDir` | `agent.session.id`；会话目录 `<root>/<项目编码>/<会话id编码>/`，没有公开 API | id 已核实；目录属推断 |

---

## 1. 上下文投影（发给 provider 之前）

### 1.1 `llm/stream` waterfall，已核实
- 服务 `ctx.llm`（`LlmRuntime`），inject 名 `llm`。
- `dsh-llm:2393-2398`：`stream(options)` → `this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`。
- Cordis waterfall `cordis:317-325`：`next` 不接受参数（`(cbs.shift() ?? inner)(...args)`），所有监听器拿到的是**同一个 options**。监听器只能：①返回 `next()` 的结果；②包装 `next()` 的结果；③不调 `next()`，返回自己造的流。
- 主循环请求在 `dsh-agent-loop:1274-1288` 里被 `deepFreeze`，再经 `markAgentLoopRequest` 打标；`isAgentLoopRequest(options)` 可以判断（`dsh-llm:377-388`）。
- 主循环走 `preparedCall.stream(request)`（`dsh-agent-loop:1084`）。`prepareCall` 返回的 `stream` 会校验 `callConfigEquals(options, resolvedConfig)`，并且只能分发一次（`dsh-llm:2249-2259`）。之后同样进入 `llm/stream` waterfall。
- 结论：**计数和读 usage 可以做**。例：
  ```js
  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options)) return next()      // 跳过摘要器、标题等辅助调用
    count(options.sessionId)
    return (async function* () {
      for await (const chunk of next()) { if (chunk.type === 'usage') record(chunk); yield chunk }
    })()
  })
  ```
  `dsh-session-checkpoint-policy:26-31,61-65` 就是同样的写法：`yield* next()` 前先 flush。辅助调用可以按 `options.purpose`（压缩填的是 `'compaction'`，见 `dsh-compaction-basic:320`）过滤。
- **改写 messages 做不到**。options 是冻结的，`next()` 没法传新值。要改只能不调 `next()`，自己调 `ctx.llm.stream(newOptions)`。这样有三个问题：会重新进入整条 waterfall（要自己防递归）；丢掉 prepared 绑定；违反包不变式“模型可见 ⟺ 已记录”（`dsh-llm/README.zh.md` 第 12、133 行）。可行但属于越界做法，不推荐，也没有实际跑过（推断）。
- 适配器层的投影（文件转句柄、纯文本模型的图片占位、工具更新）写死在 `adapterStream` 里（`dsh-llm:2335-2349`），没有给插件开钩子。`dsh-llm-pi-ai` 也没有 `onPayload` 一类钩子（grep 无结果），已核实。

### 1.2 `agent/pre-step` waterfall，已核实
- `dsh-agent-loop:902-927`：payload 是 `{ messages: 本步领取的新输入, turn, step, signal }`，返回 `{kind:'enter', messages, startsRequestSeries?}` 或 `{kind:'reject'}`。
- 它只能替换**即将进入本步的新消息批次**，不能改历史。参考：`dsh-plan-mode:151-166` 在 `await next()` 之后往 `decision.messages` 末尾追加 narration。
- 在 `step/start` 之前运行，并且在回合内部，所以这里可以安全地做压缩或 surface 替换（compaction-basic 就挂在这里，见 §2）。

### 1.3 durable surface replace（DSH 官方认可的“改投影”办法），已核实
- `dsh-compaction-tool-result-pruner:137-191`：对 surface 上的 `tool/result`，先 `session.append('compaction/prune', {shadowedRange, shadowedSeqs, shadowedTokenCount})`，再 `session.append('tool/result', {...event.data, message}, { surfaceOp:{op:'replace', startSeq, endSeq}, sourceEventSeqs:[seq] })`。
- 原事件留在日志里，`deriveMessages()` 看到的是替换后的版本，回放结果确定。这和 Pi 的“只改投影、不改历史”语义不同：替换会一直生效，后续每次请求都看到替换后的内容。
- `session.append` 在运行时用 `validateSessionEventData` 校验（`dsh-session:1517-1538`）；`tool/result`、`user/message`、`assistant/message` 必须带 `surfaceOp`。

### 1.4 `agent/request` waterfall，已核实
- `dsh-agent-loop:1191-1195`：只决定 `{provider, model, reasoningEffort, maxTokens…}`，不碰 messages。

---

## 2. 压缩

### 2.1 服务约定，已核实
- `ctx.compaction` 是抽象类 `CompactionEngine`（`dsh-compaction:169-173`），实现方是 `BasicCompactionEngine`（`dsh-compaction-basic:800-1025`，已导出，**可以继承**，见第 1027 行）。
- inject：`['llm','tokenMeter','sessions']`；可选 `toolResultPruner`，通过 `ctx.get` 取。
- 方法：
  - `compactIfNeeded(agent, 'pressure'|'context-overflow', signal)`（914-961）
  - `compactRegion(start, end, agent, signal)`（971-976）：要求**存在打开的回合**，且整个 surface 稳定（`:460` 会抛 "no open turn"）。
  - `compactNow(agent, signal, sourceCommandId?)`（985-1011）：要求 agent 空闲。内部走 `agent.runMaintenance()`，不是空闲时抛 `ManualCompactionError('busy')`。
  - `summarize(input, agent, signal)`（899-903）：**唯一可覆盖的钩子**。
- 摘要指令是常量 `COMPACTION_INSTRUCTION`（`:243`），由 `summarizeWithLlm` 固定拼在最后（`:292-338`）。**没有 customInstructions 参数**。要定制只能继承后覆盖 `summarize()`，并在 profile 里换掉 compaction 实现（推断）。

### 2.2 触发条件与阈值，已核实
- 自动触发：`auto:true` 时注册 `agent/pre-step` 监听（`:839-852`），算 `measurement.totalTokens >= thresholdTokens`。阈值 `floor(min(W×0.8, W−O−65536))`，保留预算是 `(W−O)×16%`。先跑 pruner，再摘要，最多 `compactionRetries+1` 次（`:936-960`）。
- 溢出恢复：`agent/request-error` 收到 `CONTEXT_WINDOW_EXCEEDED` 时压缩，然后返回 `{kind:'retry'}`（`:861-887`）。
- 配置字段：thresholdRatio、headroomTokens、retainRatio/retainTokens、summarizationProvider/Model、maxTokens、compactionRetries、maxOverflowRetries、modelPolicies、auto（`:806-818`）。

### 2.3 能否用程序触发，已核实
- 插件可以在自己的 `agent/pre-step` 监听里调 `compactRegion` 或 `compactIfNeeded`，和 compaction-basic 自己的路径一样。注意 `assertNoActiveCompaction` 会报 busy。
- 回合之间可以调 `compactNow`。
- `/compact` 命令（`dsh-command-compact` 的 `executeCompact`）就是直接调 `ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`。插件用的是同一个入口，已核实。

### 2.4 压缩后自动继续，已核实
- 在 pre-step 里压缩时，回合本来就没结束，压缩完直接进入下一步，**不需要额外开一轮**。这正是 Online Compact 想要的“步骤之间压完接着跑”。
- 空闲时压缩：`compactNow` → `runMaintenance`。maintenance 期间调 `agent.followup()` 会被锁存（`wakeDriver` 设 `wakeRequested`，`dsh-agent-loop:854-858`），maintenance 结束后自动唤醒（`:841`）。所以“压缩完再 followup 一条消息”就能开新一轮。

### 2.5 本机 profile 现状（`<desktop-profile>\cordis.yml`），已核实
- 根级 `compaction-basic` / `command-compact` / `tool-result-pruner` 都是 `disabled: true`（第 382-387、436-438 行）。`token-meter` 在根级启用（380）。
- 每个 agent preset 里有 `id: compaction` 的 `cordis:group`，带 `isolate: {compaction: true, toolResultPruner: true}`（第 840-855 行；1004、1092、1267 行同理）。也就是说压缩服务**按 preset 隔离**，根级 ctx 上很可能取不到 `compaction`。插件应该在 agent 作用域里取（`agent.ctx.get('compaction')`，推断），或者把自己挂进同一个 group。
- `session-checkpoint-policy` 启用（434）。

### 2.6 checkpoint / handoff 是什么，已核实
- `dsh-session-checkpoint-policy` 只是“先 flush 再发请求或执行工具”（`:61-75`），**和摘要 checkpoint 无关**。
- 摘要替换消息的 source 是 `{kind:'compact-checkpoint', compactionId}`（`dsh-compaction:109-130`），正文前有一段固定前导 “This is an automatically generated checkpoint…”，摘要包在 `<compacted-summary>` 里。
- DS Bot 显示的 “Checkpoint N / Handoff part N” 在核心包里没找到对应文案（只 grep 了已导出的包，推断它来自 ds-bot 插件自己的呈现层）。
- `dsh-compaction-image-offload`：`agent/request-error` / `compaction/summary-error` 收到 `IMAGE_OFFLOAD_REQUIRED` 时写 `image/offload` 并重试，和本任务关系不大。

---

## 3. 运行生命周期，已核实

| 事件 / API | 位置 | 说明 |
|---|---|---|
| `agent/pre-step`（waterfall） | `dsh-agent-loop:909` | 每步开始前，可以 reject 或替换新输入 |
| `agent/request`（waterfall） | `:1191` | 选路由和控制项 |
| `llm/stream`（waterfall） | `dsh-llm:2397` | 每次 provider 尝试（重试也算） |
| `agent/request-error`（waterfall） | `:1136` | 返回 `{kind:'retry'}` 表示重试 |
| `agent/turn-stopping`（serial） | `:1001` | 回合将要关闭时；steer 进新输入，回合就不关 |
| 会话事件 `turn/start` `step/start` `step/end` `turn/end{reason}` | `:945,970,994,1029` | 通过 `ctx.on('session/event', (session, e) => …)` 观察 |
| `agent/status` | `:798` | 只有 `'running'` 和 `'idle'` 两种 |
| `agent/created` / `agent/disposed` / `agent/error` | dsh-agent | goal-round-driver 用它们管状态 |
| `agent/assistant-stream` | `:1080` | 进程内的流式帧 |

- 句柄 API（`dsh-agent-loop:790-875`）：`status`、`followup(msg)`（下一轮，并唤醒）、`steer(msg)`（下一步，并唤醒）、`inject(msg)`（下一步，不唤醒）、`cancel(cause, {keepInbox})`、`runMaintenance(job)`、`whenIdle()`。
- 注入消息并触发新一轮的现成做法：`dsh-goal-round-driver:143-164` 用 `createUserMessage({content, source:{kind:'goal', goalId, revision, round}})` 调 `agent.followup(message)`。驱动逻辑跑在 `ctx.agents.withoutInitiator(...)` 里（:183），状态在 `agent/status` 变 idle 时结算（:223-239）。
- “hidden”：source 可以填自定义 kind。客户端 UI 怎么渲染非 `user` 的 source 没有查（推断：可能显示成普通消息，或者需要 client 插件注册渲染器）。模型一定看得到这条消息，因为它会进入 surface。

---

## 4. 会话存储

- 会话 ID：`agent.session.id`；`GenerateOptions.sessionId` 也带着它，已核实。
- 会话目录：jsonl 后端 `sessionDir(root, cwd, id) = join(projectDir(root,cwd), encodeSegment(id))`（`dsh-session-persistence-jsonl:919-921`）。`locate(meta)` 只是一个诊断钩子（:2450-2455）。root 在 profile 里是 `!!js dshHomePath('sessions')`（cordis.yml:197-200）。**没有给插件的公开“会话目录”API**，属推断。插件不要往会话目录里写东西。
- 自定义日志条目：`appendPluginRecord(session, type, data)`（`dsh-session:1270-1297`）。type 的语法是 `^plugin:[a-z0-9][a-z0-9._-]*(/…)*$`（:1248）。记录带 `ignorable: true`，不进 surface，fork 和 resume 时会被带上。读回用 `pluginRecordOf(event)`。限制：
  - README（dsh-session/README.zh.md 第 70 行）写明只给 `packages/experimental/` 用，“本仓库之外的插件同样不得调用它”。
  - **0.2.0-rc.2 没有这个函数**（旧版 grep 计数为 0）。
  - 已核实。
- 恢复状态：`ctx.sessionProjections.register(definition)` 注册 fold（token-meter、plan-mode 都这么做：`dsh-plan-mode:178`，`dsh-token-meter:694-696`），resume 时按日志重放。plan-mode 用的是正式事件 `plan/mode`，第三方插件不能新增 SessionEventMap 类型，只能用 plugin record，已核实。
- 插件私有存储：
  - 官方做法是 `ctx.storageDomain.open(defineDomain({name, version, tables}))`（dsh-storage-domain README），由 schema 校验，写入后才 resolve。
  - team-studio 的做法是 `join(resolveDshHome(), 'team-studio')` 下放自己的 SQLite（`<reference-plugin>/dist/index.mjs:10863-10865`）。
  - 已核实。
- 推荐：SoL 的状态放 storageDomain 或自有目录，按 sessionId 做键。如果愿意承担“非 experimental 不得调用”的政策风险，可以用 plugin record 存日志级标记。

---

## 5. 配置，已核实
- 插件 schema：`static Config = z.object({...})`（`@deepseek-ai/schemastery`，带 `.default()`），例子见 `dsh-compaction-tool-result-pruner:63-67`。函数式插件导出 `Config`（`dsh-repeat-tool-reminder` 导出 `{ Config, apply, name }`）。构造函数是 `(ctx, config)`。
- 默认关闭：在 cordis.yml 条目上写 `disabled: true`，也支持 `!!js` 表达式（本机 profile 大量使用）。插件包的 `cordis.patch.yml` 用 `- insert: - id: x, name: pkg` 插入，可以同时带 `disabled: true` 和 `config:`（推断）。另一种做法是在 schema 里放 `enabled: z.boolean().default(false)`。
- `dsh-settings` 本身没有配置。表单只显示 volatile 字段；自带页面的插件通过 `ctx.inject(['settings'], …)` 调 `configure({auto:false}, ctx.fiber)`。

## 6. 在插件里调用另一个模型，已核实
- `ctx.llm.stream({ provider, model, messages, maxTokens?, purpose?, sessionId?, signal })`，用 `BlockAssembler` 组装结果（`assembler.blocks()`、`assembler.usage`、`assembler.finish`）。范本是 `summarizeWithLlm`（`dsh-compaction-basic:292-338`）。
- `messages` 可以用不带 id/source 的 `RequestUserInput`（`{role:'user', content:[…]}`），见 dsh-llm README 第 61 行。
- 发起前可以 `prepareCall(config, signal, configure?)` 做校验；`resolveModelInfo(provider, model)` 返回 `context.contextWindow`、`defaultMaxTokens`、reasoning efforts；`listModels` / `listProviders` 列出目录。
- 失败不会抛异常，而是一个 `finish` 分片，`kind` 为 `error` 或 `aborted`，带稳定 code。本服务不重试。
- 注意：这次调用也会经过你自己的 `llm/stream` 监听，要用 `purpose` 或 `isAgentLoopRequest` 过滤。

## 7. Host 面与浏览器面（参考 team-studio / <reference-repo>），已核实
- 一个包有两个面：`main: ./dist/index.mjs`（Host，ESM，导出 `name`、`inject`、`apply`，也可以导出 Service 类）；`exports["./client"] = ./lib/client.js`（浏览器面，用 `window.__ModuleLoader__.load({id, factory(require)})` 包装，React 从 host 的 `require` 取）。
- `package.json` 里的 `dsh: { manifestVersion:1, bundle:{patch:'./cordis.patch.yml'}, client:{platform:'web', external:[], inject:['@deepseek-ai/dsh-client-locale']} }`。
- Host 里按需注入：`ctx.inject(['agents','tools','systemPrompt'], sub => …)`；可选服务用 `ctx.get('x')?.…`（`dist/index.mjs:10866-10927`）。
- 安装：`dsh plugin --profile <web|desktop> add -w <插件目录>`（转发给 pnpm），然后把包名加进 profile `package.json` 的 `dsh.profile.bundles`，**排在官方 bundle 之后**。依赖用 `link:`。拷到别处安装时要删掉 `devDependencies`（`workspace:*`）。改代码后要完整重启，热加载没验证过（install-into-your-dsh.md §3、§6）。
- 版本钉住：`peerDependencies` 用精确版本。DSH 安装和启动时会按 `dsh --version` 校验 peer 范围。team-studio 钉的是 `0.2.0-rc.2`，**本机 DSH 是 0.2.1-rc.2**（asar 里各包的 `version` 字段），照搬会被拒绝（推断，依据 README 的描述）。SoL 插件应钉 `@deepseek-ai/*@0.2.1-rc.2`，`@deepseek-ai/cordis` 钉安装中的实际版本（team-studio 用的是 4.0.4，需要对照本机核对）。
- 安全：`ctx.webServer` 上的路由默认不鉴权，要经过 `ctx.connection` 准入（<reference-repo> AGENTS.md）。

## 8. 0.2.0-rc.2 → 0.2.1-rc.2 差异（只查了相关点），已核实
- `appendPluginRecord` / `pluginRecordOf`：旧版没有，新版有。
- `llm/stream` waterfall、`isAgentLoopRequest`、`runMaintenance`、`compactNow(agent, signal, sourceCommandId)`：两版都有，签名一致（只 grep 了出现与否和签名行）。

---

## 9. 结论：两项 SoL 机制能否纯插件实现

### 9.1 Online Context Compact（计划步骤完成后，按经济性触发原生压缩并自动续跑）
**能用纯插件实现，不需要改 DSH 核心。** 缺的只有“自定义摘要指令”，这一项要靠继承来补。
- 触发点：插件注册 `agent/pre-step` 监听（回合内、步骤之间）。用 `tokenMeter.measure(session).totalTokens` 和 `resolveModelInfo(...).context.contextWindow` 做经济性判断；“计划步骤完成”可以从 `tool/result`（例如 todo 工具）对应的 `session/event` 中识别。满足条件就调 `compaction.compactRegion(start, end, agent, signal)`（范围选择可以照 basic 的 `selectCompactableRange`，但它没有导出，需要自己实现，并用 `toolPairingBalancedBefore/After` 校验边界）；也可以直接调 `compactIfNeeded`。之后 `return next()`，回合**自然续跑**，不需要 triggerTurn。
- 回合之间：监听 `agent/status` 变 idle → 调 `compactNow` → 在 maintenance 期间 `followup(继续提示)`，结束后会自动唤醒。也可以用 `agent/turn-stopping` 加 `steer` 让回合不关。
- customInstructions：继承 `BasicCompactionEngine` 并覆盖 `summarize()`，再在 profile 的每个 preset 的 compaction group 里把 `compaction-basic` 换成自己的实现。改的是配置，不是核心。
- 原生已覆盖的部分：阈值触发（只看压力，不看经济性和计划边界）、溢出恢复、pruner、`/compact`、checkpoint 标记、锁、回放确定性。约 60–70%（推断）。SoL 只需补“按计划边界和经济性提前触发”和“定制指令”。
- 风险：压缩按 preset 隔离（§2.5），插件必须在 agent 作用域里拿到 compaction；和 basic 的自动触发同时存在时可能撞锁（busy），建议把 basic 的 `auto` 设为 false，由 SoL 接管。

### 9.2 ObservationPack（每次请求前改写投影，不改历史）
**无法用纯插件忠实实现“临时投影”语义。** 如果接受“持久替换”语义，就能纯插件实现。
- 缺口：DSH 的设计不变式是“模型可见 ⟺ 已记录”。主循环请求深冻结，`llm/stream` 的 `next()` 不接受参数，适配器投影是写死的。没有和 Pi `context` 事件对等的钩子。
- 选项 A（推荐，纯插件）：在 `agent/pre-step` 里对旧的 `tool/result` 等节点做 surface replace，照 `ToolResultPruner.pruneSession` 的写法，先写 `compaction/prune` 影子价，再写 replace。效果是“改投影，原文留在日志里”，但改写会**一直生效**，不能每次请求重新从原文生成。对 KV cache 的影响和 Pi 一样，都是从第一个被改的节点起失效。如果 ObservationPack 的改写是幂等、单调的（例如折叠旧观察），这种方式等价。
- 选项 B（越界）：`llm/stream` 监听不调 `next()`，复制 options 并改写 messages 后重新调 `ctx.llm.stream`，同时防递归。违反不变式，日志里也没有模型实际看到的内容，并且会丢掉 prepared 绑定。不推荐，也没有验证过。
- 选项 C（改核心）：给 dsh-llm 或 agent-loop 加一个“请求投影”waterfall，允许 `next(newOptions)`，并把投影结果记入日志。只有这样才能得到真正的“临时投影”，属于上游变更。
- 计数（before_provider_request）和读 usage：用 `llm/stream` 包装即可，纯插件，已核实。
