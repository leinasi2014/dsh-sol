# 第 4、5 步接入交付：五个机制全部挂上

日期：2026-10-18。依据：Chief 本轮的 9 条要求、`notes/load-check.md`、`notes/simplicity-audit.md`、`notes/step5-delivery.md`。

测试：**418 条连跑两遍全过**。`index.js` 和 `lib/` 只 import `node:` 内置模块与自己的文件，没有任何 `@deepseek-ai/*`。

---

## 1. OCC 的 `next()` 双调（SolQA 和 Researcher 都复现的那条）

**改法**：把判定整段抽成 `planStep(payload)`，它只算、不碰 `next()`。监听器变成：

```js
return async function occPreStep(payload, next) {
  try {
    const plan = await planStep(payload)
    if (plan !== undefined) await runCompaction({ ...plan, warn, record })
  } catch (error) {
    warn(...)
  }
  return next()          // 唯一一次，在 try 外面
}
```

`runCompaction` 也不再 `return next()`，它只压、只记、只 warn。

**为什么必须在 try 外面**：`await next()` 写在 try 里时，下游监听器抛错会变成 try 内的 rejection，被 catch 接住后再调一次 `next()`；cordis 的 waterfall 每调一次就从队列弹一个（`asar:cordis/lib/index.js:317-325`），第二次会跳过刚抛错的那个、跑后面的，队列空了再跑一次默认 `enter`。结果是这一步本该失败却悄悄继续。

**变异验证**：把 `return await next()` 加回 try 里，`test/occ.test.js`「a downstream listener that throws is called once and the error escapes」变红，`next` 实测被调 2 次。恢复后全绿。

**这里我踩了一个坑**：第一版的这条测试其实没测到。它用的 surface 太小，`selectRange` 先返回 null，`next()` 在 try 里第一次调用就抛了，catch 里的 `next()` 又抛同一条错——但**变异代码根本没被执行到**。把 surface 加到 10 个节点、每节点 9 万 token，才真正走到 `runCompaction` 之后。

## 2. 两条低危

- **`boundary.turn`**：改成用 `payload.turn`（pre-step 的回合号）。`todo/write` 的 data 只有 `todos`，没有 turn，原来那个字段永远是 `undefined`。变异测试：改回 `outcome.boundary.turn`，1 条变红。
- **`sinceLastCompactSteps`**：挪到 `config.enabled` 检查之后再加。变异：挪回去，「the step counter is not advanced while the mechanism is off」变红。

## 3. 删掉 `mountObservation`

`observation.js` 不再有 `mountObservation`。它自己注册一个 post-execute 监听，而插件必须只有一个；留着就是重复注册的隐患。`test/observation.test.js` 改成直接组合 `createObservationHandler` 和 `defineRecallTool`，断言「一个监听 + 一个工具，卸载后都清空」。

## 4. fake-ctx 补 `agent` 融合

`emit` 和 `waterfall` 对 `agent/pre-step` 都按真实运行时的 `fused = (payload) => ({...payload, agent})` 补上 `agent`（`asar:dsh-agent/lib/index.js:242-246`、`:268-271`）。`createFakeCtx` 新增 `agent` 选项和 `services` 选项（`ctx.get` 用）。

## 5. 接 Reducer

- `config.js` 收 `reducer.{enabled, provider, model, timeoutMs}`。`enabled` 默认 false；**`provider` 和 `model` 没有默认值**，不配就一个请求都不发；`timeoutMs` 默认 20000，校验正整数；`provider`/`model` 传空字符串报错（不是当成没配）。
- `index.js` 把 `createReducerHandler` 放在 `composePostExecute` 数组**最前面**，`shells` 传 `config.actionFusion.shells`（Reducer 不新增自己的 shell 列表）。

## 6. 接 OCC

- `config.js` 收 `occ.{enabled, thresholdRatio, dryRun}`。`thresholdRatio` 默认 0.5，校验 `(0, 1]`；`dryRun` 默认 **true**。
- `index.js` 在 `config.occ.enabled` 时 `mountOcc`，挂一个 `session/event`、一个 `session/disposed`、一个 `agent/pre-step`。
- `RESERVED_KEYS` 清空——五个机制全部挂上了。

## 7. 入口测试

`test/index.test.js` 从 30 条加到 30 条（重写了几条），新增：

- 五个全开：`tools/post-execute` 1 个、`agent/pre-step` 1 个、`session/event` 2 个（Meter + OCC）、`session/created` 1 个、`session/disposed` 2 个（Meter + OCC）、3 个工具。
- 每个模块单独开：按 `{post, pre, event, created, disposed, tools}` 逐项断言，五个模块各一条。
- 卸载后五类监听全清、工具全清。
- 五段各写一个拼错的键，都报 `unknown key`，且一个监听都不注册。
- **顺序测试**：用真实 handler 驱动 `composePostExecute`，脚本化模型返回合法回执，断言最终文本是回执、不是占位符——证明 Reducer 在前、ObservationPack 看到回执后放行。

## 8. locale 和 patch

`locale/en.json`、`locale/zh.json` 的描述改成覆盖五个机制、默认全关。`cordis.patch.yml` 补全五段，并写明 Reducer 必须自己填 provider 和 model、OCC 的 `dryRun` 默认 true。

---

## 9. 这轮查出的一个真 bug：回执会被 ObservationPack 覆盖

**e2e 抓出来的。** 60 KB 的失败输出本该变成回执，实际变成了占位符。

根因：`createObservationHandler` 判定时读的是**原始 `result`**，不是 `decision.content`。Reducer 在前把它换成了回执，ObservationPack 却还在看原始的大文本，判定「够大、要替换」，于是把回执换成了占位符——**回执里的证据全丢了**。

修法：判定看 `decision.content`（模型即将看到的那份），没有就用 `result`：

```js
const current = decision.content === undefined ? result : { ...result, content: decision.content }
```

补了 2 条单元测试：「a receipt an earlier step produced is left alone」（回执逐字保留）、「a large replacement by an earlier step is still replaced」（前一步换上的大文本照样要处理）。变异：改回读 `result`，2 条单元测试 + 1 条 e2e 变红。

**顺带修的**：Reducer 的 7 处账本行都缺 `sessionId`，`createRecordSink` 会拒绝写、只 warn，所以 reducer 行一条都落不了盘。新增 `sessionIdOf(exec)`，从 `exec.agent.session.header.id` 取，7 处全部补上。

---

## 10. 我自己犯的错，记下来

这轮我把 `lib/occ.js` 弄坏过两次，都是自己的操作问题：

1. 用 `-replace` 做变异时把输出写进了错误的文件。
2. 用 PowerShell 拼接文件尾部时截断了 `writeLedger`、`runCompaction`、`mountOcc` 三个函数，中间还有一次把文件头复制了两遍。

两次都是靠 `node --check` 和「导出列表里缺哪个」发现的，最后用位置插入修好。**教训**：改文件结构一律用 `edit`/`write` 工具，不要用 shell 字符串替换拼文件；变异测试前先 `Copy-Item` 备份，改完立刻 `node --check`。

## 11. 还剩什么

- **e2e 的 60 KB 用例现在过了**，它依赖的正是第 9 节那个修复。
- SolArch 的 `test/e2e.test.js` 已经能在全量里跑通。
- 未接的只剩一件事：`README.md` 由 Researcher 按最终状态改，`config.js` 的最终形状就是本文第 5、6 节列的那些键。

---

## 12. 最后一处修改：顺序不再是「碰巧成立」（2026-10-18 补）

Chief 在副本上验证了：把 Reducer 和 ObservationPack 对调，测试照样全过。也就是说**没有任何测试在保证「Reducer 先跑」**。

### 12.1 根因

`shouldReduce` 原来只在 `decision.value !== undefined` 时跳过。`decision.content` 被前面换掉时不跳。于是顺序一反：

1. ObservationPack 先把 60 KB 正文换成占位符；
2. Reducer 读的仍是原始 `result`，判定「够大、失败、无密钥」，压出一份回执；
3. 回执把占位符盖掉。

最后文本看着一样，但**多存档了一份原文、多写了一行 observation 账本**，而且没有任何断言能看见。

### 12.2 改法

`shouldReduce` 加一条，和 ObservationPack 的规矩对称：

```js
if (decision.content !== undefined) {
  return { reduce: false, reason: 'an earlier listener already replaced the content' }
}
```

顺序对调后不再是「结果碰巧一样」，而是**根本不会压**：Reducer 看到前面有人换过内容就放行。

### 12.3 测试

**单元（`test/reducer.test.js`，58 条）**
- 「a decision that already replaced the content is left alone」：断言 `reduce === false` 且 reason 逐字对；
- 「an earlier content replacement makes no request」：断言零模型调用、内容原样、零账本行；
- 混进「every refusal has its own reason」那条，一起覆盖。

**e2e（`test/e2e.test.js`，11 条）** 在「60 KB 失败输出变成回执」里补两条：
- 这个 `callId` 在账本里**没有** `observation` 行；
- `objects/` 里**只有一个**存档，且文件名等于原文的 sha256。

### 12.4 变异（全部在副本上做，按新规矩）

| 变异 | 结果 |
|---|---|
| 对调 `index.js` 里两个 `postExecute.push` | e2e 那条**变红**：拿到的是占位符，不是回执 |
| 只去掉新加的那条 `decision.content` 检查 | 3 条单元测试变红 |

对调后不是「断言碰巧过了」，而是行为真的变了——这正是要的。

### 12.5 顺手修的两件测试卫生问题

- `test/e2e.test.js` 原来写死 `C:/fake-home`，多次跑会累积，而且对象数断言依赖跑的顺序。改成每个 bundle 一个 `mkdtemp` 目录，用 `t.after` 清理（模块级 `after` 在 `node --test` 的子进程模式下不可靠）。现在跑完临时目录零残留。
- 清掉了 `C:/fake-home` 和 `/tmp` 里历史遗留的测试目录。

**最终：420 条测试连跑两遍全过，临时目录零残留。**

---

## 13. 真机验证抓出的 bug（2026-10-18 晚，Researcher 在云主机上发现）

阶段 2a 在真机上跑 ObservationPack 时，存档写进去了，但账本没有 `observation` 行、模型看到的还是全文。Researcher 定位到根因，我在本机复现并修掉。

### 13.1 根因：没配 home 时账本写不了

`createRecordSink` 把没解析过的 `config.meter.home` 原样传给 `appendLedgerRecord`。用户不配 `meter.home` 时它是 `undefined`，而 `appendLedgerRecord` 用 `path.join()` 拼路径：

```
TypeError: The "path" argument must be of type string. Received undefined
```

`observation.js` 的 catch 接住它，按「出错就让路」保留原结果。所以**存档写进去了，替换没发生，机制静默不工作**。

对照：存档那边 `createArchiver` 先调 `resolveDshHome`，Meter 自己也先解析（`meter.js:425`），只有账本这条链漏了。

**单测没抓到，是因为每条测试都显式传了 home。** 这正是「假 ctx 要照真实构造写」那条规矩的反面教材：测试比真实配置更宽松，就永远发现不了。

### 13.2 修的四处

| 位置 | 修法 |
|---|---|
| `index.js` `createRecordSink` | 先 `resolveDshHome(home)` 再传下去 |
| `index.js` `mountOcc` 的 `home` | 同样先解析（`occ-dry` / `occ` 两条账本都走这里） |
| `index.js` `defineRecallTool` | 补传 `record`，否则 `observation-recall` 行永远不会出现 |
| `lib/observation.js` `obs_recall` | `record` 改成 `await`（原来 fire-and-forget） |
| `lib/occ.js` `writeLedger` | 改成 async + `await record(entry)`，调用处 `await` |

后两条是补测试时又发现的：账本行原来**没落盘就返回了**，进程结束得早就丢记录。和 observation 那条「账本先于占位符落盘」是同一个道理。

### 13.3 测试

新增 3 条，都不传 `meter.home`，改用 `process.env.DSH_HOME` 指到临时目录：

- 「observationPack replaces a result even with no home configured」——断言替换真的发生、账本有 `observation` 行；
- 「occ records a dry-run line with no home configured」——断言有 `occ-dry` 行；
- 「obs_recall records a recall line, so the readback is auditable」——断言有 `observation-recall` 行。

**变异验证（副本上做）**：

| 变异 | 打红 |
|---|---|
| `createRecordSink` 不解析 home | 2 条 |
| `mountOcc` 的 home 不解析 | 1 条 |
| `defineRecallTool` 不传 record | 1 条 |
| `writeLedger` 不 await | 1 条 |

### 13.4 写测试时踩的坑

`agent/pre-step` 的 payload 是 `{ agent, turn, step, signal }`，`agent.session` 才是会话。我第一版测试把 session 直接当 `agent` 传，`agent.session` 是 undefined，于是每一步都静默跳过、账本零行——看着像代码 bug，其实是测试构造错了。**假 payload 也要照真实形状写。**

**最终：423 条测试连跑两遍全过，临时目录和 `C:/fake-home` 零残留。**

---

## 14. `no-range` 拆成三个 decision（2026-10-18，2a 真机验证后）

2a 跑完以后 SolArch 提、Chief 定：原来三种完全不同的情况都记成 `no-range`，账本读的人分不清「这个模型没救」「服务没拿到」和「这次运气不好」。拆成三个值，**只改字符串，控制流一行没动**。

| 位置 | 原来 | 现在 | 含义 |
|---|---|---|---|
| `lib/occ.js:303-308` | `no-range` | `retain-too-large` | `retainTokens >= occThreshold`，留尾比触发线还大，压了也不省 |
| `lib/occ.js:314` | `no-range` | `no-engine` | 拿不到 compaction 服务 |
| `lib/occ.js:322` | `no-range` | `no-range`（不变） | 有引擎，但选不出一个不断开工具调用的范围 |

同步改了：

- `lib/occ.js:26-42` 的 `DECISIONS` 清单。顺带补了一句注释：`refused` 和 `busy` 不是 `decide` 的出口，是压缩尝试的结果，两个都不写账本、只 warn——原来这个清单看着像「全部出口」，容易误读。
- `test/occ.test.js` 两条：「a positive threshold with an oversized retain budget is skipped」改成断言 `retain-too-large`；「no engine at all is no-engine, not a crash」改名并改成断言 `no-engine`。
- `README.md:102` 把六个不压的原因逐个写清楚，不只列名字。
- `docs/notes/step5-facts.md` 第 10.3 节的取值表，加了 `retain-too-large` 和 `no-engine` 两行，`no-window` 的说明补上「或 `occThreshold <= 0`」，并注了拆分日期和理由。

**变异验证（副本上做）**：

| 变异 | 打红 |
|---|---|
| `retain-too-large` 改回 `no-range` | 1 条 |
| `no-engine` 改回 `no-range` | 2 条 |

**一个自查**：我把 `DECISIONS` 清单和 `decide` 里实际出现的所有 `decision:` 值逐个对了一遍，10 个值全部对得上，没有多也没有漏。

**最终：423 条测试连跑两遍全过，临时目录零残留。**

---

## 15. 2b 真机验证抓出的 Fusion bug：命令没启动却标成 succeeded（2026-10-19）

Researcher 在云主机上装 dsh-ops 跑 2b 时发现的：ops_bash 的沙箱起不来，三条结果全写着 `[then_run:succeeded]`，后面紧跟一行 `[error: bash could not be started …]`。

### 15.1 根因

`ops_bash` 在 spawn 失败时返回的形状是（`dsh-ops/lib/shells.js:1098-1105`）：

```js
{ error: 'bash could not be started …', timedOut, timeoutMs, stdout, stderr }
```

**没有 `exitCode` 字段**。而 `classify` 当时的规则是「`exitCode` 缺省或 0 即成功」，结果把「进程根本没起来」也归成了成功。（当时给这条规则找的依据是「ops_bash 干净退出不带 `exitCode`」——**那条依据是错的**，见第 18 节；规则本身也已在第 18 节收紧为只认 `exitCode === 0`。）

这是**最坏的错法**：模型会以为命令跑过了。

### 15.2 修法

`classify` 加一支，放在 `isError` 之后、`kind` 之前：

```js
if (spawnErrorOf(result) !== undefined) return MARKERS.notRun
```

新增 `spawnErrorOf(result)`：读 `value.error`，**只认非空字符串**。空字符串或 `null` 不算——否则 `exitCode: 0, error: ''` 这种正常结果会被误判成没跑。

`reasonOf` 也改了：`not_run` 时优先用 `value.error`（shell 自己写的消息，带着缺失的可执行文件名和补救办法），`result.error.message` 退到第二。原来只看后者，只能说「工具失败了」。

**为什么 pwsh 不受影响**：它总是给 `exitCode`（哪怕是 `null`），spawn 失败走的是 `isError`。只有 dsh-ops 的 bash 有这个形状。

### 15.3 测试

`test/fusion.test.js` 加两条：

- 「1.12 a shell that never started is not_run, not succeeded」——用真实形状做 fixture，先断言 fixture 里**确实没有** `exitCode`（防止以后有人手滑加上去让测试失去意义），再断言判成 `not_run`、reason 逐字等于 shell 的消息；
- 「1.13 an empty or non-string value.error does not flip the verdict」——`error: null`、`error: ''` 都不能把干净退出变成 `not_run`。

**变异验证（副本上做）**：

| 变异 | 打红 |
|---|---|
| 删掉 `spawnErrorOf` 那一支 | 1 条 |
| `reasonOf` 不用 `value.error` | 1 条 |

### 15.4 顺手改的一处注释

Chief 指出 `DECISIONS` 的注释说「`refused` 不是 `decide` 的出口」，但 `occ.js:295` 其实有一个。核实属实。改成：

- `refused` **是** `decide` 的出口，但调用方在 `:364` 先拦了，所以实际走不到，留着当防御；
- `busy` 才真的不是 `decide` 的出口，它来自 `runCompaction`。

Researcher 的 2b 已经跑完、云主机已释放，所以现在改不会造成哈希冲突。

**最终：426 条（`npm test` 口径）连跑两遍全过，临时目录零残留。**

---

## 16. 同一个洞的第二个入口：进程被信号杀掉（2026-10-19，SolQA 复核后补）

SolQA 复核 15 节时提出一个更根本的观察：同一个函数里两条相反的默认哲学——`value` 缺失判 `failed`，`exitCode` 缺失判 `succeeded`。这次事故就是后者戳的。建议「只认 `exitCode === 0`」。

> **2026-10-19 更正（见第 18 节）**：本节当时拒绝这条建议的理由——「`ops_bash` 干净退出时不带 `exitCode` 键」——**是错的**，我把 schema 的文档注释读成了行为说明。SolQA 后来用四条源码证据推翻它，第 18 节已把 `classify` 改成只认 `exitCode === 0`。下面的正文保留当时的记录，但结论以第 18 节为准。

### 16.1 但 SolQA 的方向是对的，顺着查出了第二个洞

同一个「缺键即成功」的规则还有另一个入口：**进程被信号杀掉**。

`ops_bash` 只在 `outcome.exitCode !== null` 时才放这个键（`:1091`），进程被信号杀掉时 `exitCode` 是 `null`，于是键被省略、只留 `signal`。当前规则会把它判成 `succeeded`——和 spawn 失败一模一样的错法。

### 16.2 修法

`classify` 加一支 `value.signal`：

```js
if (value.signal !== undefined && value.signal !== null) return MARKERS.failed
```

`reasonOf` 也给一句 `killed by signal: SIGTERM`，否则模型只看到 `failed` 不知道是被杀的。

注释里补了总原则：**成功必须被证明**（有退出码，或者所有失败信号都不在），「没有证据」永远不读成成功。

### 16.3 测试

- 「1.14 a process killed by a signal is failed, not succeeded」——fixture 先断言没有 `exitCode`，再断言 `failed`，reason 逐字是 `killed by signal: SIGTERM`；
- 「1.15 a clean exit with no exitCode key stays a success」——**专门钉住「不能只认 `exitCode === 0`」这条**，防止以后有人照 SolQA 的建议改回去。

**变异验证**：删掉 `signal` 那一支，1.14 变红。把条件改成 `=== 0`，1.3 和 1.15 变红。

### 16.4 三种 shell 的 `exitCode` 约定（已核实）

> 下表 ops_bash 一行的「干净退出：省略键」是错的，见第 18 节更正表。

| shell | 干净退出 | 非零退出 | 被信号杀 | 起不来 |
|---|---|---|---|---|
| pwsh / bash（DSH 内置） | `exitCode: 0` | `exitCode: N` | `exitCode: null` + `signal` | `isError: true` |
| ops_bash | **省略键** | `exitCode: N` | **省略键** + `signal` | **省略键** + `error` |

ops_bash 一列的三处「省略键」正是三种必须分开处理的情况——这就是为什么不能只看 `exitCode`。

**最终：428 条（`npm test` 口径）连跑两遍全过，临时目录零残留。**

---

## 17. 对齐 report.md 2.1 的定稿顺序（2026-10-19，Chief 定稿后）

Chief 把规则写进了 `report.md` 2.1（`:78-84`），并指出 `timedOut` 要排在 `error` 之前。我按定稿逐条对了一遍，发现**一处实质差异**：

| 场景 | 我的实现（改前） | Chief 定稿 |
|---|---|---|
| `error` 和 `timedOut` 同时出现 | `not_run` | `failed` |

**为什么两者能同时出现**：`ops_bash` 的 catch 分支把 `timedOut` 一起写进返回（`dsh-ops/lib/shells.js:1098-1105`）。工作区准备阶段超时，就会既 `timedOut: true` 又有 `error`。

按定稿调整成 `kind` → `timedOut` → `error` → `signal` → `exitCode`。改完后用一个对照脚本把 10 种组合逐个和 Chief 的规则比，**全部一致**。

### 17.1 定稿顺序和实现的一处说明

`report.md` 2.1 的第 1 条是 `kind`，我的实现把 `isError` 放在它前面。这不是偏离：`isError: true` 的结果根本没有可用的 `value`，先拦下来才不会去读一个不存在的对象。已在代码注释里写明。

### 17.2 新增测试

- 「1.16 a timeout outranks a spawn error, matching report.md 2.1」——钉住这条顺序，reason 是 `timed out after 5000ms`；
- 「1.17 the full order matches report.md 2.1 case for case」——一张 11 行的表，覆盖 `promoted`、`background`、`timedOut`、`timedOut+error`、`error`、`signal`、`signal+timedOut:false`、`exitCode: 0/1/null`、无 `exitCode` 的全部组合。以后谁调换分支顺序都会立刻红。

### 17.3 变异验证（Chief 要求的两条 + 我加的一条，全部在副本上做）

| 变异 | 打红 |
|---|---|
| 删掉 `spawnErrorOf` 分支（spawn 失败） | 1.12、1.17 |
| 删掉 `signal` 分支（信号杀掉） | 1.14、1.17 |
| 把 `timedOut` 和 `error` 顺序对调 | 1.16、1.17 |

### 17.4 一处没有采纳的建议，说明理由（已被第 18 节推翻）

上一轮 SolQA 建议「只认 `exitCode === 0`」，方向对（统一「缺证据不判成功」），但当时判断**这条具体改法会引入回归**：理由是「`ops_bash` 干净退出时不带 `exitCode` 键」。**这个理由错了**，见第 18 节。

**最终：430 条（`npm test` 口径）连跑两遍全过，临时目录零残留。**

---

## 18. 更正：「干净退出省略 exitCode」是错的，改为只认 `exitCode === 0`（2026-10-19）

SolQA 提了反证，我逐条读了源码，**他说得对，我错了**。我把 `dsh-ops/lib/shells.js:886-895` 那段 schema 文档注释读成了行为说明：它讲的是「**没有事实可报时**省略键，不用 `null`」，推不出「干净退出时省略键」。

### 18.1 四条证据（全部已核实）

| # | 位置 | 事实 |
|---|---|---|
| 1 | `dsh-ops/lib/file/worker.js:69` | `if (outcome.exitCode !== 0) return failure('RESULT_UNKNOWN', …)`。若干净退出是 undefined，file 组件每次成功都会报错，早就不存在了。 |
| 2 | `dsh-ops/lib/ptc/worker.js:85` | `if (exitCode === 0 \|\| exitCode == null) return false`，同样把 0 当正常返回值。 |
| 3 | `dsh-ops/CHANGELOG.md:255` | 「`exitCode`/`signal` are optional properties: an **unknown** exit fact omits the key」——只有未知退出事实才省略，exit 0 是已知的。 |
| 4 | `dsh-ops/lib/shells.js:1091` | `outcome?.exitCode !== undefined && !== null` 才写键。0 能通过，键会写。 |

再往下一层，`exitCode` 本身从哪来：`asar:dsh-subprocess-local/lib/index.js:480-495` 的 `child.once("exit", (exitCode, signal) => …)` 把 node 给的数字原样 resolve；`:829` 的 Windows runner 也是 `exitCode: result.exitCode`。DSH 内置 `pwsh`/`bash` 更直接——`asar:dsh-tool-pwsh/lib/index.js:268-279`、`asar:dsh-tool-bash/lib/index.js:296-307` 的 `canonical*Result` **无条件**写 `exitCode`（schema 里 `exitCode` 是 `required: true`，见 `:550-556`）。

所以真实形状是：

| shell | 干净退出 | 非零退出 | 被信号杀 | 起不来 |
|---|---|---|---|---|
| pwsh / bash（DSH 内置） | `exitCode: 0` | `exitCode: N` | `exitCode: null` + `signal` | `isError: true` |
| ops_bash | **`exitCode: 0`** | `exitCode: N` | 省略键 + `signal` | 省略键 + `error` |

省略键只在异常场景出现。真机 2b 的 g2 场景成功跑 `cat s2/g1.txt`，走的就是 `exitCode: 0`。

### 18.2 改法

```js
if (value.exitCode === 0) return MARKERS.succeeded
```

`exitCode` 缺省不再算成功。`classify` 的总原则现在自洽了：**成功必须由退出码证明**，缺证据一律不判成功。

`signal` 分支保留，但它的作用变了——不再是「防止缺键被读成成功」，而是「信号优先于 0」：`pwsh` 的 schema 要求 `exitCode` 和 `signal` **同时必填**（`asar:dsh-tool-pwsh/lib/index.js:550-562`），所以 `exitCode: 0` + `signal` 同时出现是可能的，被信号杀掉就该算失败。

### 18.3 测试改动

- **1.3** 从「缺键算成功」改成「干净退出带 `exitCode: 0` 算成功」，fixture 补上 `exitCode: 0`；
- **1.15** 从「缺键算成功」**反转成「缺键不算成功」**，钉住这次的规则；
- **1.17** 表里补 `{exitCode: 0, signal: 'SIGKILL'} → failed` 和 `{timedOut: false, signal: null} → failed`；
- **新增 1.14b**「a signal outranks a zero exit code」——这是 `signal` 分支现在唯一还能改变结果的形状，不补这条，删掉分支测试也不会红。

### 18.4 变异验证（全部在 `/tmp` 副本上做，基线 430 条全过）

| 变异 | 打红 |
|---|---|
| 恢复「`exitCode` 缺省算成功」 | 1.15、1.17 |
| 删掉 `signal` 分支 | 1.14b、1.17 |
| 删掉 `spawnErrorOf` 分支 | 1.12、1.14b、1.17 |
| 对调 `timedOut` 和 `error` | 1.16、1.17 |

第一次跑「删 `signal` 分支」时**没红**——收紧之后它确实成了不可观察的冗余分支，正是 1.14b 把这条不变量补回来才抓住。这一条值得记：收紧规则会让某些分支从「可观察」变成「不可观察」，必须补一条只针对该分支的用例。

### 18.5 一处仍然待定

SolQA 建议在云主机上直接调一次 `ops_bash` 跑 `exit 0`，把 `result.value` 原样抓下来，把上面第 4 条从源码推断升级成实测。会话日志只存渲染文本，所以得由 Researcher 在云主机上做。我这一轮的结论标**已核实（源码链）**，等那次实测再确认。

**最终：431 条（`npm test` 口径）连跑两遍全过，临时目录零残留。**

---

## 19. 探针：Fusion 只接受 `classify` 读得懂的 shell（2026-10-19，Chief 定稿后）

### 19.1 问题

persistent 版的 `bash`/`pwsh`（只在 `preset-minimal` 里）返回的 `value` 是**字符串**——它们声明 `schema: { type: "string" }`（`asar:dsh-tool-pwsh-persistent/lib/index.js:350`、`asar:dsh-tool-bash-persistent/lib/index.js:345`）。而 `classify` 把 `result.value` 当对象读（`exitCode`、`signal`、`timedOut`、`kind`），非对象直接 `failed`（`lib/fusion.js:256-260`）。所以选到它，**跑成功的命令也会标成 `failed`**。

现网配置下选不到：persistent 版只出现在 `preset-minimal`（`<web-profile>/cordis.yml:1114-1120`、`:1145-1150`），而同一个 preset 把 `write`/`edit` 都关了（`:1090-1091`），Fusion 的第一次嵌套调用就抛 `unknown tool "edit"`，走不到选 shell 那一步。顶层 `tool-fs` 是 `disabled: true`（`:298`），dsh-ops 注册的是 `ops_*` 前缀、不含 `edit`/`write`（`dsh-ops/lib/policy.js:7`）。所以这是**潜伏 bug**：配置一改就炸。

### 19.2 能不能探测到

Chief 要求先确认 `ctx.tools.get()` 返回的定义里有没有 `output.schema`。**有**，已核实：

| 环节 | 位置 | 事实 |
|---|---|---|
| 注册 | `asar:dsh-tools/lib/index.js:2974-2982` | `register(definition)` 只校验，然后把**同一个对象**交给 `layer.tools.insert(name, definition)`，不包装、不裁剪 |
| 存储 | `asar:dsh-scope/lib/index.js:27-31` | `data.set(name, value)`，存的是引用 |
| 读取 | `asar:dsh-tools/lib/index.js:3091-3093` | `get(name, scope)` = `this.view(scope).visible.get(name)`，`view()` 放进去的也是同一个引用（`:3055-3081`） |

### 19.3 一个差点踩的坑

内置 `pwsh`/`bash` 的 output schema **没有顶层 `type`**，是 `oneOf` 包着多个 `type: "object"`：

- `asar:dsh-tool-pwsh/lib/index.js:503-508`
- `asar:dsh-tool-bash/lib/index.js:530-535`

所以判断不能写成 `schema.type === 'object'`——那会把内置 `pwsh` 和 `bash` 一起误判掉，Fusion 在所有非 minimal preset 上整体失效。Chief 特意提醒了这一点，变异验证也证实了：这个变异打红 **9 条**。

`ops_bash` 是普通对象 schema（`dsh-ops/lib/shells.js:890-891`，`type: 'object'`）。

### 19.4 修法

新增 `readsObjectValue(schema)`：顶层 `type === 'object'` 直接通过；`oneOf`/`anyOf` 要求**每个分支**都是对象；其余一律拒绝。`pickShell` 多一步 `if (!readsObjectValue(definition.output?.schema)) continue`，跳过读不懂的、继续试下一个。

`pickShell` 仍是纯函数、仍返回 `undefined` 表示「一个都不能用」，调用方沿用原来的 `not_run` 分支，只把文案换成 `no shell tool whose result dsh-sol can read is available (tried …)`。控制流没动。

**`classify` 不动**：不加「字符串就算成功」这种猜测，成功还是只认 `exitCode === 0`。

### 19.5 测试

- 三个真实形状常量：`OPS_BASH_DEF`（`type: 'object'`）、`PWSH_DEF` / `BASH_DEF`（`oneOf`）、`PERSISTENT_PWSH_DEF`（`type: 'string'`）。原来测试里的假定义是 `{}`（没有 `output`），已全部改成真实形状——按新规则 `{}` 本来就该被判成读不懂。
- **4.3b**：只有 persistent 版时，标 `not_run`，且那个 shell 一次都没被调用；
- **4.3c**：读不懂的排在前面时，**跳过它用后面的**（这条防的是「一个 preset 改动让 Fusion 整体失效」）；
- **`pickShell accepts every real shell shape…`**：断言 `ops_bash`、`pwsh`、`bash` 三个默认 shell 的真实形状**都能被选中**（Chief 要的那条），persistent 版被拒；
- **`readsObjectValue …`**：对象 / `oneOf` 全对象 / `anyOf` / 字符串 / 混合分支 / 空数组 / 无 `type` / `undefined` / `null` 九种输入。

### 19.6 变异验证（全部在 `/tmp` 副本上做，基线 434 条全过）

| 变异 | 打红 |
|---|---|
| `pickShell` 不看 schema（恢复原样） | 4.3b、4.3c、`pickShell accepts every real shell shape…`（3 条） |
| 只认顶层 `type === 'object'`（不处理 `oneOf`） | 9 条，含 4.2、4.3c、4.4、10.3、10.4、`the configured shell list reaches the fusion tools` |

### 19.7 顺带修的：reducer 的 7 处 `record(...)` 补 `await`

Researcher 在 2c 真机上发现的：`createRecordSink` 返回的是 `async` 函数（`index.js:106`），7 处 `record(...)` 都没 `await`，外面那层 `try/catch` 接不住异步抛出的拒绝。

补完后发现**现有测试抓不到**——第一次跑变异（去掉成功行的 `await`）**全绿**。补了两条时序测试才钉住：

- `the ledger line is written before the decision is returned`（成功行）；
- `a fallback line is durable before the decision is returned too`（`llm-unavailable` 回退行——回退是提前返回的，漏掉 `await` 一样会丢）。

| 变异 | 打红 |
|---|---|
| 去掉成功行的 `await` | `the ledger line is written before…` |
| 去掉 `llm-unavailable` 行的 `await` | `a fallback line is durable…` |

又一条和 18.4 同类的教训：**同步的假实现让异步缺陷不可观察**。原来那条 `record` 测试用的是同步 `throw`，测不出 `await` 缺失；换成 `async` 拒绝 + 延时写入才有效。

Researcher 另建议账本行加 `elapsedMs` 方便 A/B，这属于新增字段，等 Chief 定，本轮没加。

**最终：438 条（`npm test` 口径）连跑两遍全过，临时目录零残留。**

---

## 20. 相邻 user 消息合并（2026-10-19）

> **2026-10-19 已整块删除，本节只作调研记录保留。** 这个机制在 DSH 里不可能生效：`agent/pre-step` 返回的 messages 不是最终结果，`step()` 先按 decision 逐条 append（`:1067-1072`），**最后还补一次**补偿追加（`:1073`：`if (context !== void 0 && !contextAdmitted) this.session.append("user/message", context, …)`），所以合并后相邻 user 的条数不变、内容还重复。它想解决的那条「相邻 user 之间被插一条 assistant `OK`」的真正根因在上游中转的请求转换里硬编码（`converter.rs:1877`，`history.push(Message::Assistant("OK"))`），改 DSH 这一侧打不到。`lib/adjacent.js`、`test/adjacent.test.js` 和配置键都已删除，配置里再写 `adjacentUsers` 会报 `unknown key`。

### 20.1 问题

某类 `anthropic-messages` 中转遇到两条相邻的 user 消息，会在中间自己插一条 assistant「OK」。DSH 的会话日志里没有这条，只有模型看得到，于是模型以为那是自己回的，下一轮就去道歉。

DSH 天然会产生相邻 user：`agent/pre-step` 把 runtime context 作为独立一条消息追加（`asar:dsh-agent-loop/lib/index.js:909-917`），`step()` 再按 decision 逐条 append（`:1067-1072`），末尾那次补偿追加在 `:1073`。

### 20.2 为什么钩子放在 `agent/pre-step`，不在 `llm/stream`

**已核实**，`llm/stream` 改不了请求：

| 约束 | 位置 |
|---|---|
| `next()` 不接受新参数，`args` 在闭包里固定 | `asar:@deepseek-ai/cordis/lib/index.js:317-325` |
| agent loop 在 dispatch 前深冻结信封和每条消息 | `asar:dsh-agent-loop/lib/index.js:1277-1288` |

而 `agent/pre-step` 的 **decision 是被采用的返回值**：`{ ...decision, messages }` 就替换这一步承认的消息（`asar:dsh-agent-loop/lib/index.js:909-928`），这正是 `practices.md:16` 说的改法。

### 20.3 线格式上相邻 user 从哪来

pi-ai 的 anthropic 适配器每条 DSH user 消息各 push 一个 `{role:"user"}`（`asar:@earendil-works/pi-ai/dist/api/anthropic-messages.js:1045-1086`）；`toolResult` 连续段也 push 一个 `role:"user"`（`:1158-1172`）。所以「工具结果后紧跟用户文字」同样会形成相邻 user。

本模块**只合并 `role:"user"`**，tool 消息不参与：把工具结果折进提示词会改变工具语义。

### 20.4 `cache_control` 会不会被移动

**不会。** 已核实 DSH 的消息和内容块里根本没有这个字段（`dsh-llm`、`dsh-agent-loop`、`pi-ai` 全扫），它是适配器在转换时新加的，位置是**最后一条消息的最后一个块**（`anthropic-messages.js:1175-1195`）。

合并前断点是 B 的最后一块，合并后还是 B 的最后一块——因为 B 在两种情况下都是最后的内容。补了测试 `every block keeps every attached field…`，用一个带 `cache_control` 的块断言合并后逐块完全相同、标记不复制到邻居。

### 20.5 实现

`lib/adjacent.js`，62 行有效代码：
- 只合并连续的 `role:"user"`，assistant/tool 中断；
- 内容块按原顺序**按引用**拼接，不克隆不重排，图片块位置不变；
- 首条的 `id`/`source` 保留；
- 没有合并时**返回同一个数组**（按身份判断），保留 loop 的快路径；
- 只在 `agent.options.provider` 命中配置列表时才动，其余原样返回**同一个对象**；
- 返回 `{ ...decision, messages }`，`startsRequestSeries` 不丢；
- 出错让路，保留原 decision。

配置 `adjacentUsers: { enabled: false, providers: [] }`，默认关且**默认不点名任何 provider**（见 20.6）。

### 20.6 默认值必须是空列表

最初默认写成了具体的内网中转名，那是**部署事实，不是协议事实**：这个行为只对「会把相邻 user 当成回合边界」的网关成立。写死名字会给从没要求过的人改请求。所以默认空列表，由用户在自己的配置里填 provider id。`lib/config.js` 的注释和 `cordis.patch.yml` 都写明了。

### 20.7 测试与验证

21 条测试（总数 463）。副本变异：

| 变异 | 打红 |
|---|---|
| 不看 provider | 4 条 |
| 不看 role | 3 条 |
| 不 spread decision | 1 条 |
| 关掉合并 | 3 条 |

**真机一关一开各跑一次**（真实 `anthropic-messages` 中转）：

| 状态 | user 条数 | 复述里出现 assistant「OK」 |
|---|---|---|
| 关闭合并 | 2 | **是**（1. user → 2. assistant: OK → 3. user） |
| 打开合并 | 1 | **否** |

关闭时复现、打开时消失，证明中间件确实在生效路径上，不是「探针绿了但没经过中间件」。

**最终：463 条（`npm test` 口径）连跑两遍全过。**
