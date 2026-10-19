# 第 3 步源码核实：ObservationPack

日期：2026-10-18。只读核实，没有运行代码。DSH 0.2.1-rc.2。
- `asar:` 指 `app.asar` 里的 `dsh/node_modules/@deepseek-ai/<包>/lib/index.js`。
- `bot/` 指 `<desktop-profile>/node_modules/ds-bot/`。
- **已核实**：读过原文，附 文件:行。**推断**：没有运行过。

## 0. 短版结论

1. post-execute 返回 `accept{content}` 后，**写进会话日志的就是替换后的这份**。原文只留在我们自己的存档里，`value` 不进日志。【已核实】
2. dsh-sol 按普通方式注册（不加 prepend），会排在 spill 里层：**我们先替换，spill 后检查**。占位符很小，spill 不会再动它。【已核实】
3. ds-bot 的脱敏发生在 `tools/execute`，早于 post-execute，**我们拿到的已经是脱敏后的内容**。compat 2.4 的要求自动满足，但仍要用测试钉住。【已核实】
4. `obs_recall` 可以在全局注册，照 `todo_write` 的写法。【已核实】
5. 执行时替换做不到 SoL-Pi 的“前 2 次发全文”。可选的近似做法见第 6 节，**要 Chief 定**。

## 1. content 的形状，以及替换后写进日志的是哪份

- content 是块数组：`{type:"text", text}`，或者 `{type:"image", attachment:{attachmentId, mediaType, width, height}}`（`asar:dsh-spill-policy:168-178`，`fullText` 按这两种块处理）。【已核实】
- 如果决定里带了 `content`，`postExecute` 合并成 `{...result, content}`，`value` 保持原值（`asar:dsh-tools:3620-3627`，`:3625`）。【已核实】
- 不能同时替换 `value` 和 `content`，会抛错（`:3611`）。失败的结果不能替换 `value`（`:3614`）。ObservationPack 只替换 `content`。【已核实】
- 之后的顺序：
  1. `finishScheduledExecution`（`:3477-3491`）
  2. 工具自己的 `finalizeContent`（`:3494-3502`）
  3. 通知 `tools/result`（`:3505-3525`）
  4. agent-loop 的 `appendToolResult` 用 `result.content` 拼出消息，写进 `tool/result`（`asar:dsh-agent-loop:569-571`、`:691-706`）

  日志只记 `message` 和 `meta`，不记 `value`。【已核实】
- 注意：`finalizeContent` 在我们**之后**执行，可能再改一次 content。`dsh-tool-pwsh` 和 `dsh-tool-fs` 没有用它（grep 0 命中）。其他工具有没有用，没查。【已核实：前两个；推断：其余】
- 同一步里的多个工具调用，按模型给出的顺序**串行** finalize（`asar:dsh-agent-loop:566-571`，`await` 一个接一个）。所以写账本不用加锁。【已核实】

## 2. 和 spill 谁先跑

- 机制：
  - cordis 每个事件只有一个监听列表（`asar:cordis:258-264`），派发时按 scope 过滤（`asar:dsh-scope:327-338`）。
  - waterfall 从最外层开始调（`asar:cordis:317-325`）。prepend 用 `unshift` 插到队头，普通注册用 `push` 追加到队尾（`:336`）。【已核实】
- spill 用 prepend 注册，在最外层。它先 `await next()`，等里层都返回了，才处理 `decision.content ?? result.content`（`asar:dsh-spill-policy:237-255`）。
- dsh-sol 普通注册，在里层，所以先替换。spill 拿到的是我们的占位符，太小，不会落盘。【已核实】
- 跨 scope 的规则：agent scope 和全局 scope 的监听在同一个列表里，顺序只看注册先后，和 scope 无关。【已核实：机制】实际加载顺序没跑过。【推断】
- 同一层还有两个普通注册的监听：`dsh-repeat-tool-reminder`（`:2247-2259`）往 `additionalContexts` 里加提醒；`dsh-tool-fs-search`（`:848-862`、`:1159-`）给 glob/grep 结果做 spill。照它们的写法：

```js
ctx.on('tools/post-execute', async (exec, result, next) => {
  const decision = await next()
  if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
  const content = decision.content ?? result.content
  // ...判断要不要替换；不替换就 return decision
  return { kind: 'accept', content: replaced,
    ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }
})
```

  `additionalContexts` 必须原样带上，否则会吞掉 repeat-tool-reminder 的提醒。【已核实：两处现成写法】

## 3. 拿到的是不是脱敏后的内容

- ds-bot 在 `tools/execute` 里对结果做 `redactDeep`（`bot/src/host/secrets.js:444-457`）。
- `tools/execute` 在派发阶段执行（`asar:dsh-tools:3427`），早于 `finalizeScheduledExecution → postExecute`（`:3455-3465`）。
- 所以 post-execute 看到的 `result.content` 已经脱过敏。存档写的是这一份，不会把密钥重新写成明文。【已核实】
- 测试要钉两条：
  - 存档内容逐字节等于传进来的 `content`；
  - 不读 shell 自己落盘的 spillPath 文件（report.md 3.5）。

## 4. `obs_recall` 的注册

- 写法：`ctx.tools.register(defineTool({...}))`，照 `asar:dsh-tool-todo:95-140`。`defineTool` 从 `@deepseek-ai/dsh-tools` 导入（导出见 `asar:dsh-tools:3810`）。【已核实】
- 必须声明 `output: {schema, render}`，否则 register 抛错（`asar:dsh-tools:2974-2985`）。全局层有同名工具也会抛错（`:2731`）。【已核实】
- 参数写成属性表，每个字段自己写 `required: true`（`todo:98-118`），由 `parameterSchemaSpecToJsonSchema` 编译（`asar:dsh-tools:802-811`）。【已核实】
- 建议的形状：`{ id: {type:"string", required:true}, offset: {type:"integer"}, limit: {type:"integer"} }`。字节还是行、每页上限多少，按 report.md 2.2 来定。
- `render(args, value)` 返回内容块数组，形状照 todo 的 `render` 抄。【推断：没逐行看 todo 的 render】
- 默认关闭时不注册（防护规则 5）。

## 5. exec 上能拿到什么

`createExecution`（`asar:dsh-tools:3227-3264`）给出的字段【已核实】：

| 要的 | 实际字段 |
|---|---|
| 工具名 | `exec.name`（没有 `toolName`） |
| callId | `exec.callId`，另有 `rootCallId` |
| 嵌套标记 | `exec.parent`（顶层调用不带这个字段） |
| agent | `exec.agent`，可能不存在 |
| sessionId | 没有直接字段。用 `exec.agent?.session.header.id`（spill 的写法，`asar:dsh-spill-policy:182`），或 `agent.session.id`（`asar:dsh-compaction-basic:319`） |
| 参数 | `exec.arguments`，已冻结 |
| 取消 | `exec.signal` |

`notifyResult` 会把 exec 冻结（`asar:dsh-tools:3506`）。不要在 exec 上挂自己的状态，用 WeakMap。【已核实】

## 6. 哪些跳过

| 条件 | 依据 |
|---|---|
| `decision.kind !== 'accept'`，或者决定里已经有 `value` | spill 同样跳过（`asar:dsh-spill-policy:239`）【已核实】 |
| `result.isError` | SoL-Pi 只处理非错误结果（solpi.md）【已核实】 |
| `exec.parent !== undefined`（嵌套调用） | spill 跳过纯文本的嵌套结果（`:242`）【已核实】 |
| 含图片块 | `content.some(b => b.type === 'image')`，SoL-Pi 只处理纯文本【已核实】 |
| `exec.name === 'read'` | spill 同样跳过（`:239`）【已核实】 |
| `exec.name === 'obs_recall'` | 防止回读的结果再被替换，形成循环【推断：设计要求】 |
| `edit_then_run` / `write_then_run` | 建议 v1 整个跳过。只替换 `[then_run:*]` 后面的命令输出，需要 Fusion 把命令输出单独放一个块，两个模块就耦合了。等 A/B 数据表明值得再做【推断：设计建议】 |
| PTC 子调用日志 | 走另一个事件 `tools/ptc-dispatch-log`（`asar:dsh-spill-policy:256-259`），v1 不管【已核实】 |

## 7. 要 Chief 定的一件事：“前 2 次发全文”

执行时替换只有一次机会，模型第一次看到的就是占位符（report.md 2.2）。两种近似做法：

- a) **按大小**：超过阈值就替换，第一次也一样。最简单。
- b) **按重复**：同一会话里，内容哈希第 N 次出现时才替换（N 从配置读，默认 2）。前 N−1 次照常发全文，最接近 SoL-Pi 的“反复出现”。只多一个按会话计数的 Map，用 sessionId 加 sha256 当键。

我推荐 b，代码量差不多，而且第一次看到的是全文，不容易丢证据。【推断】

另外两个边界：
- 调用方在 post-execute 期间取消时，成功结果会被换成取消结果（`asar:dsh-tools:3465`）。这时存档可能已经写了，留下一个孤儿对象。无害，账本里记一行就行。【已核实：替换逻辑；推断：孤儿对象的影响】
- 监听抛错会让整个工具结果变成 isError（`:3467`）。所以 ObservationPack 必须全程 try/catch，出错就 `return decision`（防护规则 3）。【已核实】
