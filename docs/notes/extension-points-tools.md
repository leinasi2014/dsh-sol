# DSH 0.2.1-rc.2 工具层扩展点调研笔记

范围：工具注册、包装、结果后处理、bash 长输出，用来判断 SoL-Pi 的三个机制能否做成纯 Cordis 插件。
所有结论都只读源码得出，没有运行验证。

证据路径约定：
- `A:` 表示 `<DSH-install>/resources/app.asar` 里的 `dsh/node_modules/@deepseek-ai/`，内容用 `asar-peek.mjs cat` 读出，行号就是 `lib/index.js` 自身的行号（副本放在 `<home>\.dsh\bot\workspace/<scratch>/tmp\<包名>.js`）。
- `O:` 表示旧版 0.2.0-rc.2 的解开副本 `<reference-runtime>\node_modules\@deepseek-ai\`。
- 0.2.1 的 asar 里没有 `.d.ts`（`lib/types/` 下只有 `.js`）。类型签名引用的是 O: 里的 `dsh-tools/lib/types/index.d.ts`，并和 0.2.1 的 JS 实现逐项对照过。

## 0. 总览

| 扩展点 | 拿法 | 性质 |
|---|---|---|
| `ctx.tools.register(def)` | `inject: ['tools']` | 注册工具，可按作用域遮蔽同名工具 |
| `ctx.tools.restrict({allow,deny})` | 同上，只能在 agent.ctx 上用 | 按作用域隐藏全局或继承来的工具 |
| `ctx.tools.guard(fn)` | 同上 | 只能拒绝的守卫 |
| `ctx.tools.get(name, scope)` / `ctx.tools.execute(input)` | 同上 | 取工具定义、走完整管线执行 |
| 事件 `tools/pre-execute` | `ctx.on(...)`，waterfall | 执行前决定 allow/deny/cancel/ask，不能改参数 |
| 事件 `tools/execute` | `ctx.on(...)`，waterfall | 包住工具体执行（timeout、checkpoint 都挂在这里） |
| 事件 `tools/post-execute` | `ctx.on(...)`，waterfall | 结果进入会话之前改写 content/value、追加上下文、block |
| 事件 `tools/result` | `ctx.on(...)`，emit | 只读观察最终结果 |
| 事件 `tools/ptc-dispatch-log` | waterfall | 只改 run_code 子调用落盘的那份副本 |
| 定义级 `projectContent` / `finalizeContent` | 写在工具定义上 | 只能改自己工具的 content |
| `ctx.sessions.registerMessageProjection` + surface replace | `inject: ['sessions']` | 改“发给模型的派生历史”，不改原始事件（见第 5 节） |

`tools/execute` 不是一个服务，而是 `ToolRuntime` 内部发出的 waterfall 事件。“包装 tools/execute”的意思是 `ctx.on('tools/execute', (exec, next) => ...)`。（已核实，A:dsh-tools.js:3427）

## 1. 注册新工具

### 1.1 API 与拿法
- 服务名 `tools`（`ToolRuntime extends Service`，`super(ctx, "tools")`）。插件里写 `export const inject = ['tools']`，或者 `ctx.inject(['tools'], sub => ...)`。（已核实，A:dsh-tools.js:2760, 2798）
- `register(definition)` 返回 disposer。同一层里重名会抛错；`run_code` 是保留名，也会抛错；`output` 必须是 `{schema, render, presentationMeta?}`；`timeoutMs` 必须是正数。（已核实，A:dsh-tools.js:2974-2983）
- 用户插件实例：team-studio 在 `agent/created` 里对 `agent.ctx.tools.register(defineTool(...))`，同时配合 `restrict`/`guard` 使用。（已核实，`<reference-plugin-src>\src\orchestrator\dsh-port.ts:62-77, 100-117`；`src/index.ts:49`）

### 1.2 schema 声明（推荐用 `defineTool`，从 `@deepseek-ai/dsh-tools` 导出）
```js
import { defineTool } from '@deepseek-ai/dsh-tools'
ctx.tools.register(defineTool({
  name: 'obs_recall',
  description: '...',
  parameters: {                       // 属性表 DSL，不是完整的 JSON Schema
    handle: { type: 'string', required: true, description: '...' },
    offset: { type: 'number' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (args, value) => [{ type: 'text', text: value.text }],   // 模型看到的 content
    presentationMeta: (args, value) => ({ ... }),                    // 可选，UI 回放用
  },
  async execute(args, exec) { return { text: '...' } },             // 只返回 output.schema 规定的值
  isConcurrencySafe: (args) => true,      // 可选
  timeoutMs: 60000,                        // 可选，由 timeout-policy 执行，不会发给模型
  projectContent, finalizeContent, presentCall, presentResult,      // 可选
}))
```
- `defineTool` 会把 parameters 编译成 `{type:'object', properties, required}`，没有 `additionalProperties:false`，所以模型多传的顶层键不会被拒绝。execute 之前会校验，校验失败抛 `ToolArgsError`。（已核实，A:dsh-tools.js:802-811, 838-887；对象节点只有显式写 `additionalProperties:false` 才拒绝额外键，见 :467-468）
- 支持的 schema 关键字只有 type/oneOf/properties/required/additionalProperties/items/enum/const 加注解。（已核实，A:dsh-tools.js:206）

### 1.3 执行签名与返回结构
- `execute(args, exec: ToolRunContext) => Promise<value>`。`exec` 里有 callId、rootCallId、name、arguments（已冻结）、agent、parent、signal、`deferContext(userMessage)`、`concludeTurn()`。（已核实，A:dsh-tools.js:3239-3264；类型见 O:dsh-tools/lib/types/index.d.ts:282-322）
- 返回值不是 content，而是 canonical value。registry 先按 `output.schema` 校验，再调用 `render` 生成 `content`。最终结果的结构是：
  - 成功 `{isError:false, value, content: ContentBlock[], meta?, additionalContexts?, concludesTurn?}`
  - 失败 `{isError:true, error:{message, info?:{name,code,reason?}}, content, meta?, additionalContexts?}`
  - 没有 `details` 字段。UI 侧的私有数据放在 `meta`（来自 presentationMeta），会持久化到 `tool/result`。（已核实，A:dsh-tools.js:3637-3667, 3687-3706；O:index.d.ts:193-205, 412-435）
- 工具体抛异常会被转成 `isError` 结果，content 是 `Error: <msg>`。（已核实，A:dsh-tools.js:3409-3410, 3712-3726）
- `deferContext` 给结果附带一条 UserMessage，在 `tool/result` 之后进入下一步上下文。（已核实，A:dsh-tools.js:3248-3250, 3429-3435）

## 2. 包装/替换内置工具（edit/write/str_replace_editor/bash）

### 2.1 按工具名覆盖：在同一层不行，在更深的作用域可以
- 同一层（全局层或同一 scope）重名注册会抛 `tool "x" is already registered`。（已核实，A:dsh-tools.js:2731）
- 可见性是这样解析的：先取全局层，再按作用域链从远到近覆盖（`inherited.set`），最后自己这一层的注册覆盖所有继承来的。所以在 agent.ctx 注册同名 `edit`，就能遮蔽预设或全局层的 `edit`；schema 投影、lookup、dispatch 用的是同一个解析器。（已核实，A:dsh-tools.js:3055-3081, 3091-3093, 3403）
- 本机 profile 里 tool-fs、tool-bash 在顶层是 `disabled: true`，实际是在 agent preset（如 `preset-standard`）的 plugins 里加载的。（已核实，cordis.yml:286-299, 739-763）因此内置 edit/write 是在 preset 作用域注册的。插件要遮蔽它们，应在 `agent.ctx` 上注册（比如监听 `agent/created`，做法和 team-studio 一样）。另一条路是在 profile 里关掉 preset 的 tool-fs.edit（`config.edit:false`，A:dsh-tool-fs.js:1194-1229），但这要改配置。（推断：preset 作用域在 agent 作用域链上，属于“祖先层”，和 :3040-3051 的注释一致，没有实测）
- 加载顺序：同一层重名靠的是“抛错”，不是“后来者赢”，所以和加载顺序无关；覆盖只看作用域深度。注册或注销会触发 `tools/change`，下一次组装时重新生成 schema。（已核实，A:dsh-tools.js:2783-2785）
- 内置工具名：tool-fs 注册 `read`/`write`/`edit`/`read_image`（A:dsh-tool-fs.js:251, 549, 690, 986）；`str_replace_editor`（A:dsh-tool-str-replace-editor.js:267，inject `['tools','fs']`）；`bash`（A:dsh-tool-bash.js:493）。

### 2.2 拿到原工具并在内部调用
- `ctx.tools.get('edit', exec.agent)` 返回当前作用域可见的定义（包括 `execute`、`parameters`、`output`）。包装工具可以用它的 parameters 再加上 `then_run`，组成新 schema；执行时直接 `await orig.execute(argsWithoutThenRun, exec)`，拿到原 value 后再 `orig.output.render(...)`。（推断：API 已核实，A:dsh-tools.js:3091；“复用原 execute”这种用法没有官方示例。注意要在注册自己之前取原定义，或者用 `ctx.tools.get(name, parentScope)` 取，否则会拿到自己）
- 在工具内部调用 bash：`await ctx.tools.execute({ callId: \`${exec.callId}:then_run\`, rootCallId: exec.rootCallId, name: 'bash', arguments: { command, description, timeoutMs }, agent: exec.agent, parent: exec.token, signal: exec.signal })`。这样会走 bash 的完整管线：pre-execute 审批/沙箱、timeout、spill。设置了 `parent` 之后，checkpoint-policy 和 spill-policy（不含图片时）都会跳过这个嵌套调用。（已核实：`execute` 的入参见 O:index.d.ts:216-242，A:dsh-tools.js:3212；parent 跳过逻辑见 A:dsh-session-checkpoint-policy.js:67、A:dsh-spill-policy.js:242）（推断：嵌套调用会触发 `tools/result`，但不会单独生成 `tool/result` 会话事件，只有外层结果进入历史。PTC 的 run_code 就是这么做的，A:dsh-tools.js:1181 起）
- 另一个办法是直接用 `ctx.shell.execute(ctx.shell.resolve({...}))`，和 tool-bash 内部一样（A:dsh-tool-bash.js:700-704）。不过这样要自己处理沙箱策略（`ctx.sandboxPolicy.resolve`）、shellEnv 和工作目录，不如嵌套 `tools.execute` 省事。（已核实代码路径）

### 2.3 waterfall 包装（不换 schema）
- `tools/execute` 的签名是 `(exec, next) => Promise<ToolExecutionResult>`。wrapper 只能替换 `exec.signal`，不能改参数；`next()` 不接收参数（cordis 的 waterfall 共用同一个 args 数组）。（已核实，O:index.d.ts:48-58；A:cordis.js:317-325）
- 实例：timeout-policy（A:dsh-tool-call-timeout-policy.js:116）、session-checkpoint-policy（A:dsh-session-checkpoint-policy.js:66-71：顶层调用先 `sessions.flush` 再 `next()`）。
- `tools/pre-execute` 只能返回 allow/deny/cancel/ask，明确不支持改写参数（“Input rewriting is excluded”）。（已核实，O:index.d.ts:437-460；A:dsh-tools.js:3321）
- 结论：如果只想在 edit 成功后顺带跑一个命令，又不加参数，可以用 `tools/execute` 或 `tools/post-execute` 包装。如果要让模型能传 `then_run`，就必须改工具 schema，也就是必须在 agent 作用域重新注册同名工具。（已核实，原因见上）

## 3. 工具结果后处理

### 3.1 `tools/post-execute`（主扩展点）
- 签名 `(exec, result, next) => Promise<PostToolDecision>`。可以返回：
  - `{kind:'accept', content?}`：替换模型可见的 content，value 不变；
  - `{kind:'accept', value}`：重新按 output.schema 校验并 render（失败结果不能这样做）；
  - `{kind:'block', feedback}`：把结果改成 isError；
  - 以上三种都可以带 `additionalContexts`。（已核实，A:dsh-tools.js:3599-3628；O:index.d.ts:465-479）
- 管线顺序：pre-execute → guard → `tools/execute`（包住工具体）→ 定义级 `projectContent` → `tools/post-execute` → 定义级 `finalizeContent` → materialize → `tools/result` emit。（已核实，A:dsh-tools.js:3310-3370, 3423-3446, 3455-3469, 3478-3493）
- 替换后的 content 就是写进 `tool/result` 事件、进入会话历史的那份，原文不会保留在日志里。（推断：notifyResult 和 agent-loop 记录的都是 finalResult，A:dsh-tools.js:3491-3492；没有逐行追 agent-loop 的落盘代码）
- 排序：`ctx.on(..., {prepend:true})` 放到队首（最外层）。最外层的 listener 先 `await next()` 再改结果，所以它是“最后一个改结果的”。spill-policy 就是这样做的。（已核实，A:cordis.js:336；A:dsh-spill-policy.js:237-255）

### 3.2 dsh-spill-policy（大结果截断并落盘）
- `inject: ['tools']`，配置 `maxInlineTokens`（本机设为 12500，cordis.yml:430-433）。不配就不生效。（已核实，A:dsh-spill-policy.js:124-145）
- 挂在 `tools/post-execute`（prepend）上：只处理 `accept` 且没有替换 value 的结果，跳过 `read` 工具，跳过不含图片的嵌套调用。按 token 估算（图片按模型定价）超过上限时：调用 `ctx.spillStore.saveText({owner:{sessionId}, source:{kind:'tool',toolName,callId,label}, suggestedName:`${toolName}.txt`, content: fullText})`，然后把 content 换成“头 + `\n\n[...]\n\n` + 尾 + 提示”。（已核实，A:dsh-spill-policy.js:179-255）
- 提示格式：`(Omitted N bytes.[ Omitted K images.] Full formatted result stored at: <locator>. Use read with offset/limit, or grep this path to search within it.)`（describeOmitted 的具体措辞来自 dsh-output-retention:261）。（已核实，A:dsh-spill-policy.js:7-27；A:dsh-spill-local.js:566）
- 落盘失败只记 warn，保留原 content（best-effort）。另外它在 `tools/ptc-dispatch-log` 上做同样的处理。（已核实，:232-235, 256-259）

### 3.3 dsh-spill / dsh-spill-local（存储）
- `dsh-spill` 是抽象 `SpillStore` 服务，服务名 `spillStore`，只定义了 `saveText`，没有读取或检索 API。（已核实，A:dsh-spill.js:20-55）
- `dsh-spill-local`：根目录取 `config.root`，没配就是 `mkdtemp(os.tmpdir()/dsh-spill-XXXXXX)`（每个进程一个）。文件路径 `<root>/session-<sha256(sessionId)前12位>/<12位随机hex>-<encodeSegment(suggestedName)>`，权限 0600，用 `wx` 方式写。启动时清理超过 `cleanupPeriodDays`（默认 30）的旧文件。locator 就是绝对路径。（已核实，A:dsh-spill-local.js:17-37, 70-104, 481-568）
- 自家插件可以直接用 `ctx.get('spillStore').saveText(...)` 存原文，拿 locator 当句柄。（已核实 API；推断：服务没有 read，回读要靠 `read`/`grep` 工具或者自己读文件）

### 3.4 dsh-output-retention
- 一个纯函数库，没有插件和 apply：`TextRetainer`、`ItemRetainer`、`describeOmitted`、`formatRetentionNotice`、`truncateWithoutSplittingSurrogatePair`。spill-policy 用它拼提示文本。（已核实，A:dsh-output-retention.js:301）

### 3.5 dsh-repeat-tool-reminder
- 挂在 `tools/post-execute` 上（不是 prepend），只追加 `additionalContexts`（source `{kind:'repeat-tool-reminder', form:'notice'}`），不改 content。同一工具、同样参数连续出现 3/5/8 次时触发提醒；用户新消息到来时（`agent/pre-step` 发现 user 消息）计数重置。（已核实，A:dsh-repeat-tool-reminder.js:2116-2265；本机配置见 cordis.yml:453-460）
- 这是“追加上下文”的官方范例：`createUserMessage({content, source:{kind:'<插件自定义>', ...}})`，注释里说明 source 标签不能省（A:dsh-repeat-tool-reminder.js:2128-2132）。

### 3.6 hook 协议（dsh-hook-protocol / dsh-hooks-claude-code / dsh-hooks-codex）
- **0.2.1-rc.2 的 asar 里没有这三个包**，`ls` 返回 NOT FOUND，本机 cordis.yml 里也没有 hook 条目。（已核实）
- 0.2.0-rc.2 里有。PostToolUse 也挂在 `tools/post-execute` 上，但只能做两件事：`deny` 变成 block（content 换成 reason 文本），或者追加 `additionalContext`。它**不能**用钩子输出替换原结果 content（没有 updatedOutput 之类的字段）。（已核实，O:dsh-hooks-claude-code/lib/index.js:265-291；O:dsh-hook-protocol/lib/index.js:153-154, 254-277）
- 结论：不要依赖 hook 协议，直接写 Cordis 插件挂 `tools/post-execute`。

### 3.7 dsh-compaction-tool-result-pruner（已有的“历史里替换工具结果”）
- 服务 `toolResultPruner`。`pruneSession(session)` 遍历 surface 上的 `tool/result`：超过 `thresholdChars` 的保留头和尾，中间换成 `[... tool result middle pruned ...]`。做法是先追加一条 `compaction/prune`，再追加一条新的 `tool/result`，带 `surfaceOp:{op:'replace',startSeq,endSeq}` 和 `sourceEventSeqs:[seq]`。原事件仍留在 append-only 日志里，只是在 surface 上被遮蔽。本机 profile 里它是 disabled。（已核实，A:dsh-compaction-tool-result-pruner.js:63-71, 140-190；cordis.yml:436-442）

## 4. bash 工具长输出与完整日志

- 是的，bash 会把完整流写到文件。`dsh-bash-local` 给 stdout/stderr 配了“尾部保留 + spill”：内存里保留 `maxOutputBytes`（默认 64000 字节，也就是 64e3），全量写入 spill 文件，单流上限 `maxSpillBytes`（默认 64 MiB，超过就丢弃 spill 文件）。（已核实，A:dsh-bash-local.js:30-31, 73-74, 107-118）
- spill 文件：`<os.tmpdir()>/dsh-subprocess-XXXXXX/dsh-subprocess-<pid>-<n>-<hex>-<stdout|stderr>.log`，权限 0600，进程退出时不会删除已完成的 spill 文件。（已核实，A:dsh-subprocess-local/lib/output.js:14-22, 141-163）
- 字段名是 `spillPath`，不是 `fullOutputPath`/`details`。bash 的 canonical value 结构为 `{kind:'foreground', cwd, exitCode, signal, timedOut, aborted, timeoutMs, stdout:{text, truncated, spillPath?}, stderr:{...}, sandbox?, stopped?}`。另外还有 `kind:'background'|'promoted'` 两种。（已核实，A:dsh-tool-bash.js:295-317, 530-648）
- 模型看到的文本：被截断的流会加上 `\n[output truncated; full output: <spillPath>]`，非零退出码加 `[exit code: N]`。（已核实，A:dsh-tool-bash.js:135-171）
- 在 `tools/post-execute` 里，`result.value.stdout.spillPath` 可以直接拿到（value 只存在于执行期间，不会写进持久事件，O:index.d.ts:415）。（已核实）
- 和 0.2.0 相比：0.2.1 的 bash 多了 `workingDirectory` 注入、value 里的 `cwd`、job 的 `toolCall`；description 里加了“先给 description”。spillPath 机制没有变化。（已核实，diff O:dsh-tool-bash vs A:）

## 5. context 投影钩子（ObservationPack 相关）

- 发给模型的 messages 来自 `session.deriveMessages()`，也就是 surface 节点经过已注册 message projection 之后的派生结果，原始事件不变。（已核实，A:dsh-agent-loop.js:1274-1287；A:dsh-session.js:1655-1696）
- 插件可以自定义事件类型和投影：`ctx.sessions.registerMessageProjection({type, project(event, ...)})`，同一个 type 只能注册一次；如果会话日志里有该类型事件而插件没有加载，派生会直接报错。（已核实，A:dsh-session.js:1719-1736, 425-440, 583-584）这一点会影响可迁移性：会话离不开这个插件。
- surface replace（第 3.7 节 pruner 的做法）可以“在模型视图里替换某条 tool/result，同时日志里保留原文”。（已核实）
- `llm/stream` waterfall（A:dsh-llm.js:2397）能看到 `options.messages`，但这些消息已经深冻结，而且 `next()` 不接收新 options，所以不能就地改写发出的消息。（已核实，A:dsh-agent-loop.js:1276-1280；A:cordis.js:317-325）（推断：理论上 listener 可以不调 next，改为调用 `ctx.llm.stream({...options, messages: 改写后})` 并加防重入。这是侵入式的，没有官方先例，不推荐）
- `agent/pre-step` waterfall 只能决定这一步要进入的新消息（claimed + runtime context），不能改历史。（已核实，A:dsh-agent-loop.js:909-920）
- 没找到“只改单次请求投影、不落日志”的官方钩子。（已核实：在 agent-loop、session、llm 里检索 waterfall 只找到 agent/pre-step、agent/request（只改 config）、agent/request-error、llm/stream）

## 6. 0.2.0-rc.2 与 0.2.1-rc.2 的差异（只列和本题相关的）
- hook 三件套（dsh-hook-protocol、dsh-hooks-claude-code、dsh-hooks-codex）在 0.2.1 里**被移除**。（已核实）
- `tools` 的 `mode` 取值从 `native|ptc|both` 变成 `native|ptc`。（已核实，A:dsh-tools.js:2763；O:dsh-tools/lib/index.js:2669）
- spill-policy、spill-local、session-checkpoint-policy、tool-result-pruner 的 `lib/index.js` 和旧版逐字一致（diff 为 0）。repeat-tool-reminder 有约 750 行差异，没有细看，入口语义一致。dsh-tools 有约 670 行差异，主要在 PTC 部分；register/post-execute 的语义没有变化。（已核实 diff 计数；后半句部分是推断）
- 0.2.1 的 asar 不带 `.d.ts`，写 TS 插件时要参考 0.2.0 的类型或者自己声明。（已核实）

## 7. 三个 SoL-Pi 机制能否在 DSH 工具层纯插件实现

### 7.1 Action Fusion（edit/write 加 `then_run:{command,timeout}`）
- **可以纯插件实现，但必须在 agent 作用域重新注册同名工具**。做法：在 `agent/created` 时对 `agent.ctx` 执行以下步骤：
  1. 取得原 `edit`/`write` 定义（在注册自己之前调用 `tools.get`）；
  2. 注册同名的新定义，parameters 是原参数加 `then_run`，output.schema 是原 value 和 run 结果的组合；
  3. execute 里先调用原 execute，成功后用 `ctx.tools.execute({name:'bash', parent: exec.token, ...})` 跑命令（审批、沙箱、timeout、spill 都照常生效），然后合并 render。（API 都已核实，组合方式是推断）
- 限制：
  - pre-execute 不能改参数，waterfall 也不能改 schema，所以“只加 waterfall 不重注册”的方案行不通。（已核实）
  - 同一层重名会抛错，不能在全局层覆盖 preset 的工具；
  - Windows 上 preset 只加载 pwsh，`tool-bash` 在 win32 上是 disabled（cordis.yml:755-757），内部调用要按平台选 `bash`/`pwsh`。（已核实配置）
  - UI 卡片（presentCall/presentResult）要自己处理，或者复用原定义的 presentCall。
- 原生重叠：**没有**任何“写后执行”的融合能力。fs-observation-policy 只做“写前必须先读”的门禁（A:dsh-fs-observation-policy.js:90-92）。

### 7.2 ObservationPack（大结果换句柄，加回读工具，只改投影不改历史）
- “换句柄”加回读：**原生基本已有**。spill-policy 在 post-execute 把超过 12500 token 的结果换成头尾预览加绝对路径；回读用现有的 `read` 工具（offset/limit）或 `grep`；bash 另外还有 `spillPath`。自定义 `obs_recall` 只需要注册一个新工具读 locator 文件（或者自己实现 SpillStore 再加 recall）。（已核实）
- “只改发给模型的投影，不改历史”：**DSH 原生做不到**。post-execute 改的是写进 `tool/result` 的那份，原文只存在于 spill 文件中，所以日志里只有替换后的内容。（推断，见 3.1）要保留原文，有两条路：
  - (a) 让 post-execute 保留原 content，事后再用 surface replace 追加一条替换后的 `tool/result`（pruner 模式，原事件留在 append-only 日志里，模型只看到替换版）。这已经是“日志保留原文、投影换句柄”，但替换本身也是一条持久事件；
  - (b) 自定义事件类型并配 `registerMessageProjection`，代价是会话和插件强绑定。
- 纯“请求时临时投影、不落盘”的钩子：没找到（见第 5 节）。

### 7.3 Evidence-Preserving Reducer（tool_result 后处理，替换为回执）
- **可以纯插件实现**：`ctx.on('tools/post-execute', async (exec, result, next) => { const d = await next(); if (d.kind!=='accept' || 'value' in d) return d; 先 spillStore.saveText 存原文；return {kind:'accept', content:[回执]} }, {prepend:true})`。这和 spill-policy 的结构完全一样。（已核实模式）
- 注意顺序：spill-policy 也用 prepend，后注册的 prepend 在更外层。要想“最后改结果”，自己的插件要在 spill-policy 之后加载；也可以先判断 content 里是否已经是 spill 提示。（推断，基于 A:cordis.js:336 的 unshift 语义）
- 想“完整证据留在日志里、上下文里只放回执”，用 7.2 的 (a)：surface replace（pruner 模式），在之后某个时机（比如 `agent/pre-step`）追加替换事件。（推断，pruner 是被 compaction 驱动的，插件自己在 pre-step 里 append 替换事件是否合规，还没有核实）
- 原生重叠：spill-policy（落盘加预览，是“截断”而不是“回执”）、tool-result-pruner（头尾修剪，默认关闭，而且不落盘）、compaction 系列。语义上的“回执/摘要”需要自己做。

### 7.4 小结
| 机制 | 纯插件 | 关键扩展点 | 原生重叠 |
|---|---|---|---|
| Action Fusion | 能（要在 agent 作用域重新注册同名工具） | `tools.get` + `tools.register` + 嵌套 `tools.execute` | 无 |
| ObservationPack | 句柄和回读能做；“只改投影”只能用 surface replace 近似 | post-execute + spillStore + 新工具；`registerMessageProjection` | spill-policy + read/grep 已覆盖约七成 |
| Evidence Reducer | 能 | `tools/post-execute`（prepend） + spillStore | spill-policy（截断而非回执）、pruner |
