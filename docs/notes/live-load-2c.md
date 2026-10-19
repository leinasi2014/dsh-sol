# 真机验证 2c：Reducer（和 dsh-ops 一起装）

> 公开版说明：真机证据包（tgz、截图、会话日志）和远端环境配置是内部资料，没有放进公开仓库；文中的机器、路径、账号都换成了占位符。

日期：2026-10-19。执行人：Researcher。复核：SolQA（待做）。

只写“能不能压、有没有按规则放弃”，不写省了多少。

## 证据位置

- run：云主机 `<lab>\runs\20261019-0215-researcher-stage2c\`，本机打包以 v2 为准：[20261019-0215-researcher-stage2c.v2.tgz]（sha256 `17b57c00da1b…`）。v2 只比 v1 多了 result.txt 末尾的逐次调用耗时（照 SolQA 的要求，从 check 文件抄进来）和 cmd.txt 的对应命令。
  - `MANIFEST.txt`：机器、DSH 0.2.1-rc.2、node、profile（dsh-sol link + dsh-ops 0.3.0）、模型、reducer 配置、dsh-sol 15 个运行时文件（r5，云主机上逐一核对一致）和全部输入的 sha256。
  - `c-main-check.txt`、`d-timeout-check.txt`：`s2c-check.mjs` 的输出（每次调用的字节数、标记、耗时；账本行；存档和引文的独立核对）。
  - 每个场景的完整会话日志、账本和 objects 拷贝、截图。
- 环境和 2b 一样，没改。模型 `zai-coding-cn` / `glm-5.3-flash` / high，测试窗口 200000 / 16384。
- Reducer：`provider: zai-coding-cn`、`model: glm-5.3-flash`、`timeoutMs: 60000`（超时场景用 1000）。外发的只有云主机上生成的测试文本。
- `observationPack.thresholdBytes` 这次是 1024（2a/2b 是 2048），这样 1.2 KB 的回执高于阈值，才能测“回执不被换成占位符”。

## 结论

| # | 场景 | 结论 | 证据（`c-main-check.txt` / `d-timeout-check.txt`） |
|---|---|---|---|
| 1 | 失败、20127 字节（8–30 KB），没截断 | **压了**【已核实】 | 账本 `reducer` 行：sourceBytes 20127 → receiptBytes 1212，3 条证据，`uncertain: false`，usage 5887 入 / 142 出。模型看到的是带 `dsh-sol_evidence_receipt_v1` 的回执。存档 `objects/24eb9925….txt` 存在，sha256 = `sourceSha256` = `archiveKey`，回执里写了这个 key。回执里 3 条引文我用脚本独立核对过，全部是存档的逐字子串 |
| 2 | 失败、超过 64 KB，被 ops_bash 截断 | **放弃了**【已核实】 | `reducer-fallback`，reason `the output was truncated`。结果由 ObservationPack 换成占位符（64152 字节，带 `[output truncated; full output: …]`）。2b 的推断在真机上确认了 |
| 3 | 成功、20000 字节 | **不触发**【已核实】 | 没有 reducer 相关的账本行，只有 ObservationPack 的 `observation` 行 |
| 4 | 失败、844 字节（不到 4 KiB） | **不触发**【已核实】 | 没有 reducer、observation 行，模型看到原文 |
| 5 | 失败、带假密钥 `<fake-aws-key>` | **没外发**【已核实账本，“没发请求”是推断】 | `reducer-fallback`，reason `likely-secret`，没有 usage。`shouldReduce` 在调模型之前就返回了（`reducer.js:228`）。这次调用 1381ms，和不调模型的调用（1228–1346ms）一样，也支持“没发” |
| 6 | `timeoutMs: 1000` | **超时放弃、原文保留**【已核实】 | `reducer-fallback`，reason `model-call-timeout`，没有 usage。原文存进了存档，模型看到的不是回执，而是 ObservationPack 对原文的占位符 |
| 7 | Reducer 的回执不被 ObservationPack 再替换 | **成立**【已核实】 | 场景 1 的回执 1212 字节，高于 1024 的阈值，但这个 callId 没有 `observation` 行，模型看到的就是回执 |

**耗时**（会话事件的 `time` 字段，从 tool/call 到 tool/result）【数字已核实，拆分是推断】：
- 不经过 Reducer 的 ops_bash 调用：1228–1381ms。
- 场景 1（压成功）：4761ms，推断其中调模型大约 3.4 秒。
- 场景 6（1 秒超时）：3145ms，比 1000ms 长，推断包含存档写入和中止的收尾时间。
- 每轮墙钟时间在 result.txt：32–44 秒（含 18 秒稳定判断窗口）。

**存档原文 = 命令真实输出**【已核实，本机独立重算】：按命令重新生成 500 行 + 失败三行，再按 ops_bash 的渲染规则拼上 `\n[exit code: 1]`（`dsh-ops:lib/shells.js:855-862`），20127 字节，sha256 `24eb9925c463…`，和存档逐字节相等。超时场景的存档是同一个对象（同一 sha256）。

**场景 6 和 SolQA 复核标准 ③ 的出入**【已核实】：超时以后 Reducer 确实放弃了、原文进了存档，但模型看到的不是原文全文，而是 ObservationPack 的占位符（`obs_076e655e…`，20127 → 1395 字节）。原因是 Reducer 放弃以后，结果照常往下交给 ObservationPack，而 20127 字节高于它的阈值 1024。这是现在的设计（`index.js` 里两者串在同一个 post-execute 上，Reducer 在前）；原文可以用 `obs_recall` 逐字取回。要不要改成“Reducer 放弃时 ObservationPack 也不动”，请 SolQA / SolArch 定。

**两个场景都没有报错**：`c-main-server.err`、`d-timeout-server.err` 都是 0 字节。

## 发现的问题（请 SolDev 看，不挡路）

- **Reducer 的账本写入没有 await**【已核实，看代码】：`reducer.js` 里 `record({...})` 都包在 `try { record(...) } catch {}` 里，但没有 `await`（`:641`、`:668`、`:698`、`:725`、`:757`、`:775`、`:802`）。`record` 是 async 函数，抛错会变成未处理的 Promise 拒绝，catch 接不住。和 SolDev 之前修的 `obs_recall`、`occ` 那两处是同一类。这次真机上 7 行都写进去了，没出问题。
- 超时和密钥两种 fallback 都不带 usage，因为没拿到回复或没发请求，这是对的。但账本里没有“发出请求的时间/耗时”，A/B 想算 Reducer 的延迟成本只能从会话事件里减。可以考虑在 `reducer` 和 `reducer-fallback` 行里加一个 `elapsedMs`。

## r6 回归（2026-10-19 06:09，pickShell 探测 + reducer 补 await）

- 代码：和 2c 用的 r5 相比变了 `lib/fusion.js`（`b046774f4aed…`）和 `lib/reducer.js`（`a502f6e4f8a0…`）。云主机副本 15 个文件逐一核对一致；本机 `node --test` 438 条全过。
- run：云主机 `<lab>\runs\20261019-0609-researcher-r6-regression\`，本机 [20261019-0609-researcher-r6-regression.tgz]（sha256 `cd8ae5738273…`）。环境、模型和 2c 一样。
- 结果【已核实，`r6-events.txt`、result.txt】：
  - 默认 shells（ops_bash 排第一）：`write_then_run` + `cat` → `[then_run:succeeded]`。新的探测没有把 ops_bash 误判成“读不懂”。
  - 同一会话 ops_bash 失败 20127 字节 → 账本 `reducer` 行（receiptBytes 1105，2 条证据），模型看到回执。补了 await 以后压缩路径照常。
  - `shells: [pwsh]`（只给内置 pwsh，它的 output schema 是 `oneOf`、没有顶层 `type`）：`[then_run:succeeded]`，嵌套 job `callId=…:sol:2`、`rootCallId` 等于外层 callId，`detail="exit code: 0"`。新的探测把内置 pwsh 也认成了能读的 shell。
  - 两个场景的 server.err 都是 0 字节。

## 没做的

- 回执校验失败的几种 fallback（`invalid-json`、`unverifiable-quote` 等）在真机上没造出来：要模型给出坏回执，不好控制。单元测试覆盖。
- 其他 preset。
