# dsh-sol 与 dsh-ops / ds-bot 的兼容性，以及插件规范符合度

范围：desktop profile 里的 dsh-ops 0.3.0、ds-bot 0.1.7（`<home>\.dsh\profiles\desktop\package.json:5-24`），DSH 0.2.1-rc.2。
来源：SolArch（规范）、SolDev（运行时冲突）、SolQA（交叉复核），Researcher 对关键证据逐条抽查过原文。
路径缩写：`asar:` 指 `<DSH-install>/resources/app.asar` 里的 `dsh/node_modules/@deepseek-ai/`；`ops/`、`bot/` 分别指 profile 里 `node_modules/dsh-ops/`、`node_modules/ds-bot/`。

## 一句话结论

架构上不冲突，名字、存储路径、提示段都没有撞。规范上没有违规，只是缺“显示清单”。真正要改设计的是 4 处：OCC 在 Bot 会话里用不了；Fusion 不能写死 `pwsh`；Meter 不能包 `llm/stream`；存档必须在脱敏之后做。

## 1. 不冲突的部分【已核实】

| 项 | 结论 | 证据 |
|---|---|---|
| 工具名 | `edit_then_run`、`write_then_run`、`obs_recall` 两边都没有用；dsh-ops 的工具一律是 `ops_` 前缀 | SolDev 全文搜索；`ops/lib/file/contract.js:9-35` |
| `$DSH_HOME` 子目录 | dsh-ops 用 `dsh-ops/`，ds-bot 用 `bot/` 和 `usage.sqlite`，我们用 `dsh-sol/`，三家平级 | SolDev、SolQA |
| 清单格式 | DSH 只认 package.json 的 `dsh` 字段。`dsh-plugin.json` 在 asar 里 0 次命中，是 dsh-std 的第三方约定，没有它不算违规 | SolArch、SolQA 各扫了一遍 asar |
| 禁止项 | 不调 `appendPluginRecord`，不新增会话事件类型，不用 `internal/config` | `asar:dsh-session/README.md:68-70`；report.md:178 |
| 额外审批弹窗 | 推断不会。嵌套调用不带 `sandbox_permissions`，不会走升级审批 | `asar:dsh-tool-pwsh/lib/index.js:631`、`asar:dsh-tool-fs/lib/index.js:1123-1146` |

## 2. 必须改设计的 4 处

### 2.1 OCC：在 Bot 会话里必然失败【已核实】
ds-bot 在 `agent/created` 时把压缩引擎的 `compactIfNeeded/compactNow/compactRegion/summarize` 都包了一层。如果是 Bot 会话，`compactRegion` 直接 reject（报错 “A Bot conversation makes room on its own”），`summarize` 改去写 checkpoint。证据：`bot/src/host/parts.js:186-192`、`:201-230`。
- 我们团队的会话全是 Bot 会话，所以 OCC 在这里 100% 用不上。
- 原方案“覆写 `summarize()`”，和 ds-bot 抢的是同一个钩子，谁后包装谁生效。
- 改法：v1 只对非 Bot 会话生效。如果要在 Bot 会话里用，得先和 ds-bot 的 checkpoint 机制商量好怎么合并，这一条要用户拍板。

### 2.2 Fusion：嵌套跑命令时不能写死宿主 `pwsh`【已核实】
- 把 shellPolicy 改成 `deny-host-shell` 后，dsh-ops 会在 `tools/pre-execute` 和 `tools.guard` 里拒掉 `pwsh/bash/pwsh_persistent`（`ops/lib/config.js:35`、`ops/lib/index.js:60-62`），但 `ops_bash` 不受影响。
- 在 PTC preset 下，模型直接调用 `edit_then_run` 会被折叠成 `UNKNOWN_TOOL`，只能从 `run_code` 里调（`asar:dsh-tools/lib/index.js:3195-3196`、`:3272-3284`）。PTC 里本来就能连续调用，Fusion 在这里没有增量。
- 改法：
  - 有 `ops_bash` 就用它，没有再回退到宿主 shell。两个都用不了时，返回 `[then_run:unavailable]`。
  - 文档里写明“Fusion 只在 native preset 下有效”。
- 拒绝标记拆成两种：
  - `[then_run:denied]`：用户拒绝。
  - `[then_run:blocked]`：被策略拒绝，比如 deny-host-shell。
- 另一种失败：沙箱前置准备失败，比如 ACL 准备超时，或者 workspace 的所有者不是当前用户（`ops/lib/workspace-preparation.js:12-24`、`:47-53`）。这种情况单独报，不要混进 `[then_run:failed]`。
- 嵌套调用不经过 spill（`asar:dsh-spill-policy/lib/index.js:242`，`exec.parent !== undefined` 时跳过）。内层 shell 截断后带的 `spillPath`（`ops/lib/shells.js:845-846`），Fusion 渲染时要原样带出去。外层合并结果的 parent 为空，仍然会照常 spill。

### 2.3 Meter：不包 `llm/stream`，改用会话投影【已核实】
- ds-bot 处理 secrets 和 images 时会用新的 options 再调一次 `ctx.llm.stream`（`bot/src/host/secrets.js:473`、`images.js:188`）。包在 `llm/stream` 上会重复计数。`isAgentLoopRequest` 又是按对象身份判断的（`asar:dsh-llm/lib/index.js:378-390`），重发后的请求还会被分错类。
- 原生 `dsh-token-meter` 已经默认挂载（`asar:dsh-base/cordis.patch.yml:348-349`），只是漏了压缩那次调用的成本（`usageOf` 只认 assistant 事件，见 `dsh-token-meter/lib/index.js:369-373`；压缩用量在 `compaction/summary` 里，见 `dsh-compaction-basic/lib/index.js:634-650`）。
- 改法：Meter 只做会话投影，把 `assistant/message` 和 `compaction/summary` 一起折叠。外部插件能不能注册投影单元，第一步就要实测【推断】。不行的话，退回包 `llm/stream`，并照 ds-bot 的做法按 usage chunk 用 WeakSet 去重（`bot/src/host/usage.js:570-594`）。

### 2.4 ObservationPack 和 Reducer：存档内容必须等于模型实际看到的内容【已核实】
ds-bot 在 `tools/execute` 里用 `redactDeep` 给工具结果脱敏（`bot/src/host/secrets.js:444-457`）。如果我们在它脱敏之前存档，ds-bot 已经抹掉的密钥会以明文写进 `$DSH_HOME/dsh-sol/`。
- 改法：存档只在 post-execute 做，并加一条测试：存档内容逐字节等于最终交给模型的内容。

## 3. 补充项（不改架构）

- 改文件的覆盖面：模型日常用 `ops_replace` 改文件（`ops/lib/policy.js:55-58`），v1 只提供 `edit_then_run`/`write_then_run`，覆盖不到这条路径。是否把 `ops_replace` 也纳入，需要拍板。【已核实】
- 提示段：同名重复注册会抛错（`asar:dsh-system-prompt/lib/index.js:203`）。我们的段名统一加 `sol:` 前缀，order 用 3300 段，避开 dsh-ops 的 3250-3252 和 ds-bot 的 640/645。【已核实】
- 文件权限：`report.md:176` 写的“0700/0600”只在 Unix 上生效。Windows 上要么靠用户目录默认的 ACL，要么在文档里写明这一点。【已核实，SolQA】

## 4. 规范缺口（SolArch，已核实，依据 `asar:dsh-agent-preset/skills/cordis-plugin-development/host-plugin.md`）

`report.md:150-163` 的骨架要补：
- `exports`，包含 `.`、`./locale/*.json`、`./icon`
- `locale/en.json` 和 `locale/zh.json`，写上 `meta.title`/`meta.description`
- icon
- `files`
- 构建产物路径 `dist/`

版本闸门写 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`。一旦声明了它，peer 里的 DSH 范围就整个不再参与判断（`asar:dsh-app-boot/lib/index.js:280-311`）。

## 5. 对推荐顺序的影响

顺序不变：骨架和 Meter → Fusion → ObservationPack → OCC → Reducer。有两处调整：
- Meter 的工作量变小了，只补压缩成本和分类。
- OCC 的前提多了一条：要先和 ds-bot 定下合并方案，否则只对非 Bot 会话有用。

## 6. 需要用户拍板

1. OCC 是只做非 Bot 会话，还是和 ds-bot 的 checkpoint 合并（合并就要碰 ds-bot，或者请它的作者提供挂点）。
2. Fusion v1 要不要覆盖 `ops_replace`。
3. 实现范围：1 骨架+计量+Fusion，2 只做骨架和计量，3 先看文档。这一条还没回。

## 7. 开工定稿（2026-10-18，用户让 Chief 统筹）

上面 3 条都已定，写进了 report.md 的 3.1、3.7、4.3：
- 不关 dsh-ops，不改 ds-bot。冲突全在 dsh-sol 这一侧绕开，再加五条防护规则（report.md 3.7）。
- OCC：只做非 Bot 会话，排到最后。
- `ops_replace`：Fusion v1 不覆盖。
- 范围：骨架、计量、Fusion。

对第 2 节的修正：
- **Fusion 标记**：不拆成 denied、blocked、unavailable、沙箱失败四种，合成一个 `[then_run:not_run]` 加原因原文。用户拒绝和策略拦截都从 pre-execute 返回 `isError` 加 `Error: <原因>`，插件分不出来（`asar:dsh-tools/lib/index.js:3326-3352`），硬拆只会猜错。判断规则：拿到退出码算“跑了”，再按退出码分 succeeded 或 failed；拿不到就是 not_run。nested 调用 `ops_bash` 和 pwsh 时的结果形状，第 2 步实现时要先核实。
- **Meter**：不自己注册投影，直接读原生的 `tokenUsage` 投影（`ctx.sessionProjections.stateOf(session, 'tokenUsage')`），只补 `compaction/summary` 的 usage，每回合往账本记一行。原因有两个：原生投影已经处理了重试；自己注册的投影还得另想办法把数据读出来做 A/B（`asar:dsh-token-meter/lib/index.js:393-426`；`asar:dsh-session-projection/lib/index.js:32-42,120-131`）。
- **存档时机**：post-execute 本来就在 ds-bot 的 `tools/execute` 脱敏之后（`asar:dsh-tools/lib/index.js:3427`、`:3464`），所以存档在 post-execute 做就够了，不用复用 ds-bot 的 redact。Reducer 不读 shell 自己落盘的全文，那份没脱敏【推断】。
