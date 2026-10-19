# 第 2 步源码核实：Action Fusion 要用到的形状

日期：2026-10-18。只读核实，没写代码。基准 DSH 0.2.1-rc.2，dsh-ops 0.3.0。

证据记法：`asar:<包>/<文件>:行` 是 app.asar 里的；`dsh-ops:<文件>:行` 是 `<desktop-profile>\node_modules\dsh-ops\` 下的。

**先说四条会影响设计的结论：**

1. **`ops_bash` 是 agent scope 注册的，不是全局**，所以「先探测再用」必须用调用方的 agent 当 scope 去查，用全局 `ctx.tools.get(name)` 会查不到（`dsh-ops:lib/session-shells.js:72`）。
2. **嵌套调用的结果和顶层调用是同一个形状**，因为走的是同一个 `execute()` 出口，只是 `parent` 字段有值。
3. **拒绝和取消都能从结果里分辨**：`error.info.code` 是 `ABORTED` / `ABORTED_BEFORE_DISPATCH`，拒绝没有 code、只有 `message`。
4. **重试不会产生第二条 `assistant/message`**：失败的那次落 `assistant/attempt`。所以 Meter 的 `requests` 只数 `assistant/message`（见第 7 节）。

---

## 1. 嵌套 `ctx.tools.execute` 的结果形状

【已核实】入口是 `ToolRuntime.execute(exec)`，一个参数（`asar:dsh-tools/lib/index.js:3212-3214`）。返回的是已经物化的最终结果，和 `tools/result` 观察者拿到的是同一个对象（同文件 `:3198-3211` 的注释）。

成功：

```
{
  isError: false,
  content: [{ type: 'text', text: '...' }],   // 工具自己 render 出来的，模型看到的就是这个
  value: { ... },                              // 工具声明的结构化输出，已深冻结
  meta?: { ... },                              // 可选，presentationMeta
  additionalContexts?: [...],                  // 可选
  concludesTurn?: true                         // 可选
}
```
证据：`asar:dsh-tools/lib/index.js:3637-3666`（`createSuccessResult`）、`:3686-3705`（`materializeFinalResult`）。

失败：

```
{
  isError: true,
  content: [{ type: 'text', text: 'Error: <message>' }],
  error: { message: '<message>', info?: { name, code } }
}
```
证据：`asar:dsh-tools/lib/index.js:3712-3726`（`toolErrorResult`）、`:2709-2718`（`errorInfo` 只对 `HarnessError` 给出 `{name, code}`）。

**要点：`value` 只在成功时存在。** 失败结果没有 `value`，想读退出码必须先看 `isError`。

### 退出码

- **pwsh**：`value.exitCode`，类型是 `integer | null`（`asar:dsh-tool-pwsh/lib/index.js:550-553`）。`null` 出现在超时/被信号杀掉的情况（同文件 `:426`）。
- **ops_bash**：`value.exitCode`，类型 `integer`，**可选**——干净退出时这个键直接不存在，不是 0（`dsh-ops:lib/shells.js:890-895`，注释在 `:886-888` 说明「没有要报告的就省略键，不用 null」）。

所以判断成功不能写 `exitCode === 0`，也不能写 `?? 0`（那样会把 pwsh 的 `null` 当成 0）。完整判定见下面「结果怎么分」一节。

### 超时

- **pwsh**：`value.timedOut === true`，同时 `value.timeoutMs` 给出实际用的超时值（`asar:dsh-tool-pwsh/lib/index.js:558-570`）。注意 `promoteOnTimeout` 默认 `true`（同文件 `:247`），所以超时后命令**会转成后台 job 继续跑**，此时 `kind: "promoted"`、带 `jobId`，不是 `foreground`（同文件 `:503-536` 的输出 oneOf）。也就是说超时不一定意味着命令停了。
- **ops_bash**：`value.timedOut === true` 加 `value.timeoutMs`（`dsh-ops:lib/shells.js:900-901`）。它**没有后台提升**，超时就是杀掉（`dsh-ops:lib/shells.js:984-986` 的 description 明说）。

Fusion 需要区分这两种：pwsh 超时可能是「还在跑」，ops_bash 超时是「已经没了」。

### 输出截断时的全文路径

两边一致：`value.stdout.spillPath` 和 `value.stderr.spillPath`，**可选**，只在被截断时存在。

- pwsh：`asar:dsh-tool-pwsh/lib/index.js:571-602`（stdout/stderr 都是 `{text, truncated, spillPath?}`）。
- ops_bash：`dsh-ops:lib/shells.js:902-921`，同样的 `{text, truncated, spillPath?}`。

判断被截断看 `value.stdout.truncated === true`，不要靠 `spillPath` 是否存在推断（虽然两者在实践中同步）。

模型看到的文本里已经有提示了：`[output truncated; full output: <spillPath>]`（pwsh `asar:dsh-tool-pwsh/lib/index.js:141-144`，ops_bash `dsh-ops:lib/shells.js:844-847`）。**Fusion 不需要自己再拼一遍**，直接透传 `content` 就行；但结构化字段要留在 `value` 里供渲染用。

---

## 2. `ops_bash` 的参数 schema

【已核实】`dsh-ops:lib/shells.js:964-995`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 否 | 短命令或管道；用 `script_path` 时省略或留空 |
| `description` | string | 否 | 「为兼容宿主 shell 工具而接受」 |
| `script_path` | string | 否 | 已存在的 bash 脚本路径 |
| `workdir` | string | 否 | 默认会话工作目录 |
| `timeoutMs` | number | 否 | 默认 120000（`dsh-ops:lib/shells.js:66`），上限 2147483647（`:69`） |
| `graceMs` | number | 否 | 默认 3000（`:76`） |

**没有任何必填参数。** `command` 和 `script_path` 二选一，两个都给会抛错（`dsh-ops:lib/shells.js:1032-1034`），两个都不给也抛错（`:1027-1031`）。

`additionalProperties: false`（`dsh-ops:lib/shells.js:994`），多传一个键直接报 unknown。

**和 pwsh 的关键差异：`description` 在 ops_bash 里是可选的，在 pwsh 里是必填的**（`asar:dsh-tool-pwsh/lib/index.js:469-473`，`validatePwshArgs` 在 `:251` 强制非空）。Fusion 生成参数时必须按目标工具分别处理，不能一套参数套两个工具。

---

## 3. 怎么用公开 API 查 `ops_bash` 在不在

【已核实】有三个公开方法，都在 `ToolRuntime` 上：

- `ctx.tools.get(name, scope)` —— 返回定义或 `undefined`（`asar:dsh-tools/lib/index.js:3091-3093`）。
- `ctx.tools.schemas(scope)` —— 返回该 scope 可见的 schema 数组，**不带 execute 函数**（同文件 `:3119-3121`）。
- `ctx.tools.resolveExecution(name, scope, nested)` —— 额外应用 PTC 折叠（同文件 `:3107-3112`）。

**关键陷阱（推断，但证据很硬）：`ops_bash` 注册在 agent scope 上，不是全局。**

`dsh-ops` 通过 `entry.ctx.tools.register(definition)` 注册，而 `entry.ctx` 来自 `agent.ctx.plugin(child => child.inject(['tools'], ...))`（`dsh-ops:lib/session-shells.js:87-91`、`:72`）。也就是说定义挂在那个 agent 的层上。

`get(name, scope)` 的实现是 `this.view(scope).visible.get(name)`（`asar:dsh-tools/lib/index.js:3092`），`scope` 省略时是全局视图。**所以 `ctx.tools.get('ops_bash')` 不带 scope 会返回 `undefined`，即使工具真的可用。**

正确做法：在工具体里拿到 `exec.agent`，再 `ctx.tools.get('ops_bash', exec.agent)`。`exec.agent` 在嵌套调用的 `exec` 里一定有（我们自己是被模型调用的，`exec.agent` 由 loop 传入）。

第二条约束：`ops_bash` 只在**有权威会话 + 允许的模式**下发布。`allowed(agent)` 要求 `sandboxPolicy.resolve({session}).mode` 在 `MODES` 里，且是 `danger-full-access` 或者有 `ctx.get('sandbox').confine`（`dsh-ops:lib/session-shells.js:18-25`）。否则这个 agent 看不到它。所以**探测必须在每次调用时做，不能启动时做一次缓存**。

`ctx.tools.schemas(exec.agent)` 也可以用来判断，但 `get` 更直接，而且拿到的是完整定义（`get` 返回的定义上还带 `execute`，`schemas` 返回的不带）。

---

## 4. `edit` 和 `write` 的参数 schema，以及失败形状

【已核实】`asar:dsh-tool-fs/lib/index.js`。

### edit（`:689-713`）

| 参数 | 类型 | 必填 |
|---|---|---|
| `file_path` | string | **是** |
| `old_string` | string | **是** |
| `new_string` | string | **是**（可以是空串，表示删除） |
| `replace_all` | boolean | 否，默认 false |
| `sandbox_permissions` / `justification` | string | 否，只在有沙箱执行器时出现（`:712`） |

输出：`{ path, before, after }`，三个都必填（`:714-733`）。

### write（`:548-563`）

| 参数 | 类型 | 必填 |
|---|---|---|
| `file_path` | string | **是** |
| `content` | string | **是** |
| `sandbox_permissions` / `justification` | string | 否，同上 |

输出：`{ path, operation: "create"|"update", before: string|null, after }`（`:564-588`）。

### 失败形状

两个工具的失败**不是返回错误对象，是抛异常**（`edit` `:759-761`、`write` `:611-613`），由 `tools/execute` 统一捕获成 `{isError:true, content:[...], error:{message}}`（`asar:dsh-tools/lib/index.js:3409-3410`、`:3712-3726`）。

具体原因文本来自 `remediateFsError` / `sandbox.mapError`，常见的有：文件不存在、`old_string` 没匹配上或多处匹配、读前未读（fs-observation-policy）、沙箱拒绝。

**对 Fusion 的意义：改文件那一步失败了，就不要跑 `then_run`。** 判断依据是 `editResult.isError === true`。

---

## 5. pre-execute 拒绝、guard 拒绝、取消，三种情况的结果

【已核实】三种都在 `prepareExecution` 里处理，但出口形状不同。

### pre-execute 拒绝 和 guard 拒绝 —— 同一个形状

```js
{
  isError: true,
  content: [{ type: 'text', text: `Error: ${reason}` }],
  error: { message: reason, info?: <deny 决定里带的 info> }
}
```
证据：`asar:dsh-tools/lib/index.js:3337-3353`。pre-execute 返回 `{kind:'deny', reason}` 时走 `decision.reason`；guard 拒绝时走 `guardReason(exec)` 的返回值。两者合并成同一段代码，**插件分不出来是谁拒的**——这印证了 report.md 3.1 里「用户拒绝和策略拦截合并成一个标记」的判断。

`dsh-ops` 的 `deny-host-shell` 就是这么拒的：`{kind:'deny', reason:'Host tool pwsh is disabled by dsh-ops shellPolicy. ...'}`（`dsh-ops:lib/policy.js:75-78`）。

### 审批被用户拒绝 —— 也是上面那个形状

`serviceAsk` 把审批结果映射成 `deny` 决定（`asar:dsh-tools/lib/index.js:3564-3570`），reason 是 `the user rejected tool "<name>"`。所以结果和 guard 拒绝完全同构，只有 `message` 文本不同。

三种审批失败分别对应：

- 用户点了拒绝：`the user rejected tool "<name>"`
- 审批被取消：`approval for tool "<name>" was cancelled`，且 `approvalCancelled: true`
- 没有审批通道：`tool "<name>" requires approval, but no approval channel is available`

证据：`asar:dsh-tools/lib/index.js:3564-3584`。

### 取消（abort）—— 有 code，能分辨

取消**发生在工具体开始之前**：

```js
{
  isError: true,
  content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
  error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } }
}
```
证据：`asar:dsh-tools/lib/index.js:3791-3808`。

取消**发生在工具体已经跑起来之后**：

```js
{
  isError: true,
  content: [{ type: 'text', text: 'Error: tool call aborted' }],
  error: { message: 'tool call aborted', info: { name: 'AbortError', code: 'ABORTED' } }
}
```
证据：`asar:dsh-tools/lib/index.js:3772-3789`。

常量定义在 `:2625-2627`（`TOOL_ABORTED = "ABORTED"`、`TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH"`），并且从包里导出（`:3810`）。

**所以：`error.info.code` 存在就说明是取消，不存在就是拒绝。** 这比看文本稳。

---

## 对 Fusion 实现的具体影响

1. **探测**：`ctx.tools.get('ops_bash', exec.agent)`，每次调用时查，不缓存。
2. **命令那一步**：有 `ops_bash` 用它，否则用 `pwsh`。两者的参数不同（`description` 一个可选一个必填），要分别构造。
3. **改文件那一步**：`ctx.tools.execute({ name: 'edit'|'write', arguments, parent: exec.token, agent: exec.agent, callId, rootCallId, signal })`，形状照 `asar:dsh-tools/lib/index.js:1368-1377`（PTC 里的嵌套调用示例）。
4. **失败分类**：先看 `isError`；是错误再看 `error.info.code`，有 code 就是取消（`ABORTED*`），没 code 就是拒绝（用户拒绝、策略拦截、审批不可用都在这一类）。按 Chief 的定稿，都归 `[then_run:not_run]` 加原因原文。

### 5. 结果怎么分（2026-10-18 修正，以 report.md 2.1 为准）

**原写法 `value.exitCode ?? 0` 是错的**：`??` 只处理 `null`/`undefined` 两种情况，会把 pwsh 超时/被杀时的 `exitCode: null` 当成 0，把失败报成成功。改成下面这套判定。

先分清两件事：**命令有没有跑起来**，和**跑起来以后成功没有**。

**第一步：`isError` 决定「跑没跑」。**

- `isError === true` → `[then_run:not_run]`，附 `error.message` 原文。这一类包括：pre-execute 拒绝、guard 拒绝、用户审批拒绝、审批通道不可用、取消（`error.info.code` 为 `ABORTED` / `ABORTED_BEFORE_DISPATCH`）、工具不存在（`UNKNOWN_TOOL`）、起不来（spawn 失败）。
- **非 0 退出码不会触发 `isError`**（`asar:dsh-tool-pwsh/lib/index.js:132-136` 的注释明说「Non-zero exits are reported, not errored — the model decides how to react; only infrastructure failures (spawn errors, aborts) surface as isError results」）。所以 `isError === false` 但退出码非 0，是「命令跑了、失败了」，不是「没跑」。

**第二步：`isError === false` 时看 `timedOut` 和 `exitCode`。**

按这个顺序判，先命中先算：

| 条件 | 标记 | 说明 |
|---|---|---|
| `value.timedOut === true` | `[then_run:failed]` | 超时。pwsh 可能已经转后台，见下 |
| `value.exitCode === undefined` 或 `=== 0` | `[then_run:succeeded]` | ops_bash 用「键不存在」表示 0 |
| 其余（非 0 整数、`null`） | `[then_run:failed]` | `null` 只在超时/被杀时出现，已被上一行拦掉 |

写代码时**不要用 `??` 或 `||` 兜底**，要显式判三种情况：

```js
function classify(value) {
  if (value.timedOut === true) return 'failed'
  if (value.exitCode === undefined || value.exitCode === 0) return 'succeeded'
  return 'failed'
}
```

**pwsh 超时转后台**：`promoteOnTimeout` 默认 `true`（`asar:dsh-tool-pwsh/lib/index.js:247`），而且是**部署层配置，单次调用关不掉**（`:245-248` 只有 Config 层面能设，参数里没有）。超时后结果是 `kind: "promoted"`、带 `jobId` 和 `timeoutMs`（`:503-536` 的 oneOf 第二支），此时**没有 `exitCode` 字段**，`timedOut` 也不在那一支里——所以它落到「`timedOut` 不存在」这一路。

处理办法：`kind === "promoted"` 单独认一支，标 `[then_run:failed]`，**把 `jobId` 带上**，并写明命令还在后台跑、可以用 `job_output` 读、`job_kill` 停。这是 Chief 定的口径。

于是完整判定是五支（`background` 那一支是防御性的：Fusion 不传 `run_in_background`，但别让它在别处被误判成成功）：

```js
function classify(value) {
  // 后台句柄：没有退出码，命令还没结束
  if (value.kind === 'promoted') return 'failed'      // 超时转后台，仍在跑
  if (value.kind === 'background') return 'failed'    // 显式后台，仍在跑
  if (value.timedOut === true) return 'failed'        // 超时被杀
  if (value.exitCode === undefined || value.exitCode === 0) return 'succeeded'
  return 'failed'
}
```

三支「不是正常结束」的都带 `jobId`（`promoted` 和 `background` 的 schema 都要求 `jobId` 必填，`asar:dsh-tool-pwsh/lib/index.js:508`、`:523-526`），结果里要原样透出。

ops_bash 没有后台提升（`dsh-ops:lib/shells.js:984-986` 的 description 明说超时就杀），它的输出 schema 里**根本没有 `kind` 字段**（`dsh-ops:lib/shells.js:890-923`），所以 `value.kind` 恒为 `undefined`，前三支对它都不生效。

6. **截断**：`content` 里已经有 `spillPath` 提示，透传即可；结构化字段在 `value.stdout.spillPath`。

### 每种情况要有一条测试

实现 `fusion.js` 时，`classify` 这个纯函数至少覆盖这 8 条：

1. `{kind:'foreground', exitCode:0}` → succeeded
2. `{kind:'foreground', exitCode:1}` → failed（有输出，命令跑了）
3. `{kind:'foreground'}`（ops_bash 干净退出，无 exitCode 键）→ succeeded
4. `{kind:'foreground', timedOut:true, exitCode:null}` → failed
5. `{kind:'promoted', jobId:'job-1', timeoutMs:120000, output:''}` → failed，且结果里带 jobId
6. `{kind:'background', jobId:'job-2', cwd:'C:/x'}` → failed，且结果里带 jobId
7. `{isError:true, error:{message:'...'}}` → not_run，附原因
8. `{isError:true, error:{message:'...', info:{code:'ABORTED_BEFORE_DISPATCH'}}}` → not_run，且能识别为取消

## 还没核实的（留到实现时实测）

- `parent: exec.token` 之外，`callId` 和 `rootCallId` 用新生成的还是复用外层，没有明文规定。PTC 的做法是生成 `<parent>:ptc:<n>` 形式的子 callId（`asar:dsh-tools/lib/index.js:1367`）。Fusion 照这个形状生成即可，但没实测过 registry 会不会校验。
- `signal` 传外层的 `exec.signal` 会让两步共享同一个取消；是否要单独的超时，没核实。
- 嵌套调用会不会额外弹一次审批：推断不会（不带 `sandbox_permissions` 就不走 `ctx.approval`；**准入守卫在 `asar:dsh-tool-pwsh/lib/index.js:631`**（`args.sandbox_permissions !== void 0 && args.justification !== void 0` 才进审批），escalation 本体在 `:334-349`），但要装进 web profile 实测。
- `ops_bash` 在 `workspace-write` 模式下会不会因为 `prepareWorkspace` 的 owner 检查失败（`dsh-ops:lib/workspace-preparation.js`），要看真实 workspace 的 owner。本机 `<source>` 的 owner 不是当前用户，`<repo>` 是。

---

## 6. 补：`actionFusion.shells` 配置项

【已核实（机制）/ 推断（实现）】2026-10-18 追加，Researcher 的建议、Chief 定稿。

- 配置项 `actionFusion.shells`，默认 `["ops_bash", "pwsh", "bash"]`，按顺序用 `ctx.tools.get(name, exec.agent)` 取第一个已注册的。
- **代码里任何其他地方都不写死 `ops_bash`**，只在这个默认数组里出现一次。这样 dsh-sol 不需要知道 dsh-ops 存在。
- 三个都没注册时返回 `[then_run:not_run]` 加原因，不改任何行为。
- 每种 shell 的参数分别构造，因为 schema 不同：
  - `pwsh`：`description` **必填**且非空（`asar:dsh-tool-pwsh/lib/index.js:469-473`、`:251`）；`timeoutMs` 是毫秒，可选；有 `workdir`。
  - `ops_bash`：`description` **可选**（`dsh-ops:lib/shells.js:971-974`）；`command` 和 `script_path` 二选一，都必填不了、也都不能同时给（`dsh-ops:lib/shells.js:1027-1034`）；`timeoutMs` 毫秒，默认 120000（`:66`）；有 `workdir`、`graceMs`。
  - `bash`（宿主，Windows 上通常被禁）：`asar:dsh-base/cordis.patch.yml:281-283` 写明 Windows 下禁用，所以默认数组里它排最后，实际上拿不到。
- 探测必须是**每次调用时**做，不能缓存：`ops_bash` 只在 `allowed(agent)` 成立时才发布（`dsh-ops:lib/session-shells.js:18-25`），会话权限一变它就可能消失（`:108` 监听 `sandbox/mode` 重新 reconcile）。

---

## 7. 补：Meter 的 `requests` 字段怎么数

【已核实】2026-10-18 追加，Chief 批的 A/B 指标。

**问题**：一次请求被重试时，会不会出现多条 `assistant/message`？

**答案：不会。一次尝试只落一条，而且失败的那次落的是 `assistant/attempt`，不是 `assistant/message`。**

证据链：

1. 每个尝试新建一个 `AssistantStreamAttempt`，然后 `live.settle(...)` 只调一次（`asar:dsh-agent-loop/lib/index.js:1079`、`:416-436`）。
2. 成功路径：`settle("assistant/message", () => session.append("assistant/message", ...))`（同文件 `:1156-1162`）。
3. 失败路径：`finish.kind === "error" | "aborted"` 时 `settle("assistant/attempt", ...)`（同文件 `:1130-1135`），然后走 `agent/request-error` waterfall；只有返回 `{kind:"retry"}` 才 `continue` 开下一个尝试（同文件 `:1136-1146`）。
4. 被中断（signal aborted）但已经有内容的，落 `assistant/message` 且带 `interrupted: true`（同文件 `:1098-1112`）；没内容的落 `assistant/attempt`（`:1113-1117`）。
5. `llm-retry` 插件在退避前后各写一条事件：`llm/retry`（`:141`）和 `llm/retry-started`（`:143-148`），都不带 usage。

**所以计数的正确口径：**

- `requests` 只数 `assistant/message`。它正好等于「真正拿到模型回复的尝试数」。
- 失败并重试的尝试只写 `assistant/attempt`，**不进 `requests`**。这和 `tokenUsage` 投影的处理一致——那个投影对 `assistant/attempt` 也取 stream 里的 usage 计入 token（`asar:dsh-token-meter/lib/index.js:369-373`），但它在 `llm/retry-started` 时会把同一 step 的 last 清掉重算（`:402-405`），避免重复计。
- **由此产生一个口径差异，必须在报告里写明**：`requests` 数的是「成功的尝试」，而 `usage` 里可能包含重试烧掉的 token（失败尝试如果报了 usage，投影会算进去，随后被同 step 的 `assistant/message` 替换掉）。也就是说 `usage / requests` 得到的「每请求平均 token」在重试多的时候会偏高。A/B 对比时两组都偏高，方向一致，不影响比较，但不能当成绝对成本。
- 只数 `seq >= inheritedEventCount` 的，和基线规则一致（`asar:dsh-session/lib/index.js:1473-1475` 的 `isOwnSeq` 就是 `seq >= inheritedEventCount && seq < this.seq`）。

**另一个可用的口径**（如果以后要「总尝试数」）：`assistant/message` + `assistant/attempt` 一起数。现在不加，等 A/B 数据出来看重试率再说。

`llm/retry-started` 是已知会话事件类型（`asar:dsh-session/lib/index.js:105`），可以安全地监听它，不需要写新事件。
