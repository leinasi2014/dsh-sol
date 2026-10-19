# 第 5 步源码核实：Online Context Compact（OCC）

日期：2026-10-18。只读核实，没有运行任何代码，没改任何文件。
范围：`report.md` 2.4 的 OCC，只管非 Bot 会话，v1 不覆写 `summarize()`。
标注：**已核实**＝读过源码原文并附 文件:行；**推断**＝从代码结构或文档推出来、没实际运行过。

---

## 0. 先给结论（给 Chief 的短版）

1. **Bot 会话可以零成本识别，不用碰 ds-bot 的私有数据。** 被拒时是一个普通 `Error`，`message` 是固定英文句子，没有 `code`、没有自定义类（`ds-bot/src/host/parts.js:186-187`）。捕获一次就记住，之后这个会话不再试。**这是唯一稳的办法**：`session.header.agentPreset` 是公开的，但 Bot 会话和普通会话都用 `standard`（`ds-bot/src/host/roster.js:37-42`），区分不出来【已核实】。
2. **拿 compaction 服务必须走 `agentPresets.serviceFor(agent, 'compaction')`，再回退 `ctx.get('compaction')`**，照 ds-bot 自己的写法（`ds-bot/src/host/parts.js:194`）。原因：本机 desktop 的每个 preset 里 `compaction` 都是 `isolate: {compaction: true}` 的独立 group（`<desktop-profile>/cordis.yml:840-855`），根级那一行是 `disabled: true`（`:382-384`），根 ctx 上取不到。
3. **`compactRegion` 的 start/end 必须落在 surface 上且工具配对平衡**，否则直接抛错（`asar:dsh-compaction-basic/lib/index.js:549-566`）。OCC 不能自己拍一个范围，必须自己实现一份 `selectCompactableRange` 的等价逻辑（那个函数没导出）。
4. **抢锁会抛 `ManualCompactionError('busy')`**（`:536-539`）。让路方式：catch 到 `code === 'busy'` 就 `return next()`，不重试、不记错误。
5. **最小可用版本能砍到约 250–320 行（含测试）**，比 `report.md` 估的 3–5 天小很多。第 8 节列了具体能砍什么。

---

## 1. 不读 ds-bot 私有数据，怎么判断 Bot 会话

### 1.1 被拒时的确切形状，已核实

`ds-bot/src/host/parts.js:186-187`：

```js
const refuseCompaction = () => Promise.reject(new Error(
  'A Bot conversation makes room on its own, and read_own_chat searches all of it.'))
```

- 类型：**原生 `Error`**，不是自定义类，没有 `code`、没有 `name` 覆写、没有额外字段。
- 挂在哪：`engine.compactNow`（`:215-218`）和 `engine.compactRegion`（`:219-222`）在 `ownedByBot(target)` 为真时返回这个 rejection。
- `compactIfNeeded` **不拒**，直接 `Promise.resolve(null)`（`:211-214`）——静默返回 null，看不出是被拒还是没范围可压。所以**只用 `compactRegion` 就能识别**，不需要额外探测。
- `ownedByBot` 的定义（`:192`）：`isBotTarget(target) && !condensing.has(target.session.id)`，`isBotTarget` 用 `rt.selfOf(id) !== undefined || rt.roomOf(id) !== undefined`（`:188-191`）——都是 ds-bot 自己的运行时表，**我们读不到，也不该读**。

### 1.2 为什么不能用 header 判断，已核实

- `session.header.agentPreset` 是公开字段（`asar:dsh-session/lib/index.js:1055` 校验 `agentPreset` 必须是 string，`:1827` 是写入处）。
- 但 ds-bot 创建 Bot 会话时给的就是 `{ agentPreset: 'standard' }`（`ds-bot/src/host/roster.js:37-42`），和用户自己开的普通会话**一样**。
- 结论：header 上没有可区分 Bot 会话的字段。**唯一可靠的信号就是"被拒一次"**。

### 1.3 建议做法，推断（基于已核实的错误形状）

```
每个 sessionId 一个三态标记：unknown | allowed | refused
第一次想在某个会话压缩时：unknown → 试着调 compactRegion
  catch 到 message 完全等于那句英文 → refused，这个会话永不再试
  其它错误 → 保持 unknown（可能只是这一回合不巧），下次再试
  成功 → allowed
```

注意两点：

- **按 message 全文匹配，不要按类型或 code 匹配**，因为它没有 code。字符串是英文常量，ds-bot 改版本时可能变；变了我们的判断会退化成"每次都试一次然后失败"，代价是多一次被拒的调用，不会出错。这是可接受的降级。
- **不要在 `agent/created` 时主动探测**（故意调一次压缩试）。那样会给每个普通会话都压一次，代价太大。只在真的想压的时候顺带学习。

---

## 2. `agent/pre-step` 的签名，以及 compaction 服务从哪拿

### 2.1 `agent/pre-step`，已核实

- 派发点：`asar:dsh-agent-loop/lib/index.js:909-928`，payload 是 `{ messages: claimed, turn, step, signal }`，返回 `{kind:'enter'|'reject', ...}`。
- **payload 里会额外加上 `agent`**：`agentEvents` 的 `fused = (payload) => ({...payload, agent})`（`asar:dsh-agent/lib/index.js:243-246`），waterfall 走 `:268-271`，carrier 由 `:230-232` 的 `agentCarrier` 建。
- 所以根级插件写 `ctx.on('agent/pre-step', async ({ agent, signal }, next) => …)` 就能拿到 `agent`。范本：`asar:dsh-plan-mode/lib/index.js:151-153` 就是这么写的，而且 plan-mode 是**根级**服务（`static inject = ['tools','systemPrompt','sessionProjections']`，`:134-138`），证明根级能收到 agent 事件。
- **根级监听器收得到 agent 作用域的事件**：`scopeTarget` 的 filter 对未打 scope 标签的 listener 一律放行（`asar:dsh-scope/lib/index.js:328-334`，"admits untagged listeners globally"）。

### 2.2 compaction 从哪拿，已核实

- ds-bot 的写法（`ds-bot/src/host/parts.js:194`）：
  ```js
  const engineOf = agent => [ctx.get('agentPresets')?.serviceFor(agent, 'compaction'), ctx.get('compaction')]
    .find(engine => typeof engine?.[ORIGINAL_COMPACT]?.summarize === 'function')
  ```
  它还要 `summarize` 存在，因为它要覆写；我们 v1 不覆写，条件可以放宽到 `typeof engine?.compactRegion === 'function'`。
- `serviceFor` 的实现：`asar:dsh-agent-preset-registry/lib/index.js:725-728`，`generationFor(agent.ctx)` 取到该 agent 所属的 preset 挂载点，再 `serviceForMount` 在**那个 mount 的 fiber 子树里**找同名服务（`:136-145`）。
- 为什么要这样：本机 desktop 的每个 preset 里有 `- id: compaction / name: cordis:group / isolate: {compaction: true, toolResultPruner: true}`（`<desktop-profile>/cordis.yml:840-845`），里面才是 `compaction-basic`（`:847-848`）。根级 `compaction-basic` 是 `disabled: true`（`:382-384`）。
- 结论：**先 `agentPresets.serviceFor(agent,'compaction')`，回退 `ctx.get('compaction')`**。回退是为了在 preset 没有隔离的 profile 里也能工作（比如干净 web profile，那里 compaction-basic 在根上）。两条都不存在 → 这个会话跳过，不报错。

### 2.3 一个必须注意的坑：ds-bot 的包装是**原地改方法**，已核实

ds-bot 的 `adoptEngine`（`ds-bot/src/host/parts.js:201-230`）拿到 engine 后**直接改写 `engine.compactRegion` 等方法的属性**，把原方法存在 `engine[ORIGINAL_COMPACT]` 上，并在卸载时还原（`:231-240`）。

后果：
- 我们拿到的 engine 可能已经被 ds-bot 包过。这不是坏事——正是它负责在 Bot 会话上拒绝我们。
- 但**不能缓存 engine 引用后就假设它永远是原版**。`agent/created` 时 adopt（`:241`），我们如果更早拿到，拿到的可能是未包装版，那样对 Bot 会话的拒绝就不会发生。**所以每次要压缩时都重新取一次 engine**，不缓存。
- 我们**绝不改 engine 的任何方法**（不包 `compactRegion`、不覆写 `summarize`）。这是"不抢位置"规则。ds-bot 自己就是这么做的，两边都改就会互相覆盖 `ORIGINAL_COMPACT`。

---

## 3. `compactRegion` 的 start/end 怎么算

### 3.1 签名，已核实

`asar:dsh-compaction-basic/lib/index.js:971-976`：

```js
async compactRegion(start, end, agent, signal) {
  return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent,
    { owner: "current-turn", stability: "whole-surface" }, signal)
}
```

- `start`、`end` 都是**surface 节点的 seq，闭区间**。
- 返回（成功时，`:662-676`）：`{ compactionId, startSeq, summarySeq, shadowedRange: {start,end}, shadowedSeqs, shadowedTokenCount, ...endSeq }`。
- **`owner: "current-turn"` 意味着必须有打开的回合**：`:460` 抛 `compactRegion: no open turn — automatic compaction events must be enclosed in a turn`。在 `agent/pre-step` 里调用时回合一定开着，没问题。
- **`stability: "whole-surface"` 意味着整个 surface 在摘要期间不能变**（`:610` 比对 `meter.measure(session).nodes` 全等）。并发改动会抛 `SurfaceChangedError`（`:388`）。

### 3.2 校验规则，已核实（`:549-566`）

`validateSurfaceRegion` 会对不合法的范围直接抛：

- `start` 或 `end` 不在当前 surface 上 → `start seq N not found in surface`
- `start` 位置在 `end` 之后 → `... is after ...`
- `start` 处的切点不是工具配对平衡的 → `... is not a balanced boundary (would split a step's tool-call/result pair)`
- `end` 处的切点不是平衡的 → `... is not a balanced boundary (would split a step, or the step is still open)`

### 3.3 工具配对平衡的判定，已核实

`asar:dsh-compaction/lib/index.js:80-93`：

```js
function toolPairingBalancedBefore(session, seq)   // 切点在 seq 之前（不含 seq）
function toolPairingBalancedAfter(session, seq)    // 切点在 seq 之后（含 seq）
```

- 参数是 `(session, seq)`，返回 boolean。
- **会抛**：seq 不在当前 surface 上（`tool-pairing balance: surface seq N not found`）、surface 序列找不到对应日志事件、tool result 前面没有打开的 call（`:66-70` 的 `cutBalance`，注释见 `:77-78`）。
- 语义：切点处没有"已发出但还没有结果"的 tool call 跨过去。

### 3.4 OCC 怎么自己算范围，已核实

原生的 `selectCompactableRange`（`asar:dsh-compaction-basic/lib/index.js:410-433`）**没有导出**（该包只导出 `BasicCompactionEngine`，第 1027 行）。OCC 只能自己实现等价逻辑，规则是：

1. `measurement.nodes` 必须和 `session.surface.nodes` 逐个 seq 相等，否则抛错（`:414`）。所以要先 `tokenMeter.measure(session)`。
2. surface 第 0 个节点如果是 `system/message`，范围从索引 1 开始；否则从 0（`:415`，`systemHead` 判定）。
3. 从尾部往前累加 `nodes[i].tokens`，直到累计 ≥ `retainTokens`，得到 `keepFromIdx`（`:416-422`）。
4. 从 `keepFromIdx` 往前退，直到 `toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])` 为真（`:424-427`）。
5. `keepFromIdx <= firstIdx` → 没有可压范围，返回 null（`:428`）。
6. 结果 `{ start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }`（`:429-432`）。

**OCC v1 的简化建议**：不做"保留尾部 N token"这套。OCC 的触发点是**计划步骤边界**，天然就是一个语义完整的切点。做法改成：从尾部往前找**最后一个完整的、`toolPairingBalancedAfter` 为真的 surface 节点**作为 `end`，`start` 取 `surfaceNodes[firstIdx]`，中间必须整段 `toolPairingBalancedBefore/After` 都成立。这样少一层 retain 计算，但**需要实测**会不会压得太狠。见第 8 节的取舍。

---

## 4. 和原生自动压缩抢锁，怎么让路

### 4.1 抢锁时的确切错误，已核实

`asar:dsh-compaction-basic/lib/index.js:536-539`：

```js
function assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage) {
  if (unmatchedCompactionStart === void 0 || latestEndSeedSeq !== void 0 && latestEndSeedSeq > unmatchedCompactionStart.seq) return;
  throw new ManualCompactionError("busy", `${stage}: compaction already in progress; the session compaction lock is already active`)
}
```

- 类型：`ManualCompactionError`（`asar:dsh-compaction/lib/index.js:146-160`），**有 `code` 字段**，值是 `'busy'`。
- 触发点有两处：进入时 `compactSurfaceRegion` 里的 `assertCompactionInactive`（`asar:dsh-compaction-basic/lib/index.js:454`），以及 `compactIfNeeded` 里的 `assertNoActiveCompaction`（`:937`）。

### 4.2 不抢的实际情况，已核实

- 原生 `compaction-basic` 的 `auto` 默认是 **true**（`:85`），所以它自己会在每个 `agent/pre-step` 里跑（`:839-852`）。
- 但它是 **`ctx.on('agent/pre-step', ...)` 然后 `return next()`**，和我们一样是 waterfall 监听器。Cordis 的 waterfall 是**外层先跑**（`asar:cordis/lib/index.js:317-325`，"Listeners run outermost-first"）。
- 所以顺序取决于注册顺序，不是我们可控的。**这就是"让路"的核心**：我们不管谁先，只保证自己失败时不打断别人。

### 4.3 让路的实现，推断（基于已核实的错误形状）

```
try {
  result = await engine.compactRegion(start, end, agent, signal)
} catch (error) {
  if (error?.code === 'busy') return next()          // 别人在压，让开，不记错误
  if (isRefusedByBot(error)) { markRefused(session); return next() }  // Bot 会话
  // 其它错误：一条 warn，然后 next()
}
return next()
```

要点：

- **`busy` 不重试**。原生压缩正在跑，它会自己压完。
- **`SurfaceChangedError`（`:388`）也不重试**，这一回合就放弃，下一步再看。
- 任何时候都 `return next()`，绝不 `reject`、绝不吞掉 `decision`。waterfall 里不调 `next()` 等于否决整条链，那会毁掉回合。

### 4.4 一个更要紧的现实：原生已经覆盖了大部分，已核实

- `auto: true` 时原生会在**每个 pre-step** 按压力判断（`:839-852`），阈值是 `min(W×0.8, W−O−65536)`（`:132`），`thresholdRatio` 默认 0.8（`:15`）。
- 也就是说：**当上下文接近 80% 时，原生已经会压**。OCC 的增量只在"还没到 80%、但已经过了计划边界"这一段。
- 这直接决定了 OCC 的收益上限：如果 OCC 把阈值设在 80% 以下很多，它省的是"提前压"的钱；如果设得接近 80%，它几乎不做事。
- **这是 OCC 值不值得做的主要风险**，`report.md:138` 已经写了"原生覆盖 60–70%【推断】"。建议 OCC 第一步就记录"原生在哪些点压了、我们本来会在哪些点压"，用真实数据决定阈值，不要先写判定公式。

---

## 5. `todo/write` 的形状，怎么识别"某一步完成了"

### 5.1 事件形状，已核实

`asar:dsh-tool-todo/lib/index.js:170-173`：

```js
execute(args, exec) {
  const todos = toTodoList(args.todos, allowParallel)
  if (!exec.agent) throw new Error("todo_write requires an owning agent session")
  exec.agent.session.append("todo/write", { todos })
  ...
}
```

- `data` 是 `{ todos: [{content, status}] }`，**整表替换**，不是增量。
- `content` 已 trim，**列表内不允许重复**（`:49-53`，重复直接抛错）。
- `status` 只有三个值：`'pending' | 'in_progress' | 'completed'`（`:15-17`）。
- 除非 `allowParallel`，否则最多一个 `in_progress`（`:60`）。

### 5.2 拿当前列表，已核实

`asar:dsh-tool-todo/lib/index.js:80-92` 注册了 `todos` 投影：

```js
ctx.sessionProjections.register({
  key: "todos", stateSchema: …, init: () => null,
  apply: (state, event) => {
    if (event.type === "todo/write") return event.data.todos
    if (event.type === "turn/start") return null      // 回合开始清零
    return state
  }, ...
})
```

**关键**：`turn/start` 会把 todos 清成 `null`（`:88`）。所以跨回合的"步骤完成"识别**不能靠这个投影**，必须在 `session/event` 里自己攒。

### 5.3 识别边界，已核实 + 推断

- **没有 id**。`content` 是唯一标识，但模型可以改措辞（"修 bug" → "修复 bug"），改了就认不出是同一项。
- 已核实的稳定点：同一份列表内 content 唯一（`:52`）。
- 推断的识别规则（最简）：维护上一份 `Map<content, status>`；新事件到来时，对每个 `content` 比较 status，`pending|in_progress → completed` 记一次边界。content 集合变了的项直接当新项，不参与比较。
- **这条会误判**，这一风险已在审图时确认（`docs/diagrams/flow-occ.png` 上标了）。建议 v1 只用它做"要不要压"的加分项，不做唯一判据；主判据还是上下文压力。

---

## 6. 算账要用的数

### 6.1 `tokenMeter.measure`，已核实

- 服务名 `tokenMeter`（`asar:dsh-token-meter/lib/index.js:692`，`super(ctx, "tokenMeter")`）。
- 签名 `measure(session, requestHeader?)`（`:722`），返回 deep-frozen：
  ```
  { logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes: [{seq, tokens, heuristicTokens}] }
  ```
  （`:757-764`）
- `totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)`（`:761`）。
- **`nodes` 就是 surface 的定价快照**，`selectCompactableRange` 用的就是它（`:411`、`:414`）。OCC 算范围可以直接用它。
- 每次调用 O(surface)（`:716` 的注释 "measurement is O(surface)"），别在循环里反复调。

### 6.2 `resolveModelInfo`，已核实

- `asar:dsh-llm/lib/index.js:2111-2112`：`resolveModelInfo(provider, model, signal)`。
- 返回（`:2131-2141`，带 reasoning 时到 `:2162`）：`{ provider, id, name, description?, inputModalities?, context?: {contextWindow}, defaultMaxTokens?, systemPromptUpdate?, toolUpdate?, reasoning? }`。
- **`context` 是可选的**（`:2137`）。模型没声明 contextWindow 时返回 undefined，要处理这种情况（原生 compaction-basic 会抛 `TargetPressureConfigError`，`asar:dsh-compaction-basic/lib/index.js:126`）。
- 路由从哪拿：`session.requestHeader()?.config` 的 `provider` / `model`（`asar:dsh-session/lib/index.js:1612-1618`；原生同一个写法 `asar:dsh-compaction-basic/lib/index.js:743-750`）。
- `session.requestContext()`（`:1627-1635`）是另一个来源，折叠 `request/context` 事件。**两个都能用，但 `requestHeader().config` 是原生 compaction 用的那个**，保持一致。

### 6.3 预留输出预算，已核实

原生用 `reservedCompletionTokens(agent, info.defaultMaxTokens)`（`asar:dsh-compaction-basic/lib/index.js:940`（函数定义在 `:757`））。这个函数也没导出。OCC 需要它来算"还剩多少可用"，等价做法是读 `session.requestHeader().config.maxTokens ?? info.defaultMaxTokens`（ds-bot 的 `contextLines` 就是这么取的，`ds-bot/src/host/parts.js:170-175`）。

---

## 7. 最小可用版本要多少代码

### 7.1 估算

| 部分 | 行数（含注释，不含测试） | 说明 |
|---|---|---|
| `lib/occ.js` 主体 | 90–120 | 状态机 + pre-step 监听 + 让路 |
| 范围选择（等价 selectCompactableRange 的简化版） | 40–55 | 用 `measure().nodes` + 两个 pairing 判定 |
| Bot 会话识别 + 记住 | 20–25 | 三态 Map |
| 判定（压力 + 边界） | 30–40 | 见 7.2 的简化 |
| 配置项 | 15 | 并进现有 `config.js` |
| **合计** | **195–255** | |
| 测试 | 120–180 | 假 ctx + 假 session，不调模型 |

**总计 315–435 行**，比我给 Chief 的口头估计（250–320）大一点，比 `report.md` 估的 3–5 天小很多。**3–5 天的估计是错的**，主要原因是它假设了要处理 preset 隔离和自定义摘要指令，而 v1 都不做。

### 7.2 能砍的，直说

| 能砍的 | 为什么 | 影响 |
|---|---|---|
| **不做经济性模型（`cacheWriteReadRatio`）** | 本机走 <local-provider-2>/zai/<local-provider>，缓存计价没核实（`report.md:143` 已标）。用 Anthropic 的 12.5 倍套上去，判定必然失真 | 判定退化成"压力 + 步骤边界"两个条件。**这是 v1 最该砍的一项** |
| **不做冷却期 / 请求计数** | 经济性砍了，冷却期就没意义；而且原生每次 pre-step 都会自己判断，我们多压一次它就少压一次 | 少约 25 行 + 一个投影 |
| **不做"压缩后发隐藏消息续跑"** | `report.md:134` 已核实：pre-step 里压完直接进下一步，不需要 Pi 那套 abort/settled/triggerTurn | 直接不存在 |
| **不覆写 `summarize()`** | ds-bot 已经包了这层（`ds-bot/src/host/parts.js:222-227`），我们包就是抢位置 | 省掉整个继承 + profile 配置改动 |
| **不做 `compactNow`（回合间压缩）** | v1 只做 pre-step 内的。回合间压缩要处理 `runMaintenance` 和唤醒（`report.md` 扩展点 10） | 省约 30 行，少一整类竞态 |
| **不自己注册 `update_plan` 工具** | 原生 `todo_write` 已经在用，注册第二个计划工具会让模型困惑，也是"抢位置" | 省约 60 行 + 一个工具定义 |
| **不做 `turn/start` 清空后的重建** | 5.2 已核实投影会在 `turn/start` 清零。v1 干脆不跨回合识别步骤，只看当前回合内的 `todo/write` 变化 | 少一层状态，也少一类误判 |
| **不做状态持久化** | 状态只在内存（`Map<sessionId, state>`），`session/disposed` 时清 | 省掉 storageDomain。代价：重启后 Bot 会话的"已拒绝"要重新学一次（多一次被拒调用） |

砍完剩下的**唯一真正新东西**是：一段"在 pre-step 里，条件满足就调 `compactRegion`，失败就让路"的代码，加上范围选择。**这就是 OCC 的全部价值**。

### 7.3 我建议的 v1 判定（最简）

```
在 agent/pre-step 里：
1. 配置没开 / 会话已标 refused → next()
2. 取 engine（serviceFor 优先）；取不到 → next()
3. 取 requestHeader().config 的 provider/model；取不到 → next()
4. measure(session).totalTokens
5. resolveModelInfo → contextWindow；取不到 → next()
6. 压力 = totalTokens / contextWindow
   压力 < thresholdRatio（默认 0.6，比原生的 0.8 低） → next()
7. 步骤边界：本回合内上一次 todo/write 有某项变成 completed → 满足
   没有 todo 变化 → 不满足（除非压力 > 0.85，强制）
8. 算范围；算不出来 → next()
9. try compactRegion → 成功记一条日志；busy/被拒/SurfaceChanged → next()
10. next()
```

**第 7 步是唯一需要真实数据校准的地方**。建议 v1 先只记录"本来会压"的日志、不真压（干跑），跑一两天看日志再打开。

---

## 8. 风险清单

| # | 风险 | 依据 | 处理 |
|---|---|---|---|
| 1 | **原生已覆盖 80% 压力触发** | `asar:dsh-compaction-basic/lib/index.js:15,85,839-852` | 阈值必须低于 0.8 才有增量。先干跑测 |
| 2 | **waterfall 顺序不可控** | `asar:cordis/lib/index.js:317-325`，外层先跑 | 不依赖顺序，只做"失败让路" |
| 3 | **`whole-surface` 稳定性要求** | `asar:dsh-compaction-basic/lib/index.js:610` | 摘要期间任何 surface 改动都会失败。压完立即返回，别在中间 await 别的东西 |
| 4 | **ds-bot 原地改 engine 方法** | `ds-bot/src/host/parts.js:201-240` | 每次重新取 engine，不缓存，不改方法 |
| 5 | **`context` 可能缺失** | `asar:dsh-llm/lib/index.js:2128-2134` | 缺失就跳过，不抛 |
| 6 | **todo 没有 id，措辞变了认不出** | `asar:dsh-tool-todo/lib/index.js:45-62` | 只当加分项，不当唯一判据 |
| 7 | **`turn/start` 清空 todos 投影** | `asar:dsh-tool-todo/lib/index.js:88` | v1 不跨回合 |
| 8 | **Bot 会话的拒绝靠英文 message 匹配** | `ds-bot/src/host/parts.js:186-187` | 匹配不上时退化为"多试一次然后失败"，不会出错 |
| 9 | **`selectCompactableRange` 没导出** | `asar:dsh-compaction-basic/lib/index.js:410`（不在导出列表） | 自己实现，规则见 3.4 |
| 10 | **v1 的阈值/边界都是推断** | 本节 7.3 | 先干跑记录，用真实数据定 |
| 11 | **原生 compaction 的 config 被改过，我们算的原生线会偏** | 见 10.2 补充 | 见下面一段 |
| 12 | **占用测的是剪枝前的数** | `asar:dsh-compaction-basic/lib/index.js:942-946` | 记 `occupancy.pruned: false`，见 10.3 补充 c |

**风险 11 说明（Researcher 复核第 4 条补的）**：

`nativeThreshold` 是我们**自己按默认值算的**（`0.8`、`65536`、`0.16`，`asar:dsh-compaction-basic/lib/index.js:15-17,63`）。原生真正的值来自它自己的 config，**插件读不到**——`ctx.get('compaction')` 拿到的实例上只有方法，配置没暴露成公开 API（`BasicCompactionEngine.config` 是类字段，但没写进任何 README 的公开契约，属于内部结构）。

【已核实】本机 desktop 的 4 个 preset 里 `compaction-basic` **都没有配 config**（`<desktop-profile>/cordis.yml:847-848`、`:1011-1012` 等，只有 `- id` 和 `name` 两行；全文 grep `compaction-basic`，后面没有一处跟 `config:`），所以按默认值算出来的线是准的。

【推断】但用户如果以后在 profile 里给 `compaction-basic` 配了 `thresholdRatio` 或 `headroomTokens`，我们算出的原生线就会偏，`0.85 × native` 的提前量也跟着偏。

**v1 不处理**，只在账本里记下我们用的值（`occupancy.nativeThreshold` 已经是算出来的数，不是读出来的），干跑数据里能看出异常。真要处理，只有一个办法：让用户在 `occ` 段里手动填原生线，多一个配置项。**不值得，v1 不做。**

---

## 9. 没做的事

- 没运行任何代码，没装插件，没改任何文件（除了这份笔记）。
- 没核实"被拒之后同一个会话会不会因为 ds-bot 的状态变化而不再拒"（`condensing` 是动态的，`ds-bot/src/host/parts.js:192`）。推断：如果 ds-bot 正在自己压这个会话，`ownedByBot` 为 false，我们的调用会真的进去，可能撞 busy。这条要在实测时看。
- 没核实 preset 隔离下 `serviceFor` 返回的 engine 和 `ctx.get('compaction')` 是不是同一个对象（不同 preset 应该是不同的，没实测）。
- 没核实干净 web profile（没有 preset 隔离）里 `ctx.get('compaction')` 能不能直接拿到。

---

## 10. v1 实现规格（2026-10-18，Chief 定的四条）

依据：`report.md` 2.4 的「v1 定稿」（第 158-166 行）和 3.3。SolDev 第 5 步照这一节写。

### 10.0 一条必须先说的冲突：配对平衡不能 import

`toolPairingBalancedBefore/After` 是 `@deepseek-ai/dsh-compaction` 的导出（`asar:dsh-compaction/lib/index.js:175`）。但 `report.md` 3.2 定的是**整个插件不 import 任何 `@deepseek-ai/*`**，所以**这两个函数不能用**，必须自己实现等价逻辑。

好消息：算法本身很短，已经核实清楚（`asar:dsh-compaction/lib/index.js:19-58`）：

- 每个 surface 事件对「未闭合 tool-call 数」的增量：`assistant/message` 数其中 `type === 'tool-call'` 的块；`tool/result` 是 `-1`；其它是 `0`（`:21-27`）。
- 按 surface 顺序累计，每处理完一个节点记一次「此刻是否归零」。
- `cutBalanced[0] = true`（第一个节点之前的切点），处理完第 i 个节点后是 `cutBalanced[i+1]`。
- 「seq 之前的切点」= `cutBalanced[i]`，「seq 之后的切点」= `cutBalanced[i+1]`（`:66-70` 的 `index + offset`）。
- 累计值出现负数 → surface 损坏，抛错（`:36`）。

`tool/call` 和 `tool/result` 的形状已用真实会话核对过：`tool/call` 有 `data.callId`，`tool/result` 有 `data.toolCallId`，两边一致。**但我们不需要比 callId**，只数个数就够了，和原生一致。

> **2026-10-18 补充 a（Researcher 复核第 1 条）**：`tool/call` 事件的增量是 **0**，不是 +1。只数 `assistant/message` 里的 `tool-call` 块（`:21-27` 的 `eventDelta` 只有 `assistant/message` 和 `tool/result` 两个分支，`default` 返回 0）。
>
> 这一条容易写错：上面说「`tool/call` 有 `data.callId`」，实现时很容易顺手把它也算成一次调用，那样计数会翻倍、切点全错。**`tool/call` 只是通知事件，真正的 +1 来自随后的 `assistant/message` 里的块。**
>
> 另外原生 `extendCache` 会校验 `event.seq === seq`，对不上就抛（`:35`）。我们返回 null，10.1 已写明。

### 10.1 选范围的伪代码

输入：
- `nodes`：`ctx.tokenMeter.measure(session).nodes`，每项 `{seq, tokens, heuristicTokens}`
- `surfaceNodes`：`session.surface.nodes`（`asar:dsh-session/lib/index.js:561-565`）
- `retainTokens`：要原样保留的尾部预算
- `balanced`：自己算出来的布尔数组，见 10.0

```
function selectRange(session, measurement, retainTokens):
  priced = measurement.nodes
  if priced.length == 0: return null
  surface = session.surface.nodes

  # 1. 两边的节点必须完全一致，否则定价和范围对不上
  if surface.length != priced.length: return null
  for i in 0..surface.length-1:
      if surface[i] != priced[i].seq: return null

  # 2. 算配对平衡
  balanced = computeCuts(session, surface)      # 见 10.0
  if balanced == null: return null              # surface 损坏

  # 3. 系统头不进范围
  headIsSystem = session.eventAt(surface[0])?.type == "system/message"
  firstIdx = headIsSystem ? 1 : 0

  # 4. 从尾部往前累加，找出要保留的尾巴
  acc = 0
  keepFrom = priced.length
  for i from priced.length-1 down to 0:
      acc += priced[i].tokens
      keepFrom = i
      if acc >= retainTokens: break

  if keepFrom <= firstIdx: return null

  # 5. 往回退到平衡的切点
  while keepFrom > firstIdx:
      if balanced[keepFrom] == true: break       # 注意：cut BEFORE surface[keepFrom]
      keepFrom -= 1

  if keepFrom <= firstIdx: return null

  start = surface[firstIdx]
  end   = surface[keepFrom - 1]

  # 6. 最后自检：两端都必须平衡
  startIdx = firstIdx
  endIdx   = keepFrom - 1
  if balanced[startIdx] != true: return null
  if balanced[endIdx + 1] != true: return null
  if start > end: return null

  return { start, end, nodes: endIdx - startIdx + 1,
           tokens: sum(priced[i].tokens for i in startIdx..endIdx) }
```

要点：

- `start` / `end` 都是 **surface seq，闭区间**（`asar:dsh-compaction-basic/lib/index.js:971-976` 的签名就是 `(start, end, agent, signal)`）。
- **绝不能让范围包含 `system/message` 头**，否则压缩会把系统提示压掉。
- `computeCuts` 遇到负数或 `eventAt` 返回 undefined 时**返回 null 而不是抛**，让调用方跳过（防护规则 3：出错就让路）。原生那里是抛（`:33-37`），我们不抛。
- `retainTokens` v1 固定成 `floor((contextWindow − reservedOutput) × 0.16)`，和原生的 `retainRatio` 默认值一致（`:17`），**不做配置项**。少一个旋钮。
- `reservedOutput` = `session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0`（照 `:757-759`）。

### 10.2 thresholdRatio 的建议值

**结论：配置键保持 `thresholdRatio: 0.5` 不变，但内部要用 `min(ratio × W, 0.85 × native)` 兜一层。**

先说为什么不能只用 `ratio × W`。原生的触发点是 `min(0.8W, W − O − 65536)`（`report.md` 第 1 节第 9 条，代码在 `asar:dsh-compaction-basic/lib/index.js:132`，`O` = `reservedCompletionTokens`）。这个式子**在小窗口时是第二项说了算**，比例远低于 0.8：

| 模型（本机实际配置） | W | O | 原生触发点 | 占窗口 |
|---|---|---|---|---|
| `<local-provider>/global:deepseek-v4.1-flash` | 1,000,000 | 384,000 | **550,464** | **55.0%** |
| `<local-provider>/global:hy4-preview` | 1,000,000 | 64,000 | 800,000 | 80.0% |
| `<local-provider-2>/claude-opus-5.5` | 1,000,000 | 128,000 | 800,000 | 80.0% |
| `zai-coding-cn/glm-5.3` | 1,000,000 | 131,072 | 800,000 | 80.0% |
| 假设 128k 窗口、8k 输出 | 128,000 | 8,192 | **54,272** | **42.4%** |
| 假设 200k 窗口、16k 输出 | 200,000 | 16,384 | 118,080 | 59.0% |

【已核实：公式和代码；窗口/O 取自 `<desktop-profile>/cordis.patch.yml:21-122`；真实会话里 `request/header` 的 `maxTokens` 实测就是 384000，来自本机 3 个会话的会话日志】

两个直接后果：

1. **本机主力模型（`global:deepseek-v4.1-flash`）原生在 55% 就压了，不是 80%。** `report.md:166` 写的「80% 附近」只对 hy4-preview 和 <local-provider-2> 那几个 O 较小的模型成立。**这一条要改**，不然 OCC 的收益窗口会被高估。
2. **固定 0.5 在小窗口上会失效**：128k 窗口下原生 42.4% 就压，OCC 等到 50% 才动手，永远晚一步，等于不做事。

所以兜一层：

```
nativeThreshold = floor(min(W * 0.8, W - O - 65536))
occThreshold    = floor(min(thresholdRatio * W, nativeThreshold * 0.85))
if occThreshold <= 0: 跳过（这个模型没有增量空间）
if retainTokens >= occThreshold: 跳过（尾部比触发线还大，压了也没用）
```

> **2026-10-18 补充 b（Researcher 复核第 2 条）**：`retainTokens >= occThreshold` 必须跳过。
>
> 原生的 `resolveCompactSpec` 在 `retainTokens >= thresholdTokens` 时直接抛配置错误（`asar:dsh-compaction-basic/lib/index.js:134`）。我们不能抛，要跳过。
>
> 什么时候会碰到：**窗口小、输出上限大**。我把窗口从 32k 扫到 256k、输出 8k/16k/32k 三档都算了一遍（24 组），**11 组是负数**（被 `<= 0` 挡住），**还有 1 组是正数但 retain 顶到触发线**：
>
> | W | O | native | occ | retain | 结果 |
> |---|---|---|---|---|---|
> | 96,000 | 16,384 | 14,080 | 11,968 | **12,738** | `retain >= occ`，必须跳过 |
> | 64,000 | 8,192 | −9,728 | −8,269 | 8,929 | 负数，被 `<= 0` 挡住 |
> | 128,000 | 8,192 | 54,272 | 46,131 | 19,661 | 正常 |
>
> **96k 那一组就是两条守卫都要有的证明**：`occ > 0`，但 retain 比它大，硬算会选出一个「尾部比触发线还长」的范围，等于没压。原生在这里抛配置错误（`:134`），我们跳过。
>
> **少任何一条守卫，负数或零预算都会流进选范围函数。**

为什么是 `0.85 × native`：留 15% 的提前量，够模型跑完当前步骤再压，又不至于早到「省下的量还不如重写缓存」。验算：

| 场景 | native | occ（ratio=0.5） | 提前量 |
|---|---|---|---|
| 1M / O=384k | 550,464 | **467,894** | 82,570 tokens |
| 1M / O=128k | 800,000 | **500,000**（0.5W 更小） | 300,000 |
| 128k / O=8k | 54,272 | **46,131** | 8,141 |
| 200k / O=16k | 118,080 | **100,000**（0.5W 更小） | 18,080 |
| 256k / O=32k（Researcher 加的） | 157,696 | **128,000**（0.5W 更小） | 29,696 |

每种窗口都留出了真实的提前量，没有一个落空。第五行是 Researcher 独立验算加进来的，retain 在那组是 `floor((262144−32768)×0.16) = 36,701`，小于 128,000，正常。

**推理边界**：0.85 这个系数是推断，没有实测。干跑的意义就是把「本来会压」的实际占用率记下来，如果数据显示绝大多数触发都贴着 `occThreshold`（说明提前量不够），就调小；如果显示压完几乎不省（说明太早），就调大。**v1 不要拍死这个数**。

### 10.3 干跑时账本记哪一行

`kind: "occ-dry"`，写到 `$DSH_HOME/dsh-sol/<sessionId>/ledger.jsonl`（和 Meter 同一份账本，`report.md` 3.4）。一行一次判定，**不是每回合一行**。

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | number | 记录格式版本，1 |
| `kind` | string | `"occ-dry"` |
| `sessionId` | string | 会话 id（先过 `isValidSessionId`） |
| `at` | string | ISO 时间 |
| `turn` | number | 当前回合 |
| `step` | number | 当前步 |
| `seq` | number | 判定时 `session.seq`（下一个事件序号），用于和别的行对齐 |
| `occupancy.totalTokens` | number | `tokenMeter.measure(session).totalTokens` |
| `occupancy.contextWindow` | number | `resolveModelInfo(...).context.contextWindow` |
| `occupancy.ratio` | number | `totalTokens / contextWindow`，保留 4 位 |
| `occupancy.nativeThreshold` | number | 10.2 算出的原生触发点 |
| `occupancy.occThreshold` | number | 10.2 算出的我们的触发点 |
| `occupancy.pruned` | boolean | **恒为 false**。原因见下面的补充 c：我们测到的占用**没有扣掉 pruner 会剪掉的量** |
| `sinceLastCompactSteps` | number \| null | 距本会话上一次压缩过了多少步；从没压过就是 null。补充 d 用 |
| `boundary` | object \| null | `{ turn, step, completed: ["…"] }`，本次判定用到的边界；没有就是 null |
| `range` | object \| null | `{ start, end, nodes, tokens }`，选中的范围；没选出来就是 null |
| `decision` | string | 见下表，**这是干跑最要紧的字段** |
| `wouldCompact` | boolean | `decision === "would-compact"` |

> **2026-10-18 补充 c（Researcher 复核第 3 条）：`occupancy.pruned` 恒为 false，必须记下来。**
>
> 原生在比阈值**之前**会先跑 pruner，然后再测一次占用（`asar:dsh-compaction-basic/lib/index.js:942-946`）：
> ```
> if (measurement.totalTokens < spec.thresholdTokens) return null;
> if (prune !== void 0) { prune.pruneSession(agent.session); measurement = meter.measure(agent.session); }
> if (measurement.totalTokens < spec.thresholdTokens) return null;
> ```
> 我们只测一次，**测到的是剪之前的大数**。所以：
> - 我们算的 `ratio` 会**偏高**，触发会比真实情况**偏早**。
> - 这个偏差方向是确定的（只会早、不会晚），所以不影响「够不够早」的判断，只影响「早多少」。
> - 干跑数据里能看到：如果大量 `would-compact` 的 `ratio` 贴着 `occThreshold`，而真实压缩后占用掉了很多，说明 pruner 本来就能解决问题，OCC 可以再晚一点。
> - **v1 不自己调 pruner**（那是别人的服务，`ctx.get('toolResultPruner')` 是 compaction 的可选依赖，我们不该在 pre-step 里手动剪）。

> **2026-10-18 补充 d（Researcher 复核第 4 条）：加 `sinceLastCompactSteps`。**
>
> 原因：原生压完会**再测一次**，还超线就继续压（`asar:dsh-compaction-basic/lib/index.js:950-958`，最多 `compactionRetries+1` 次）。OCC v1 只压一次，这更简单、可以接受。但如果尾部有一个特别大的节点，压完可能马上又过线，**下一个边界又会触发一次**，连续压。
>
> `sinceLastCompactSteps` 的算法：每步 +1，压缩发生时归 0（我们自己的压缩和**原生**的压缩都要归零——原生压完 surface 变了，我们的占用计数也该重算）。取值来源：`session/event` 里的 `compaction/start`。**已核实是标准会话事件**（`asar:dsh-compaction-basic/lib/index.js:469` 写入，`:716` 读回），原生压缩和我们自己调的 `compactRegion` 走的是同一条路径，所以两种压缩都能被数到，不用区分是谁压的。
>
> **v1 只记录，不加冷却逻辑**。等干跑数据出来，看有没有「连续两步都 would-compact」的情况，再决定要不要加冷却。加了冷却就多一个配置项，现在不加。

`decision` 的取值（每条都对应代码里的一个出口，测试要逐个覆盖）：

| 值 | 含义 |
|---|---|
| `would-compact` | 条件全满足，真压的话这里会压 |
| `disabled` | `occ.enabled` 为 false（不该走到这，防御用） |
| `no-boundary` | 没有计划边界 |
| `below-threshold` | 有边界，但占用没到 `occThreshold` |
| `no-window` | 拿不到 contextWindow，或 `occThreshold <= 0`（这个模型没有增量空间） |
| `retain-too-large` | `retainTokens >= occThreshold`：留尾比触发线还大，压了也不省（补充 b） |
| `no-engine` | 拿不到 compaction 服务 |
| `no-range` | 拿得到引擎，但选不出一个不断开工具调用的范围 |
| `refused` | 被 ds-bot 拒绝（只在 dryRun=false 时可能出现） |
| `busy` | 原生正在压（只在 dryRun=false 时可能出现） |

> **2026-10-18 拆分**：原来 `retain-too-large`、`no-engine`、`no-range` 三种都记 `no-range`，2a 真机跑完以后按 Chief 的定论拆成三个值，只改字符串、控制流不动。理由：账本读的人要能一眼分清「这个模型没救」「服务没拿到」和「这次运气不好选不出范围」。

**为什么不每回合都记一行**：`agent/pre-step` 每步都跑，每回合几十步，全记会把账本撑爆。只在「有边界」或「过了阈值」时记，其余不记。这样一份账本读完就能回答两个问题：多少次本来会压、每次为什么没压。

### 10.4 测试清单

假 ctx、假 session，不调模型、不调真压缩。每条都断言**返回值是 `next()` 的结果**（防护规则 3 的硬要求）。

**A. 边界识别（6 条）**

| # | 场景 | 期望 |
|---|---|---|
| A1 | `todo/write` 里某项 `in_progress → completed` | 记一个边界，`boundary.completed` 含该项 |
| A2 | **只改措辞**：上一份 `"修 bug"`（in_progress），这一份 `"修复 bug"`（completed） | **也算边界**（见下面的规则） |
| A3 | 两份完全相同 | 不算边界 |
| A4 | 某项 `completed → pending`（退回去） | 不算边界 |
| A5 | 第一份 `todo/write` 里就有 `completed` 项 | 算边界（从无到已完成） |
| A6 | 边界用掉之后没有新的 `todo/write` | 不重复触发（边界要消费掉） |

**A2 的规则**（这是我定的，写进代码注释）：判定用「新列表里 `status === 'completed'` 且（上一份没有同 content 的项，或上一份那项不是 completed）」。措辞一改就变成「上一份没有同 content 的项」，于是命中。代价是「首次出现就已 completed」也会触发（A5），这会稍微提前压，但有阈值兜着，可以接受。

**B. 窗口与阈值（5 条）**

| # | 场景 | 期望 |
|---|---|---|
| B1 | `resolveModelInfo` 返回的 `info.context` 是 undefined | `decision: "no-window"`，不抛，`next()` |
| B2 | `requestHeader()` 返回 undefined | 同上，不抛 |
| B3 | 占用 40%，阈值 50% | `decision: "below-threshold"` |
| B4 | 占用 52%，`native=55%` | `decision: "would-compact"`（说明 `0.85×native` 兜底生效） |
| B5 | 小窗口，`native=42.4%`，占用 45% | **`below-threshold` 或 `would-compact` 必须按 10.2 的公式算**，不能按裸 `0.5W`（否则这里会误判成 `would-compact`，实际原生已经压过了） |

**C. 真压的失败路径（4 条，dryRun=false）**

| # | 场景 | 期望 |
|---|---|---|
| C1 | `compactRegion` 抛 `ManualCompactionError('busy')` | `decision: "busy"`，不重试，`next()` |
| C2 | 抛 ds-bot 那句 `A Bot conversation makes room on its own…` | `decision: "refused"`，这个会话以后不再试（第二次直接 `next()`，不再调 engine） |
| C3 | 抛 `SurfaceChangedError` | 只 warn，`next()`，不重试 |
| C4 | `compactRegion` 正常返回 | 账本记 `kind: "occ"`（不是 `occ-dry`），带 `shadowedTokenCount` |

**D. dryRun 两种取值（3 条）**

| # | 场景 | 期望 |
|---|---|---|
| D1 | `dryRun: true`（默认），条件全满足 | 账本有一行 `occ-dry` + `would-compact`；**`compactRegion` 一次都没被调用**（用计数用的假 engine 断言） |
| D2 | `dryRun: false`，条件全满足 | `compactRegion` 被调用 1 次，账本记 `kind: "occ"` |
| D3 | `dryRun` 不写，默认值 | 等价于 `true` |

**E. 每条路都让路（贯穿）**

| # | 场景 | 期望 |
|---|---|---|
| E1 | 上面每一条，都断言 `next` 的返回值原样返回 | 不能返回 undefined、不能返回 `{kind:'reject'}` |
| E2 | 整个 handler 内部抛任意错误 | 被 catch，只 warn，仍然 `next()` |
| E3 | `signal.aborted` 为 true | 直接 `next()`，不读投影、不选范围 |
| E4 | `occ.enabled: false` | 一个监听器都不注册（和第 1 步的「全关不注册」一致） |
| E5 | 账本写盘失败 | 只 warn，不影响 `next()`（沿用 Meter 的 `Promise.catch` 写法） |

**F. 范围选择（纯函数，6 条）**

| # | 场景 | 期望 |
|---|---|---|
| F1 | 正常 surface | 返回合法 `[start, end]`，两端都平衡 |
| F2 | `surface[0]` 是 `system/message` | `start` 不是 `surface[0]` |
| F3 | 尾部不够 `retainTokens` | 返回 null（`no-range`） |
| F4 | 中间有一个未闭合的 tool-call | 边界往回退到平衡点，不切在中间 |
| F5 | `measurement.nodes` 和 `surface.nodes` 长度或 seq 不一致 | 返回 null，不抛 |
| F6 | `eventAt` 返回 undefined（surface 损坏） | 返回 null，不抛 |

### 10.5 服务怎么拿（不 import 的前提下）

- `tokenMeter`、`llm`、`agentPresets`、`compaction` **全部用 `ctx.get(name)` 可选取**，不写进 `inject`。理由：写进 `inject` 会让插件在缺这些服务的 profile 里整个不激活（`practices.md:20`），而 OCC 只是五个机制之一，不该拖累别的。ds-bot 就是这么取的（`ds-bot/src/host/parts.js:194`）。
- 取不到任何一个 → 这个会话跳过，`decision` 记对应原因，`next()`。
- **每次判定都重新取 engine**，不缓存（ds-bot 会原地改方法，见第 8 节风险 4）。

### 10.6 代码落点

| 文件 | 内容 | 估行数 |
|---|---|---|
| `lib/occ.js` | 监听 + 状态机 + 判定 + 让路 | 110-140 |
| `lib/occ-range.js` | `computeCuts` + `selectRange`（纯函数，好测） | 60-80 |
| `lib/config.js` | 加 `occ: {enabled, thresholdRatio, dryRun}` | 10 |
| `test/occ.test.js` | A、B、C、D、E 组 | 90-120 |
| `test/occ-range.test.js` | F 组 + 10.0 的 `computeCuts` | 60-80 |
| **合计** | | **330-430（含测试）** |

和第 7.1 节的估算（315-435）对得上，没膨胀。**其中真正新写的东西只有 `computeCuts` + `selectRange` 两个纯函数和一段判定**，其余都是胶水。

### 10.7 三处和 report.md 对不上、需要 Chief 改的地方

1. **`report.md:166`「原生的自动压缩在 80% 附近才动手」不准确。** 准确说法：原生触发点是 `min(0.8W, W−O−65536)`，**本机主力模型（`global:deepseek-v4.1-flash`，O=384k）算出来是 55%，不是 80%**；128k 窗口配 8k 输出时是 42.4%。这句直接影响对 OCC 收益的判断，建议改。
2. **`report.md` 2.4 规则第 2 条只写了 `thresholdRatio × contextWindow`**，没写 `0.85 × native` 的兜底。按字面实现，小窗口模型上 OCC 永远不触发（10.2 的验算）。建议把这层兜底写进 2.4 第 2 条。
3. **`report.md` 2.4 规则第 4 条要求「`compactRegion` 返回 busy 就让路」**，但没说选范围要用 `toolPairingBalancedBefore/After`——这两个函数在 `@deepseek-ai/dsh-compaction` 里，按 3.2 我们不能 import。**建议在 2.4 里写明「配对平衡由插件自己算」**，否则 SolDev 会直接去 import，撞上 3.2 的红线。

这三条我只报，没改 `report.md`（按规矩只报问题）。

---

## 11. 本节新增核实（2026-10-18 补）

写 10.0 时又核了几处，一并记下：

- **配对平衡算法**：`asar:dsh-compaction/lib/index.js:19-58`，`eventDelta`（`:21-27`）+ `extendCache`（`:29-40`）+ `cutBalance` 的 `index + offset`（`:66-70`）。已核实。
- **`tool/call` / `tool/result` 的真实形状**：`tool/call` 带 `data.callId`、`data.name`、`data.arguments`（字符串化的 JSON）；`tool/result` 带 `data.toolCallId`，两边一致。**已用本机真实会话日志核对**（<another-project> 那个会话，`seq 29` / `seq 31`）。
- **`session.surface.nodes`**：返回 surface 上的 seq 数组（`asar:dsh-session/lib/index.js:561-565`），每次访问会先折叠新增事件。
- **`session.eventAt(seq)`**：`return this.log[seq]`（`:1439-1441`），**直接用 seq 当下标**，所以 seq 必须等于数组下标（这也是原生 `extendCache` 要校验 `event.seq !== seq` 的原因）。
- **`reservedCompletionTokens`**：`requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0`（`asar:dsh-compaction-basic/lib/index.js:757-759`），已核实，不是推断。
- **本机真实 `maxTokens`**：3 个真实会话的 `request/header` 里都是 `maxTokens: 384000`，`request/context` 里 `contextWindow: 1000000`（`<project-key>`、`<project-key>`、`<project-key>` 三个会话）。这解释了为什么本机原生阈值落在 55%。
