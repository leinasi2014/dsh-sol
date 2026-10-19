# 第 4 步源码核实：Evidence-Preserving Reducer

日期：2026-10-18。只读核实，没有运行代码，**没有调用任何模型**。DSH 0.2.1-rc.2。
- `asar:` 指 `app.asar` 里的 `dsh/node_modules/@deepseek-ai/<包>/lib/index.js`。
- `bot/` 指 `<desktop-profile>/node_modules/ds-bot/`。
- `ops/` 指同目录下的 `dsh-ops/`。

## 0. 短版结论

1. 调模型参照 compaction-basic 的写法，**但不能抄它的“回退到当前会话的模型”**：Reducer 没配 provider/model 就不发请求。【已核实】
   - report.md 3.2 定了不 import `@deepseek-ai/*`。第 1 节的 `BlockAssembler` 写法只作参照，实际直接读流，chunk 形状见第 5 节。
2. post-execute **没有任何超时**。Reducer 的延迟会直接卡住这一步，所以必须自己加超时。【已核实】
3. post-execute 的监听**抛错会让整个工具结果变成 isError**。Reducer 必须全程 catch，出错就原样交回。【已核实】
4. ds-bot 的 secrets 钩子**也作用在插件自己发的请求上**，而且送进来的日志已经脱过敏。必须设置 `purpose`，否则在群会话里请求可能被 ds-bot 的群转发钩子截走。【已核实：钩子条件；推断：截走后的具体表现】

## 1. 调模型的最小写法

照 `asar:dsh-compaction-basic:292-337`：

```js
import { BlockAssembler } from '@deepseek-ai/dsh-llm'   // 导出见 asar:dsh-llm:2429

const assembler = new BlockAssembler()
const options = {
  provider: cfg.provider, model: cfg.model,             // 只从配置读，缺一个就不发
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  maxTokens: cfg.maxTokens,
  purpose: 'dsh-sol-reducer',
  signal,                                                // 见第 3 节
}
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
// assembler.finish.kind 为 error / aborted / max-tokens 时都算失败（照 compaction 的 finishError，:358-369）
const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
const usage = assembler.usage                            // 收到 usage 块以前一直是 undefined
```

- `usage` 来自流里的 `usage` 块（`asar:dsh-llm:998`），getter 在 `:1097-1099`。`finish` 的默认值是 `{kind:"stop"}`（`:1101-1103`）。【已核实】
- compaction 在 provider 没配时，会回退到当前会话的模型（`:293-303`）。**Reducer 不能这样做**：没有显式配好 provider 和 model，就不发请求（群公告、report.md 3.5）。【已核实：compaction 的回退逻辑】
- 只把日志发出去，不带对话前缀，也不带 `tools`/`toolHistory`。compaction 带它们是为了复用缓存，Reducer 带上就等于把整段对话外发了。【推断：设计要求】
- `purpose` 是自由字符串，dsh-llm 本身不检查（`lib/index.js` grep 0 命中）。ds-bot 会读它，见第 4 节。【已核实】
- 这次调用不进会话日志，`dsh-token-meter` 只看 assistant 事件（`asar:dsh-token-meter:369-373`），读不到它。Reducer 按 `usage` 自己往账本记一行 `kind:"reducer"`，和 report.md 2.3 一致。【已核实】
- 插件不用声明对 `@deepseek-ai/dsh-llm` 的依赖，运行时从安装目录解析（dsh-plugin-guide README:116）。【已核实：文档说法；推断：外部插件 import 能成功，第 1 步装进 profile 时才能验证】

## 2. 怎么识别诊断命令

| shell | 工具名 | 命令字段 | 依据 |
|---|---|---|---|
| 宿主 pwsh | `pwsh` | `command`（必填），另有必填的 `description` | `asar:dsh-tool-pwsh:464-478`【已核实】 |
| dsh-ops bash | `publicToolName('bash')`，本机实际叫 `ops_bash` | `command` 或 `script_path`，二选一 | `ops/lib/shells.js:63`、`:967-978`【已核实】；名字是 `ops_bash` 是看现有工具列表得出的【推断】 |

- 用 `exec.name` 判断是哪种 shell，命令在 `exec.arguments.command` 里。给的是 `script_path` 时没有命令文本，只能按结果判断，不能按命令判断。
- 工具名列表复用 `actionFusion.shells`，代码里不写死 dsh-ops 的名字（report.md 3.7）。【推断：设计建议】
- 跑没跑、成没成，直接复用 Fusion 的 `classify(result)`（report.md 2.1，step2-facts.md）。建议 v1 只压“`failed` 并且文本超过阈值”的结果。按命令内容匹配（比如 test、build）留到以后，不做。【推断：设计建议，最简单】

## 3. signal、超时、取消

- post-execute 里 `exec.signal` 一定有值：`createExecution` 必然带上它（`asar:dsh-tools:3235`），工具执行完以后恢复成调用方的 signal（`:3401`、`:3413`）。【已核实】
- **post-execute 外面没有任何超时**。`timeoutMs` 只出现在工具定义和 PTC 里，`postExecute`（`:3600`）直接 `await` 整条 waterfall。【已核实】
  - agent-loop 在 `commitReady` 里逐个 `await finalize`（`asar:dsh-agent-loop:566-571`），所以 Reducer 有多慢，这一步就卡多久。【已核实】
  - Reducer 要自己组合 signal：`AbortSignal.any([exec.signal, AbortSignal.timeout(cfg.timeoutMs)])`，默认值建议给小一点，比如 20 秒。【推断：数值】
- 调用方在 post-execute 期间取消时，成功结果会被换成取消结果（`:3465`），Reducer 的产出被丢掉，这是正常的。Reducer 不要抛错。【已核实】
- **监听抛错，整个工具结果变成 isError**：`finalizeScheduledExecution` 的 catch 会转成 `toolErrorResult`（`:3467`）。所以超时、模型报错、引文校验失败，一律 `return decision`，原结果照交，账本记一行 `reducer-fallback`（防护规则 3）。【已核实】
- 注册顺序和 ObservationPack 一样，都普通注册。按 report.md 的约定，Reducer 要先于 ObservationPack 处理。在同一个 waterfall 里，**后注册的监听在更里层，会先拿到结果**，所以 index.js 里要先注册 ObservationPack，再注册 Reducer。更简单的做法是两个模块共用一个监听，在里面按顺序调用。【已核实：waterfall 机制，见 step3-facts 第 2 节；推断：建议】

## 4. ds-bot 的钩子会不会作用到我们的请求

| ds-bot 钩子 | 条件 | 对 Reducer 的影响 | 依据 |
|---|---|---|---|
| secrets（llm/stream） | 只要登记过密钥就生效，**不看 sessionId，也不看 purpose** | 会作用。含密钥时脱敏后重发一遍 | `bot/src/host/secrets.js:465-473`【已核实】 |
| secrets（tools/execute） | 同上 | 送到 Reducer 手里的日志已经脱过敏 | `:444-457`；时序见 step3-facts 第 3 节【已核实】 |
| images（llm/stream） | 有 sessionId 并且消息里带图片时才生效 | 纯文本请求不受影响 | `bot/src/host/images.js:179`【已核实】 |
| groups 转发（llm/stream） | 有 sessionId、**没有 purpose**、并且是群会话时，接管请求 | 设置了 `purpose` 就直接放行 | `bot/src/host/groups.js:846`【已核实】；不设会怎样：请求可能被合成成一次空的转发回复【推断】 |

建议：
- 一定设置 `purpose: 'dsh-sol-reducer'`。
- **不传 sessionId**。不传的话，images 和 groups 两个钩子都直接跳过，少两层干预。secrets 钩子照样生效。代价是 provider 那边可能按会话复用缓存，不传就用不上；Reducer 本来就不带对话前缀，影响很小。【推断】
- ds-bot 只能抹掉它登记过的密钥。日志里其他敏感内容（内网地址、路径、别人的 token）照样会发出去。所以“必须显式配置 provider 和 model 才外发”这条安全边界不能放松，README 里要写明这一点。【推断】
- 重发会让 `llm/stream` 多走一遍，但 Reducer 的用量只在自己读流时取一次，不会重复计数。【已核实：用量只在插件自己这一侧读】

## 5. 不用 BlockAssembler：直接读 `ctx.llm.stream` 的流

`ctx.llm.stream(options)` 返回一个异步可迭代对象，用 `for await` 逐个读 chunk（`asar:dsh-llm:2393-2397`）。chunk 一共 7 种，以 `BlockAssembler.push` 的 switch 为准（`asar:dsh-llm:964-1005`，`default` 分支是 `assertNever`，说明就这 7 种）【已核实】：

| `chunk.type` | 字段 | Reducer 怎么用 |
|---|---|---|
| `block-start` | `index`、`blockType`（`text`/`reasoning`/`tool-call`） | 记住哪些 index 是 text |
| `text-delta` | `index`、`text` | 按 index 累加 `text` |
| `reasoning-delta` | `index`、`text` | 忽略，不算进摘要 |
| `tool-call-delta` | `index`、`id`、`name?`、`argumentsDelta` | 不传 tools，按理不会出现；出现就算失败 |
| `block-end` | `index`、`block`（完整块，比如 `{type:"text", text}`） | **以它为准**：有 block-end 的 index，用 `block.text` 覆盖累加值。BlockAssembler 在 delta 分支里先查 `partial.block`，已经收到 block-end 就忽略（`:976-981`、`:983-984`），`assemble` 也优先用 `partial.block`（`:1020-1021`） |
| `usage` | `usage: {inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?}` | 记账本。缓存字段只在非 0 时出现（`asar:dsh-llm-pi-ai:1439-1447`）；token-meter 也是按缺省 0 处理（`asar:dsh-token-meter:326-331`） |
| `finish` | `reason: {kind, failure?}`、`replayState?` | 判断成败，见下 |

`finish.reason.kind` 的取值：
- `stop`：正常结束。【已核实：`asar:dsh-llm-pi-ai:1481-1489`】
- `max-tokens`：被 maxTokens 截断（`:1490`）。Reducer 当失败，因为摘要不完整，compaction 也这么处理（`asar:dsh-compaction-basic:362-366`）。
- `tool-calls`（`:1491`）：不传 tools 就不该出现，出现当失败。
- `error`、`aborted`：带 `failure: {message, code}`（`asar:dsh-llm:2401-2413`、`:402-410`）。

**流怎么结束、出错怎么表示**【已核实】
- 正常情况：先来一个 `usage` chunk，再来一个 `finish`，然后流结束（`asar:dsh-llm-pi-ai:1627-1638`）。
- 适配器选择、派发、迭代出错，**不抛异常**，而是变成一个 `finish{kind:"error"|"aborted"}` 的 chunk。signal 已经取消，或者错误码是 `ABORTED` 时，归为 `aborted`（`asar:dsh-llm:2401-2413`，函数说明见 `:2384-2390`）。
- 出错时也会先给一个 `usage` chunk（`asar:dsh-llm-pi-ai:1639-1648`）。**失败的请求同样要记 usage**，否则成本会少算。
- 中间件、嵌套调用、清理和消费方自己的错误**仍然会抛出**（`:2384-2390`）。ds-bot 的 secrets 钩子就是嵌套调用。所以 `for await` 外面必须包 try/catch。
- 流结束了却没收到 `finish`：BlockAssembler 默认当成 `{kind:"stop"}`（`:1101-1103`）。Reducer 应该更严格：没收到 finish 就算失败，原结果照交。pi-ai 适配器在这种情况下会抛 `STREAM_CLOSED`（`asar:dsh-llm-pi-ai:1650`）。【已核实：两处行为；推断：严格处理这一条是建议】

**参考写法**【推断：照上面的形状写的，没运行过】

```js
async function callReducer(ctx, cfg, prompt, signal) {
  const texts = new Map()          // index -> text
  const done = new Set()           // 收到 block-end 的 index
  let usage, finish
  for await (const c of ctx.llm.stream({
    provider: cfg.provider, model: cfg.model, maxTokens: cfg.maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    purpose: 'dsh-sol-reducer', signal,
  })) {
    if (c.type === 'text-delta' && !done.has(c.index)) texts.set(c.index, (texts.get(c.index) ?? '') + c.text)
    else if (c.type === 'block-end') { done.add(c.index); if (c.block.type === 'text') texts.set(c.index, c.block.text); else texts.delete(c.index) }
    else if (c.type === 'tool-call-delta') return { ok: false, usage, reason: 'unexpected tool call' }
    else if (c.type === 'usage') usage = c.usage
    else if (c.type === 'finish') finish = c.reason
  }
  if (finish?.kind !== 'stop') return { ok: false, usage, reason: finish?.failure?.message ?? finish?.kind ?? 'no finish chunk' }
  const text = [...texts.keys()].sort((a, b) => a - b).map(i => texts.get(i)).join('')
  return { ok: text.trim() !== '', usage, text }
}
// 调用方：外层 try/catch，返回 ok:false 或者抛错，都原样交回原结果，账本记一行 reducer-fallback，带上 usage
```

- 要不要单独建一个 `text` 类型的块表、只收 text 类型，看 `block-start.blockType` 就行。有的适配器只发 delta，不发 block-start/end（BlockAssembler 的类说明里写了这一点，`asar:dsh-llm:949-952`），所以上面的写法只按 `text-delta` 和 `block-end` 收，不依赖 block-start。【已核实：说明原文】
- 假 ctx 的 `llm.stream` 要照这个形状写，返回 async generator，至少要覆盖四种情况：正常的 `usage`+`finish:stop`；只有 delta 没有 block-end；`finish:error` 前面带 usage；流中途抛错。
