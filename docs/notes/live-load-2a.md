# 真机验证 2a：Fusion、ObservationPack、OCC、Meter 在真实 DSH 里生不生效

> 公开版说明：真机证据包（tgz、截图、会话日志）和远端环境配置是内部资料，没有放进公开仓库；文中的机器、路径、账号都换成了占位符。

日期：2026-10-18。执行人：Researcher。复核：SolQA 已复核，2a 通过。

只写“能不能用、有没有生效”，不写省了多少。Reducer 没开。

## 证据位置

- 正式 run：云主机 `<lab>\runs\20261018-2313-researcher-stage2a-r2\`，本机打包 [20261018-2313-researcher-stage2a-r2.tgz]（sha256 `bdfc7c0bde03…`）。
  - `MANIFEST.txt`：机器、DSH 0.2.1-rc.2（exe 和 cli）、node、profile、模型和窗口、各阈值、dsh-sol 15 个运行时文件和全部输入的 sha256。
  - `cmd.txt`：每一步命令，包括分析命令。`result.txt`：原始输出。
  - 每个场景：`<场景>-session-<sid>.jsonl`（完整会话日志，已解压，令牌已脱敏）、`<场景>-dshsol-<sid>\`（账本和 objects 原样拷贝）、`<场景>-tools-<sid>.txt`、每轮截图和页面文字。
  - `c-obs-check.txt`：ObservationPack 分页拼接的哈希校验。`meter-check.txt`：Meter 和原生 usage 的逐轮对账。
- 第一轮 run `<lab>\runs\20261018-2250-researcher-stage2a\`（只在云主机上）：用修复前的代码跑出 ObservationPack 不生效，见下面“修复前”。
- 被测代码：本机工作区（未提交），包含 SolDev 23:10 的修复。和阶段 1 相比变了 `index.js`、`lib/observation.js`、`lib/occ.js`。云主机副本 15 个文件逐一核对 sha256，全部一致。本机 `node --test` 424 条全过。

## 环境和测试设计

- web 服务改由计划任务 `lab-web` 在 <test-user> 的桌面会话 1 里启动（`s2-web.ps1`），不再从 SSH 会话起。每个场景的 result.txt 第一行都有 `session=1`。
- 模型全程不换：`zai-coding-cn` / `glm-5.3-flash` / `reasoningEffort: high`。
- **窗口改成测试值**（偏离 Chief 原话的“按 GLM 的窗口算”）：catalog 里是 1M。按 OCC 的公式，留尾 `0.16×(W−O)` 必须小于 occ 触发线才可能压，1M 下要超过约 139K token 才可能出现 `would-compact`。所以 overlay 把它声明成 `contextWindow: 200000`、`maxTokens: 16384`：
  - 原生触发线 `min(0.8W, W−O−65536)` = 118080；
  - occ 触发线（`thresholdRatio: 0.2`）= `min(40000, 0.85×118080)` = 40000；
  - 留尾 `floor(0.16×183616)` = 29378。
  这几个数和账本 `occupancy` 里的 `nativeThreshold: 118080`、`occThreshold: 40000` 一致。
- 每轮耗时（墙钟时间，含 18 秒稳定判断窗口）在 result.txt 的 `settled after` 行：a 38s；b 32/35/32s；c 32/35s；d 71/26s；d2 86/26s；e 86/26s；e2 149/26s。

## 结论

| # | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 0 | 前置：桌面会话里 pwsh 能不能跑 | **能**【已核实】 | 第一轮 run `a-pwsh`：exit 0，输出 `pwsh-ok`。阶段 1 的 0xC0000142 确实是因为服务从 SSH 会话起 |
| 1 | Fusion 三种结果 | **生效**【已核实】 | `b-fusion` 同一会话三轮：`[then_run:succeeded]`；`exit 3` 得到 `[then_run:failed]`；`then_run` 多带 `bogus` 键时直接报 `invalid then_run: unknown key "bogus"; this tool accepts command, timeout`。f3.txt 前后 sha256 都是 `4a31f8a329cd…`（MANIFEST 记的值），没被改。Fusion 不写账本 |
| 2 | ObservationPack 替换和回读 | **生效**【已核实】 | `c-obs`：300 行、16500 字节的 pwsh 输出，模型看到的是 1414 字节的占位符。账本有 `observation` 行（`archiveKey` 等于 objects 下文件名，也等于文件内容的 sha256）。`obs_recall` 回读 2 页（15872 + 628 字节），账本有 2 行 `observation-recall`。两页拼起来、objects 文件、独立重新生成的原输出，三者 sha256 都是 `06e5bf6d62e3…`（`c-obs-check.txt`） |
| 3a | OCC dry run | **生效**【已核实】 | `d2-occ-dry`：每个过线或过边界的步骤都记了 `occ-dry`，第 8、10 步是 `would-compact`。会话里没有 `compaction/start`，没被压。只有原生剪枝（`compaction/prune`）。第 2 轮模型还能答出 m1 的首行 |
| 3b | OCC 真压，压完能不能接着聊 | **生效**【已核实】 | `e2-occ-live`：第 8、10、12 步各压了一次。账本 3 行 `occ` 的 `compactionId` 和会话日志 #56/#74/#90 的 `compaction/start` 一一对应。第 2 轮正常回答（“checkpoint summary 只保留了 m1 的最后一行”）。会话可以接着聊，压掉的细节确实丢了 |
| 3c | OCC 压完任务还能不能做对 | **能**【已核实，SolQA 复核时补】 | turn 1 的最终回复 `m5 0500 8f7d945aa97e…`（会话 seq 96）出现在第 3 次压缩之后。它和云主机上 `Get-Content m5.txt -Tail 1` 的结果一致，和本机用生成规则 `sha256("m5-500")` 独立算出的结果也一致。turn 2 模型原话是 "I no longer have it. The checkpoint summary preserved only m1's last line"，说明压缩确实生效了 |
| 4 | Meter 和原生 tokenUsage 对账 | **一致**【已核实】 | `meter-check.txt`：6 个会话、13 个回合逐轮比对，四个桶、`requests`、`compaction`、`compactionCalls` 全部相等，包括 e2 的 3 次压缩（81373 / 2016）。原生一侧用的是 `assistant/message` 和 `compaction/summary` 事件上的 `usage` |

**2026-10-19 补注**：第 0 行那句只对 5.1 回退成立（当时全盘没有 `pwsh.exe`，`dsh-pwsh-local` 走的是 `System32\WindowsPowerShell\v1.0\powershell.exe`）；装上 PowerShell 7 并放宽沙箱 preset 后，SSH 直起可用，不再需要桌面会话，见 [live-load-1.md](live-load-1.md) 的 2026-10-19 更正。

## 修复前（第一轮 run，已由 SolDev 修好）

- ObservationPack 存档写了，但替换没发生，模型看到的是全文。原因是 `index.js` 的 `createRecordSink` 把没解析的 `meter.home`（undefined）传给了 `appendLedgerRecord`，`path.join` 抛错后按“出错就让路”保留了原结果。`occ.js` 也是同样的写法；`obs_recall` 注册时漏传了 `record`。SolDev 修了这几处，另外把两处 fire-and-forget 的账本写入改成了 await（`step45-wiring.md` 第 13 节）。修复后重跑就是上面的 r2。

## 发现的问题和观察（不挡路，请 SolArch/SolDev 判断）

1. **`no-range` 不说是哪种原因**【已核实现象，原因是推断】：
   - 第一版 OCC 场景（`d`/`e`，3 个文件，每个分两次读）两次过边界都是 `no-range`，一次都没压。
   - 改成 5 个文件、每个一次读完（`d2`/`e2`），第 3 个边界起就能压。
   - 推断原因是留尾 29378 吃掉了边界前几乎全部的历史，`selectRange` 返回 null。但账本里分不清是“取不到引擎”（`occ.js:301`）、“留尾不小于触发线”（`:293-294`），还是“选不出范围”（`:309`）。建议这三处分别记不同的 reason。
2. **压缩范围的 start 大于 end，这是正常的**【已核实，SolArch】：e2 第二、三次压缩的 range 是 `{start:58, end:32}` 和 `{start:76, end:43}`。`compactRegion` 是按 surface 位置比较的（`asar:dsh-compaction-basic/lib/index.js:549-556`）。压完以后，checkpoint 节点的 seq 最大，却排在原来那段的位置上（`:664-673`）。原生事件里的 `shadowedRange` 就是这个值，账本是照抄的（SolQA 核对过）。不用改。
3. **第一次压缩不划算**【已核实数字，结论是推断】：e2 第 8 步那次只压掉 827 token（6 个节点，引擎回报的 `shadowedTokenCount` 也是 827），却付了一次摘要调用。三次压缩合计花了 81373 输入 + 2016 输出。v1 有意不做经济性判断（`occ.js:10-14`），留给 A/B。
   - 推断原因：占用（88928）是“上次请求的真实 usage + 增量”（`dsh-token-meter/lib/index.js:735-743`），但留尾和 range 是按节点的启发式 token 累加的（`:620-627`）。十六进制内容的真实 token 大约是启发式估算的 2 倍，所以 29378 的留尾实际盖住了大约 6 万真实 token。原生选范围也用同一套 meter 节点。写 A/B 方案时，不能拿“真实占用减留尾”来估能压多少。
3b. **摘要的进度落后一拍**【已核实现象，SolQA 发现】：第 2 次压缩发生在 read m4 之后，摘要却写“next is m2”；第 3 次发生在 read m5 之后，摘要写“next is m3”。推断是摘要只看到了被压掉的那段，留尾里更新的进度它看不到。这是 DSH 原生摘要的行为，不是 dsh-sol 造成的，但压缩后模型可能会被误导。这一次没出问题，turn 1 的答案是对的。
4. **原生剪枝和 OCC 的读数**：OCC 的占用是剪枝前的数（`pruned: false`）。d/d2 里过了原生触发线 118080 后，原生剪枝把大的 read 结果遮掉，下一步占用就掉到 2 万多。行为和 `step5-facts.md` 10.3 c 写的一致。
5. **测试脚本的坑**：e2 那次点“新会话”后，DSH 复用了 20:42 留下的一个空草稿会话（`session-feb18832…`，之前 0 个回合）。`s2-run.ps1` 只找新建的文件，所以报了 `new sessions: 0`。证据是我手动导出的（cmd.txt 有记录）。会话里 turn 1 就是本次第一轮，不受影响。下次改成按修改时间找。

## 没做的

- Reducer（等用户定模型）；和 dsh-ops 共存（2b）；除 web 默认 preset 以外的 preset。
- 计划任务 `lab-web` 留在云主机上给以后用（LOG.md 有记录和撤销方法）。**2026-10-19 补**：现在 SSH 直起即可用（装上 PowerShell 7 并放宽沙箱 preset 之后），计划任务不再是必需的；这条留作备选手段。
