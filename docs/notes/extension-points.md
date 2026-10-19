# DSH 0.2.1-rc.2 插件扩展点调研（面向 SoL-Pi 四机制移植）

日期：2026-10-18。只读调研。
证据来源约定：
- `asar:` = `<DSH-install>/resources/app.asar` 里 `dsh/node_modules/@deepseek-ai/<包>/...`，版本 0.2.1-rc.2，**以此为准**。行号对应 lib/index.js 打包产物或 README。
- `0.2.0:` = `<reference-runtime>\node_modules\@deepseek-ai\<包>\lib\types\*.d.ts`。asar 里**没有任何 .d.ts**（package.json 声明了 `types` 但文件没打进去），类型签名只能参考 0.2.0，并在 asar 的 JS 中确认同名事件/方法仍然存在。
- 标注：【已核实】= 读到代码；【推断】= 从代码/文档推出但没跑过；【未找到】。

---

## 0. 关键版本差异（先看）

| 项 | 0.2.0-rc.2 | 0.2.1-rc.2（asar） |
|---|---|---|
| `dsh-hook-protocol` / `dsh-hooks-claude-code` / `dsh-hooks-codex` | 有包 | **asar 里没有这些包**。它们只列在 `@deepseek-ai/dsh/package.json:115-116` 的 **devDependencies** 里，桌面版没有带。【已核实】 |
| `.d.ts` 类型 | 有 | asar 里没有（只有 .js） |
| team-studio 插件 peer 版本 | 写的是 `0.2.0-rc.2` | app-boot 会按 peer 校验版本，**写 0.2.0-rc.2 的插件在 0.2.1-rc.2 上会被拒绝加载**（见 A）。【已核实：校验逻辑】 |

结论：别依赖 hooks 桥。全部走原生 Cordis 事件。

---

## A. 插件形态

**结论**：一个 npm 包 = 一个 "bundle"。package.json 用 `dsh.bundle.patch` 指向 `cordis.patch.yml`，patch 用 `insert` 把自己的行插进 profile。浏览器面用 `dsh.client` + `exports["./client"]`。profile 里 `package.json.dsh.profile.bundles` 的顺序决定各层 patch 的优先级。

证据：
- bundle 声明：`asar:dsh-experimental-ralph-bundle/package.json:35-39`（`"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`），`exports` 里导出 `./cordis.patch.yml`（:22）。【已核实】
- patch 格式：`asar:dsh-base/cordis.patch.yml:15-` 是 `- insert: [ {id, name, config, disabled} ]`。注释（:1-13）：后面的 bundle patch 和用户 profile patch 按 **id 定位行，最后写入的赢**；patch **整体替换**该行的 `config`，不做深合并（app-boot README:204 也是这么说的）。`disabled` 可以是 `!!js` 表达式。【已核实】
- 最小示例：`<reference-plugin>\cordis.patch.yml` 就是 `- insert: [{id: team-studio, name: <reference-plugin>}]`；package.json 的 `dsh.manifestVersion: 1`、`dsh.bundle.patch`、`dsh.client{platform:'web', external:[], inject:[...]}`、`exports{".", "./client"}`。【已核实】
- profile 挂载：`<desktop-profile>\package.json:9-25`，`dsh.profile.bundles` 是一个有序列表（`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `dsh-ops`, …, `ds-bot`），包本身放在 `dependencies`。profile 自己的 `cordis.patch.yml` 在所有 bundle 层之后应用（app-boot README:61）。plugin-manager 启用 bundle 时会**追加到列表末尾**（plugin-manager README:40）。【已核实】
- 版本校验（这是硬约束）：`asar:dsh-app-boot/lib/index.js:279-299` `unmetRequirements`：如果有 `engines.dsh`，就**只**用它判断；否则 **每一个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peerDependency 的范围都必须满足运行时版本（`includePrerelease: true`，:277）。运行时版本取自 app-boot 自己的 package.json（:271-275）。不满足的 bundle 会被跳过并列进 `skippedBundles`（app-boot README:50,54）。豁免写在 profile 的 `compatibility.json` 里（README:56）。【已核实】
  - 注意：`dsh-package-manifest/README.md:93` 说 "loaders 不强制 engines.dsh"——**这句已经过时**，和 app-boot 的代码矛盾，以代码为准。
  - 建议：插件写 `"engines": {"dsh": ">=0.2.1-rc.2 <0.3.0"}` 或者让 peer 用 `~0.2.1-rc.2` 之类，别钉死版本。
- client 面：`asar:dsh-client-ui-plan/package.json:21-24,29-43`：`exports["./client"] -> ./lib/client.js`，`dsh.client.inject` 列出它依赖的客户端包，`platform: "web"`。`dsh-client-modules/README.md:34`：声明 `dsh.client{platform:'web'}` + 导出 `./client`，主机会通过 `/plugins` 提供这个 bundle；不在共享基线里的模块要列进 `dsh.client.external`（:50）。【已核实】
- Host 插件模块形态（Cordis）：导出 `name`、`inject`、`Config`（schemastery）、`apply(ctx, config)`，例如 `asar:dsh-tool-fs/lib/index.js:1186-1229`。也可以导出一个继承 `Service` 的 class（比如 `dsh-compaction-basic` 的 `BasicCompactionEngine`，:800）。【已核实】

---

## B. 工具注册与包装

**结论**：`ctx.tools.register(defineTool({...}))` 注册工具。**能拦截任意已有工具（含 write/edit/bash/pwsh/str_replace_editor）的调用前后**：有一条固定的 waterfall 流水线，插件只要 `ctx.on(...)` 就能挂上去：
`tools/pre-execute`（allow/deny/ask/cancel）→ `ctx.tools.guard()`（单调同步拒绝）→ `tools/execute`（包住真实执行，适合超时/重试/计量）→ `tools/post-execute`（accept 时可替换 content 或 value，block 时返回反馈，或者追加 `additionalContexts`）→ 工具自己的 `finalizeContent` → `tools/result`（只读观察）。
**限制**：`pre-execute` **不能改写参数**（`exec.arguments` 被冻结）。

证据：
- 流水线说明：`asar:dsh-tools/README.md:87-91, 109, 139-141`。【已核实】
- 实现位置（asar 0.2.1）：`dsh-tools/lib/index.js` pre-execute `:3321`，guard `:3017`（`guardReason` :2745），execute `:3427`，post-execute `:3600-3632`（规则：`block` → `isError` + feedback；`accept` 时可以带 `content` **或** `value`，两者不能同时给 :3611；失败的结果不能替换 value :3614；`additionalContexts` 会累加），result `:3513`，`ptc-dispatch-log` `:3173`。register `:2974`。【已核实】
- 事件签名：`0.2.0:dsh-tools/lib/types/index.d.ts:36-104`（`'tools/pre-execute'(exec,next)`、`'tools/execute'(exec,next)`、`'tools/post-execute'(exec,result,next)`、`'tools/ptc-dispatch-log'(dispatch,next)`、`'tools/result'(exec,result)`、`'tools/change'()`）。这些事件名在 0.2.1 JS 中都存在。【已核实】
- 不能改写参数：`asar:dsh-tools/README.md:233`。【已核实】
- 内置工具名（asar）：`write`（dsh-tool-fs :549），`edit`（:690），`read`（:251），`read_image`（:986），`bash`（dsh-tool-bash :493，Windows 下禁用，dsh-base patch :281-283），`pwsh`（dsh-tool-pwsh :466，只在 Windows 启用），`str_replace_editor`（dsh-tool-str-replace-editor :267，**dsh-base 没挂载它**），`todo_write`（dsh-tool-todo :96）。【已核实】
- write 的 canonical value：`{path, operation:'create'|'update', before, after}`（dsh-tool-fs :564-588），post-execute 里拿 `result.value` 就能知道写了哪个文件。【已核实】
- 真实例子：
  - `dsh-repeat-tool-reminder/lib/index.js:2247-2260`：post-execute 先 `await next()` 再给结果追加 `additionalContexts`（一条 `createUserMessage({content, source:{kind:'repeat-tool-reminder', form:'notice', ...}})`）。【已核实】
  - `dsh-tool-fs-search/lib/index.js:848-863`：post-execute 只处理自己的工具，用 accept + 新 content 替换结果。【已核实】
  - `dsh-tool-call-timeout-policy:116` 和 `dsh-session-checkpoint-policy:66` 都用 `tools/execute` 包住执行。【已核实】
  - `dsh-fs-observation-policy:90` 用另一个 waterfall `fs/write-intent`（write 工具在 dsh-tool-fs :607 调用它）。【已核实】
- 自定义 message source 要通过声明合并扩展 `MessageSourceMap`（`0.2.0:dsh-repeat-tool-reminder/lib/types/*.d.ts:12-15`）。【已核实】
- **Action Fusion 落地**【推断】：`ctx.on('tools/post-execute', ...)`，筛选 `exec.name in {write, edit}`、`!result.isError`、`exec.parent === undefined`，从 `result.value.path` 拿到文件，用 `ctx.shell.resolve({command, workdir, timeoutMs, stdoutMaxBytes, sandboxPolicy})` + `execute().result()` 跑校验命令（team-studio 的 `<reference-plugin-src>\src\orchestrator\check-runner.ts:54-72` 是现成写法；`ctx.shell` 在 asar 里叫 `"shell"` service，`dsh-shell/lib/index.js:85`）。然后返回 `{kind:'accept', content:[...原内容, 校验摘要]}`。沙箱策略要用 `ctx.sandboxPolicy.resolve()`，别自己拼。注意：`ctx.on` 默认是 append，spill-policy 用的是 `{prepend:true}`（spill-policy :255），要考虑跟 spill 的先后顺序（spill 是 prepend，并且先 `await next()`，所以它在**所有** post-execute 处理之后才做截断）。
- `dsh-agent-tool-presentation`：只决定每个 preset 是 native 还是 ptc 呈现（README Summary），**不是**扩展点。PTC 模式下，子调用的 `exec.parent !== undefined`，并且 `exec.name` 是真实工具名，post-execute 同样会触发。【已核实（README:130、spill-policy :242 有区分 parent）】

---

## C. 工具结果后处理（spill / 截断）

**结论**：有两层，都和 ObservationPack 相关：
1. **dsh-spill-policy**（执行时）：`tools/post-execute` 里预估 token，超过 `maxInlineTokens`（dsh-base 默认 **12500**）就把**完整文本**写进 spill 文件，模型只看到首尾预览 + `[...]` + 一行提示 `(Omitted N bytes. Full formatted result stored at: <绝对路径>. Use read with offset/limit, or grep this path to search within it.)`。给模型的是**本机文件路径**，不是稳定句柄。`read` 工具的结果不截断。
2. **dsh-compaction-tool-result-pruner**（压缩时）：只有在压缩判定达到阈值后才运行，把已经在 surface 上、超过 `thresholdChars`（8192 code points）的 tool/result 换成 head 4096 + marker + tail 1024，原文保留在会话日志里。

证据：
- spill-policy：`asar:dsh-spill-policy/lib/index.js:141-260`；跳过 `read` 和非 accept 的结果 :239；落盘调用 `spillStore.saveText({owner:{sessionId}, source:{kind:'tool', toolName, callId, label}, suggestedName:`${toolName}.txt`, content})` :189-199；提示文字 :24-27；失败时保留原内容 :232-235；listener 是 `prepend:true` 并先 `await next()` :237-238,255。dsh-base 配置 `asar:dsh-base/cordis.patch.yml:411-417`。【已核实】
- spill 存储：`asar:dsh-spill/lib/index.js:52` 抽象 `SpillStore extends Service`（service 名 `spillStore`，只有 `saveText` 一个方法）。`asar:dsh-spill-local/lib/index.js:30-35` 默认根目录是 `os.tmpdir()/dsh-spill-XXXXXX`（每个进程一个，0700），会话子目录 `session-<sha256(sessionId)前12位>` :69-70，文件名 `<12位随机hex>-<suggestedName>` :79，0600 权限；`retrievalHint` :566。配置 `root`、`cleanupPeriodDays`（默认 30 天，启动时清理一次）`dsh-spill-local/README.md:43-44`。【已核实】
  - 含义：默认情况下 spill 文件在临时目录，**跨进程不稳定**（每个进程新建根目录，旧目录 30 天后清理），路径里也没有稳定 ID。
- 能否替换策略：可以。①在 profile patch 里把 `spill-policy` 行设为 `disabled: true` 或调整 `maxInlineTokens`；②自己实现一个 `SpillStore` 子类（注册成 `spillStore` service）来换存储和提示；③自己挂一个 post-execute listener。【已核实：配置与 service 形态；推断：替换 service 的具体行为（Cordis 同名 service 冲突规则没有核实）】
- 其他工具自带的截断：`dsh-output-retention` 是一个**库**（不是插件），给工具提供 `ItemRetainer`/`TextRetainer`/提示格式（README:12）；比如 glob 超过上限时也会 spill（`dsh-tool-fs-search :848-863`，`trySaveFormattedResult`）。【已核实】
- pruner：`asar:dsh-compaction-tool-result-pruner/lib/index.js:71`（service 名 `toolResultPruner`），`pruneSession` :137-184：对每个 tool/result 先 append `compaction/prune`（影子价格），再 append 一个 `tool/result` 并带 `surfaceOp:{op:'replace', startSeq:seq, endSeq:seq}, sourceEventSeqs:[seq]`。调用方：`dsh-compaction-basic/lib/index.js:926-945`（只在 overflow 或者超过阈值时）。默认值 `dsh-base/cordis.patch.yml:425-430`。【已核实】
- **对 ObservationPack 的启示**【推断】：
  - 做法 A（推荐，执行时）：post-execute 里对 `exec.name` 做内容哈希；重复出现的大段输出换成 `obs:<hash>` 句柄 + 摘要，原文写进插件自己的存储（见 E），再注册一个 `observation_read({handle, page})` 工具按页精确回读。要放在 spill-policy **之前**完成替换（spill 是 prepend 并先 `next()`，所以它看到的是我们替换后的内容，替换后变小就不会再触发 spill）。
  - 做法 B（事后改写历史）：模仿 pruner，用 `session.append('tool/result', {...event.data, message}, {surfaceOp:{op:'replace',...}, sourceEventSeqs:[seq]})` 改写 surface 上已有的结果。这是内部协议（pruner 通过 compaction 契约做的），而且**会让 KV cache 从被改写的位置开始失效**（compaction README:150）。插件直接这么做没有找到官方说明，风险较高。

---

## D. 上下文与压缩

**结论**：
- 压缩是一个可替换的 Cordis service `ctx.compaction`（抽象类 `CompactionEngine`，三个方法：`compactIfNeeded(agent, trigger, signal)`、`compactNow(agent, signal, sourceCommandId?)`、`compactRegion(start, end, agent, signal?)`）。**插件可以主动调用**，不用依赖 `/compact`。
- 自动触发：`dsh-compaction-basic` 在每个 `agent/pre-step` 调用 `compactIfNeeded(agent,'pressure')`，在 `agent/request-error`（CONTEXT_WINDOW_EXCEEDED）调用 `compactIfNeeded(agent,'context-overflow')` 然后 `{kind:'retry'}`。阈值 = `min(contextWindow × thresholdRatio(默认 0.8), 预算)`，保留尾部 `retainRatio` 默认 0.16，可以按模型覆盖（`modelPolicies`），`auto:false` 可以关闭自动压缩。
- "压缩后继续"：**回合内压缩**（pre-step 时）本身就会继续：压缩完 `next()`，同一回合接着跑。`compactNow` 要求 agent **空闲**（走 `runMaintenance`），压缩完**不会自动开新回合**；要继续就自己 `agent.followup(msg)`（goal-round-driver 就是这么续回合的）。
- token 用量 / 窗口：`ctx.tokenMeter.measure(session)` 返回 `totalTokens` 等；窗口用 `ctx.llm.resolveModelInfo(provider, model, signal)` → `info.context.contextWindow`。
- todo/plan 步骤完成：**没有专门事件**。todo 是 `todo/write` 会话事件（整表替换），可以监听 `session/event` 或者对 `todo_write` 挂 `tools/result`；plan 是 `plan/mode` 会话事件 + `exit_plan_mode` 工具结果（`approved`）。

证据：
- 抽象契约：`asar:dsh-compaction/lib/index.js:169-173`（`class CompactionEngine extends Service`，`super(ctx,"compaction")`）；签名与语义 `0.2.0:dsh-compaction/lib/types/index.d.ts:102-158`；README:51,78 "继承基类并实现三个操作，加载后成为组合中的压缩 service"；README:159 "没有面向模型的压缩工具"。【已核实】
- basic 的实现：`asar:dsh-compaction-basic/lib/index.js`：默认值 :15-17（0.8 / 0.16）；配置 :806-818；`auto` 开关 :827；pre-step 触发 :839-852；overflow 重试 :861-887；`compactIfNeeded` :914-961（先用 pruner，再循环 `compactRegion`，最多 `compactionRetries+1` 次）；`summarize()` :899-903 是**唯一推荐的覆写点**（"Override this sole hook for a template or remote summarizer"）。在 dsh-base 中挂载 :351-352。【已核实】
- `/compact`：`asar:dsh-command-compact/lib/index.js:49-72`，只调用 `ctx.compaction.compactNow(invocation.agent, signal, commandId)`，返回一段文字，**不会续回合**。【已核实】
- 空闲维护：`asar:dsh-agent-loop/lib/index.js:822-840` `runMaintenance` 如果 agent 不空闲就同步抛错。`followup/steer/inject` :806-814（`followup` = `send(next-turn, wake=true)`；`steer` = `send(next-step, wake=true)`；`inject` = `send(next-step, wake=false)`）。语义：`0.2.0:dsh-agent/lib/types/runtime-types.d.ts:139-210`。【已核实】
- 续回合范例：`asar:dsh-goal-round-driver/lib/index.js:142-164`（`agent.followup(createUserMessage({content, source:{kind:'goal',...}}))`），在 `agent/status==='idle'` 时驱动 :223-241，用 `ctx.agents.withoutInitiator` 包住 :183。【已核实】
- agent 事件（0.2.1 JS 中存在）：`agent/pre-step`（waterfall，可以拒绝/替换本步消息）`dsh-agent-loop :909`；`agent/request`（waterfall，可替换调用配置）:1191；`agent/request-error` :1136；`agent/turn-stopping`（serial，回合要结束时；listener 可以 `agent.steer()` 让它再跑一步）:1001；`agent/status` :798；`agent/error` :880；`agent/created`（dsh-agent :581）。签名 `0.2.0:dsh-agent/lib/types/runtime-types.d.ts:227-407`。【已核实】
- token meter：service 名 `tokenMeter`（`asar:dsh-token-meter/lib/index.js:692`），`measure(session, requestHeader?)` :722；返回字段 `totalTokens/surfaceTokens/nodes/baseline...`（`0.2.0:dsh-token-meter/lib/types/types.d.ts:24-36`），`estimateMessage(msg)`。session projection 还有 `tokenUsage`/`contextPressure`（含 `contextWindow`）/`contextBreakdown`（token-meter README:49）。【已核实】
- 窗口：`dsh-compaction-basic/lib/index.js:936-940`（`ctx.llm.resolveModelInfo(...)`，`info.context.contextWindow`，`info.defaultMaxTokens`）；路由目标取自 `agent.session.requestHeader()?.config`（:293 附近）。【已核实】
- checkpoint：`asar:dsh-session-checkpoint-policy/lib/index.js:61-75`，在 `llm/stream`、顶层 `tools/execute`、`agent/pre-step` 之前 `ctx.sessions.flush(session)`。不可配置，是持久化而不是 handoff。【已核实】
- turn-outline：只是给客户端用的历史导航 projection（README Summary），**和压缩无关**。【已核实】
- todo：`asar:dsh-tool-todo/lib/index.js:170-173` `exec.agent.session.append("todo/write", {todos})`，每次整表。【已核实】
- plan：`asar:dsh-plan-mode/lib/index.js:148`（service `planMode`），`session.append("plan/mode",{active})` :381,396；`exit_plan_mode` 的结果 `{approved}` :242-301。【已核实】
- goal：`dsh-goal`（service `goals`，:592），事件 `goal/changed`、`goal/activation-changed`（`0.2.0:dsh-goal/lib/types/domain.d.ts:86`、`types.d.ts:130`）。【已核实】
- 策略能否替换【推断】：两条路。①继承 `BasicCompactionEngine` 只覆写 `compactIfNeeded`（basic 的注释 :831-832 明说 "compactIfNeeded stays dynamically dispatched so subclass overrides are honored"），在 profile patch 里禁用 `compaction-basic` 行，插入自己的行；②保留 basic，设 `auto:false`，自己在 `agent/pre-step` 或 todo 完成时调用 `ctx.compaction.compactRegion/compactIfNeeded`。注意：`compactRegion` 要求在**打开的回合里**（basic :460 "no open turn — automatic compaction events must be enclosed in a turn"），`compactNow` 要求**空闲**。Cordis 同名 service 多实现时谁生效，我没有核实。
- **对 Online Context Compact 的落地**【推断】：监听 `session/event` 中 `todo/write`（发现有 item 从 in_progress 变成 completed），或者 `tools/result` 中 `todo_write`，记一个"待压缩"标记；在下一个 `agent/pre-step` 里用 `tokenMeter.measure` + `resolveModelInfo` 做经济性判断，然后 `await ctx.compaction.compactIfNeeded(agent,'pressure',signal)`（只会在超过阈值时压缩），或者对低于阈值的情况调用 `compactRegion(start,end,agent,signal)`（范围要自己用 `toolPairingBalancedBefore/After` 校验）。因为是在 pre-step 里同步完成，压缩后同一回合**自动继续**，不需要额外续回合。若在回合结束后（`agent/turn-stopping` 或 idle）用 `compactNow`，就需要 `agent.followup()` 来续。

---

## E. 会话存储

**结论**：
- 会话日志：`$DSH_HOME/sessions/<项目key>/<编码后的sessionId>/` 下的 `.jsonl` / `.jsonl.zstd`（`dsh-base patch :138-141` 的 `root: dshHomePath('sessions')`）。
- 插件私有存储：①`ctx.storageDomain.open(defineDomain({name, version, tables}))`，后端 json，根目录 `$DSH_HOME/storages`（dsh-base :179-190）；②自己写到 `$DSH_HOME/<插件名>/`（team-studio 就是 `join(resolveDshHome(),'team-studio')`）。
- session id：工具里用 `exec.agent?.session.header.id`（spill-policy :185），agent 上有 `agent.id`/`agent.session`。
- 往会话日志写自定义事件：`appendPluginRecord(session, 'plugin:<包名>/...', data)`（从 `@deepseek-ai/dsh-session` 导出），读回用 `pluginRecordOf(event)`。**但 README 明确说只限仓库内 `packages/experimental/` 的包使用，外部插件 "must not call it"**。直接 `session.append` 一个未知类型的事件不在支持范围内（未知事件需要 `ignorable` 标记，否则重开会话会失败——README:203）。

证据：
- `asar:dsh-session-persistence-jsonl/lib/index.js:750-753`（扩展名）、:908-932（`root/<projectKey(cwd)>/<encodeSegment(id)>/<generation log>`）。实测目录 `<DSH_HOME>\sessions` 存在。【已核实】
- `asar:dsh-home-paths/lib/index.js:11-15,109-132`（`DSH_HOME` 环境变量 > 默认 `~/.dsh`；`dshHomePath(...segments)`）。【已核实】
- storageDomain：`asar:dsh-storage-domain/README.md:12,36-58`（`defineDomain`、`ctx.storageDomain.open(spec)`、同步读、写入持久化后才 resolve、`domain/changed` 事件、要 `close()`）；不进会话日志、模型看不到（:12）。json 后端 `dsh-storage-json/README.md` Summary。【已核实】
- plugin record：`asar:dsh-session/lib/index.js:1285-1314`（类型格式 `plugin:` + 小写段；返回 seq）、导出列表 :2052；限制 `dsh-session/README.md:68-70`。`session.append(type,data,{surfaceOp,sourceEventSeqs})` :1517-1538（会校验 surface 事件）。【已核实】
- 监听会话事件：`'session/event'(session, event)`、`'session/created'`、`'session/flush'`（`0.2.0:dsh-session/lib/types/index.d.ts:42-73`；0.2.1 中被多个包使用，如 compaction-basic :856）。【已核实】
- **对 ObservationPack / Reducer 存档的建议**【推断】：原文存档放 `storageDomain`（适合小记录/索引）+ `$DSH_HOME/<插件>/archive/<sessionId>/<sha256>.txt`（大段原文），以 sha256 为句柄，**跨进程稳定**。不要依赖 spill-local 的临时目录。

---

## F. 配置

**结论**：插件导出 `Config = z.object({...})`（`@deepseek-ai/schemastery`，`z.number().default(...)` 这样给默认值）。实际值写在 profile 的 `cordis.patch.yml` 对应行的 `config:` 下（bundle 的 patch 提供默认，用户 profile patch 覆盖，**整体替换不合并**）。设置 UI：**只有用 `.volatile()` 标记的字段**会出现在 dsh-settings 的表单里；表单报告 `autoGenerate`，但 README 说 "no shipped client does so yet"（没有内置客户端按 schema 自动生成页面）。想要配置页就在 client 面往 `plugins.bundle.config` / `plugins.row.config` 槽里注册自己的页面。

证据：
- Config 写法：`asar:dsh-tool-fs/lib/index.js:1194-1203`；`dsh-compaction-tool-result-pruner/lib/index.js:64`（`z.number().step(1).min(1).default(...)`）；`dsh-spill-policy/lib/index.js:127`。【已核实】
- patch 不合并：`dsh-base/cordis.patch.yml:6-10`、app-boot README:204。【已核实】
- 设置：`asar:dsh-settings/README.md:12,33,39`（只暴露 volatile 字段；`autoGenerate` 默认开，但没有内置客户端用它；自带页面的插件用 `configure({auto:false}, ctx.fiber)`）。写入走 `dsh-config-editor`（写进当前 profile patch 并立即应用，Summary）。【已核实】
- 配置页槽位：`asar:dsh-client-ui-plugin-manager/README.md:73`（`plugins.item`、`plugins.bundle.config`（按包名）、`plugins.row.config`（按 `<包名>#<行id>`））。【已核实】
- volatile 字段热更新：`cordis-plugin-loader/README.md:53`（只改 volatile 字段不会重挂插件，会发 `loader/volatile-update`）。【已核实】
- `--dump-config-schema` 可以导出组合后的 JSON Schema（app-boot README:54,77-79）。【已核实】

---

## G. LLM 调用

**结论**：插件可以直接用 `ctx.llm.stream({provider, model, messages, maxTokens, signal, sessionId?, ...})`，用宿主已配置的路由和凭据（凭据按请求解析，`apiKeyEnv` 走凭据服务），这是官方说法里"插件调用模型的唯一支持路径"。返回 token 级 chunk，用 `BlockAssembler` 组装；最后一定有 `usage` 再 `finish`。
**是否计入会话 token**：`tokenUsage` projection **只统计 `assistant/message` 和 `assistant/attempt` 事件**里的 usage，所以独立的 `ctx.llm.stream` **不会计入**会话用量统计（连 compaction-basic 的摘要调用都只把 usage 写进 `compaction/summary` 事件，不进 tokenUsage）。另外：如果传了 `sessionId`，checkpoint-policy 会在调用前先 flush 那个会话。

证据：
- `asar:dsh-llm/README.md:12,30-34,46-58,84,133,138`（stream 用法、"模型可见 ⟺ 已记录"的约定、usage 在 finish 前）。service 名 `llm` `dsh-llm/lib/index.js:1816`；`imageRequestPricing` :1697。【已核实】
- 真实辅助调用：`dsh-compaction-basic/lib/index.js:293-323`（取 `agent.session.requestHeader()?.config` 作为路由；`toolHistory`、`sessionId: agent.session.id`；`for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`），`summarizationProvider/summarizationModel` 可单独配置（:811-812）。写 `compaction/summary` 时带 `usage` :629-648。【已核实】
- tokenUsage 只认 assistant 事件：`asar:dsh-token-meter/lib/index.js:368-372`（`usageOf`）。【已核实】
- checkpoint 对带 sessionId 的 stream：`dsh-session-checkpoint-policy/lib/index.js:61-65`。【已核实】
- llm-pi-ai 与 Pi 的关系：`asar:dsh-llm-pi-ai/package.json:46` 依赖 `"@earendil-works/pi-ai": "^1.1.0"`；asar 里实际是 `dsh/node_modules/@earendil-works/pi-ai/package.json` version 1.1.0，`author: "Mario Zechner"`，repository `github.com/earendil-works/pi`，`directory: packages/ai`。README Summary：把模型请求路由到多个 pi-ai provider。dsh-base 中它是"休眠"挂载的，只有 settings 里给了 `providers` 才有路由（dsh-base :128-136）。你本机 desktop profile 正在用它（<local-provider-2> / zai / <local-provider> 路由，`profiles/desktop/cordis.patch.yml:14-133`）。【已核实】
  - **意味着**：DSH 只用了 Pi 单仓库里的 **`pi-ai`（LLM 统一 API 层）**，作为一个 provider 适配器；agent 循环、工具、会话、扩展机制都是 DSH 自己的（dsh-agent-loop / dsh-tools / dsh-session）。asar 里**没有** Pi 的 coding-agent / 扩展 API 包（只找到 `@earendil-works/pi-ai` 和 `@earendil-works/pi-telemetry`）。所以 SoL-Pi 依赖的 Pi **扩展 API**（工具钩子、会话、压缩事件等）在 DSH 中**没有对应**，需要按上面 B-E 的原生扩展点重写；只有"直接调用 pi-ai 的 `complete/stream`"这一层在概念上相通，但插件里应该走 `ctx.llm.stream`，而不是自己 import pi-ai（这样才能复用宿主凭据和路由）。【已核实：依赖关系；推断：SoL-Pi 具体用到的 Pi API（没读 SoL-Pi 源码）】
- **Reducer 落地**【推断】：在 post-execute 里（只针对 bash/pwsh 等，且输出很长）调用 `ctx.llm.stream`（模型可以配置，比如 flash），要求输出 JSON `{summary, quotes:[{text}]}`；对每条 quote 在**存档原文**中做逐字 `includes` 检查，任何一条不匹配就返回 `next()` 的原决定（保留原结果）；通过的话 `accept` + 新 content（摘要 + 引文 + 原文句柄）。必须把 `exec.signal` 传给 stream。注意 "模型可见 ⟺ 已记录" 约定：替换后的 content 会作为 tool/result 写进日志，满足要求；辅助调用本身的 usage 不计入会话，需要的话自己记（storageDomain）。

---

## H. 浏览器面

**结论**：client 插件可以：往 `ctx.slots` 的各个槽注册组件（侧栏面板 `sidebar.panellist`、主区 `main`、设置 `settings.section`、插件配置页 `plugins.bundle.config` 等）；按工具名往 `tool.call.toolview` 注册自定义工具卡片（未注册的工具用通用卡片）。四个机制**都不需要**浏览器面才能工作：Action Fusion / Reducer 的结果是工具结果文本，通用卡片就能显示；`observation_read` 新工具同样有通用卡片。浏览器面只是锦上添花（比如给 observation 句柄做漂亮卡片、做配置页）。

证据：
- `asar:dsh-client-ui-tool/README.md:12,36-50`（`ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({name:'tool.call.toolview', ...}))`，props 为 `ToolCallOwnerProps`：callId、toolName、phase、block…；未注册用通用卡片）。【已核实】
- Web 客户端不读取 host 端的 `presentCall/presentResult`（`dsh-tools/README.md:93-95`）。【已核实】
- 槽位用法：`<reference-plugin-src>\src\client\index.tsx:8,124-128`（`inject = ['slots','connection','layout','locale']`，注册 main / sidebar.panellist / settings.section）。【已核实（0.2.0 时代的插件）】
- client bundle 加载：`dsh-client-modules/README.md:12,34,50`。【已核实】

---

## 四个机制 → 扩展点对照（汇总，均为【推断】的设计）

| 机制 | 主扩展点 | 辅助 | 风险/限制 |
|---|---|---|---|
| Action Fusion | `tools/post-execute`（筛 write/edit） | `ctx.shell` + `ctx.sandboxPolicy.resolve()`；Config 配命令表 | 不能改参数；校验输出要自己限长；Windows 只有 pwsh |
| ObservationPack | `tools/post-execute`（内容哈希去重，替换为句柄） + 新工具 `observation_read` | 存档：`$DSH_HOME/<插件>/` + storageDomain | 必须在 spill 之前替换（spill prepend+next 后处理，天然在最后）；事后改写历史无官方支持，且会破坏 KV cache |
| Evidence-Preserving Reducer | `tools/post-execute` + `ctx.llm.stream` | 存档同上；逐字校验失败就 `return next()` 的结果 | 辅助调用 usage 不计入会话；要传 `exec.signal`；延长工具耗时（受 timeout-policy 的 `tools/execute` 包装影响？post-execute 在 execute 之外，【未核实】是否计入工具超时） |
| Online Context Compact | `session/event`(todo/write) 或 `tools/result`(todo_write) 打标记 → `agent/pre-step` 中调 `ctx.compaction.compactIfNeeded/compactRegion` | `ctx.tokenMeter.measure`、`ctx.llm.resolveModelInfo` | `compactRegion` 需在打开的回合内、边界要配对；`compactNow` 需空闲且不会续回合（需 `agent.followup`）；替换 compaction service 的冲突规则【未核实】 |

## 未找到 / 未核实
- Cordis 中同名 service（如 `compaction`、`spillStore`）有两个实现同时挂载时的行为：未核实（建议禁用原行再插入自己的行）。
- post-execute 的耗时是否计入 `dsh-tool-call-timeout-policy` 的超时：未核实（timeout 包的是 `tools/execute` 那一层，post-execute 在其外，推断不计入）。
- 官方的"插件私有会话目录"API：未找到（只有 storageDomain 和 plugin record）。
- 外部插件可用的"往会话日志写自定义事件"API：未找到（`appendPluginRecord` 文档明确禁止外部使用）。
- 面向模型的压缩工具：不存在（compaction README:159）。
