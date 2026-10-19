# 真机验证 2b：dsh-sol 和 dsh-ops 一起装

> 公开版说明：真机证据包（tgz、截图、会话日志）和远端环境配置是内部资料，没有放进公开仓库；文中的机器、路径、账号都换成了占位符。

日期：2026-10-19。执行人：Researcher。复核：SolQA 已复核，2b 主体、r4、r5 全部通过，2b 可以结项。

只写“能不能用、有没有生效”。Reducer 没开。

## 证据位置

- run：云主机 `<lab>\runs\20261019-0003-researcher-stage2b\`，本机打包 [20261019-0003-researcher-stage2b.tgz]（sha256 `8361bc8e3da4…`）。
  - `MANIFEST.txt`：机器、DSH 0.2.1-rc.2、node、profile、dsh-ops 来源和 4 个包的 registry integrity、dsh-sol 15 个运行时文件和全部输入的 sha256。
  - `cmd.txt`、`result.txt`、`profile-before\`（装 dsh-ops 之前的 web profile）、`dump-after-install.yml`。
  - 每个场景：完整会话日志 `<场景>-session-<sid>.jsonl`、账本拷贝、工具列表、截图。`g3-nested.txt` 是嵌套调用的检查输出。
- 被测代码：本机工作区（未提交），包含 SolDev 拆分 `no-range` 的改动。和 2a-r2 相比只变了 `lib/occ.js`（`f1d6983fc361…`），云主机副本 15 个文件逐一核对，全部一致。
- 模型和 overlay 和 2a 一样：`zai-coding-cn` / `glm-5.3-flash` / high，测试窗口 200000 / 16384。

## dsh-ops 的来源【已核实】

- npm 公开包 `dsh-ops@0.3.0`，`repository` 是 `github.com/T-Auto/dsh-ops`，维护者 autofx。版本和本机 desktop profile 里装的一样（本机 `node_modules\dsh-ops\package.json:3`）。
- 用 DSH 自带的 `dsh plugin --profile web add dsh-ops@0.3.0` 装，背后是 pnpm 从 registry.npmjs.org 下载。pnpm 报 `Lockfile passes supply-chain policies`。
- lockfile 里 4 个包（dsh-ops 和 3 个 `@dsh-ops/*-win32-x64@0.2.1`）的 integrity 和 `npm view` 查到的完全一致（`result.txt` 的 `lock:` 行）。
- 装完 `shellPolicy: advise`（dsh-ops 默认值，没改）。

## 结论

| # | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 两个一起装，有没有报错和警告 | **没有**【已核实】 | 所有场景的 `*-server.err` 都是 0 字节，server.log 里没有 warn/error。插件页没看（只看了日志） |
| 2 | 工具数，有没有重名 | **36 → 39，没重名**【已核实】 | dsh-sol 全关（`a-off`）：36 个，就是 2a 的 31 个加 dsh-ops 的 `ops_bash`、`ops_glob`、`ops_grep`、`ops_inspect_local_file`、`ops_replace`。开 Fusion 和 ObservationPack（`b-on`）：39 个，多了 `edit_then_run`、`write_then_run`、`obs_recall`。工具名逐个列在 `*-tools-*.txt`，没有重复 |
| 3 | 卸掉 dsh-sol，dsh-ops 的工具少没少 | **一个没少**【已核实】 | `l-nosol`：36 个，名单和 `a-off` 完全一样。卸载 exit 0，bundles 只剩 dsh-ops。之后已经用 `link:` 装回去了 |
| 4 | Fusion 走 ops_bash | **走了**【已核实，shell 名是间接证据】 | `g3-ops`：`cat s2/g4.txt` 返回 `[then_run:succeeded]` 和 `hello-ops`。`seq` 能跑、stderr 是 `/usr/bin/bash: line 1: …`、截断提示的格式和 `dsh-ops:lib/shells.js:845-847` 一样，说明用的是 ops_bash 而不是 pwsh。会话日志只存模型看到的文本，不存 Fusion 结果里的 `shell` 字段，所以没有直接写着 ops_bash 的那一行 |
| 4a | 嵌套 job 的 rootCallId | **不适用**【已核实】 | ops_bash 不注册 job，整个会话里没有 `job/*` 事件（`g3-nested.txt`）。rootCallId 只有 pwsh 那条路有（阶段 1 已核实） |
| 4b | 截断时 spillPath 原样带出 | **带出了**【已核实】 | `g3-ops` 第 2 条（2000 行）：结果里有 ops_bash 原文 `[output truncated; full output: <home>\AppData\Local\Temp\dsh-subprocess-…-stdout.log]`。外层合并结果又被 DSH 自己 spill 了一次（`Full formatted result stored at: …dsh-spill-…\…-write_then_run.txt`），和 `compat-dsh-ops.md:39` 写的一致 |
| 5 | load-check 第 6 项：嵌套调用走真实沙箱 | **走了**【已核实】 | `g3-ops` 第 3 条 `echo outside > <lab>/outside-2b.txt`：bash 报 `Permission denied`，还带了 dsh-ops 的 `[POLICY_DENIED: User authorization does not permit command file effects in DSH mode workspace-write …]`。文件确实没写出来（`dir` 找不到）。Fusion 标的是 `[then_run:failed] exit code: 1`：命令启动了、退出码是 1，按 `fusion.js:225-236` 的规则就是 failed，不是 not_run |
| 6 | ops_bash 大输出，ObservationPack 还能不能换，有没有 truncated | **能换；超过 64000 字节会带 truncated**【已核实】 | `i2-obs-ops`：300 行（16200 字节）换成 1400 字节的占位符，账本有 `observation` 行，结果里没有截断提示。2000 行（按每行 54 字节算是 108000 字节）被 ops_bash 截到 64137 字节、1188 行，也被换成了占位符，但存档和占位符尾部都带着 `[output truncated; full output: …]` |

**第 6 项对 Reducer 的影响**【推断，依据是代码】：Reducer 看到 `[output truncated; full output:` 就不压（`reducer.js:146`、`:227`，记 `reducer-fallback`，reason 是 `the output was truncated`）。ops_bash 的截断线是 64000 字节（`dsh-ops:lib/shells.js:79`、`:1077`）。所以装了 dsh-ops 以后，Reducer 只对 4 KiB 到约 64 KB 之间的失败输出起作用，更大的日志会原样保留、只走 ObservationPack。这条要等 Reducer 开了以后真机确认。

## 发现的问题

1. **Fusion 把“ops_bash 根本没起来”标成了 succeeded**【已核实，真 bug】
   - 现场：第一次跑（`g-ops`，会话 `session-799bd5f6…` #19/#33/#47）时 ops_bash 起不来。三条结果都写着 `[then_run:succeeded]`，紧跟着是 `(no output)` 和 `[error: bash could not be started: … Workspace is not owned by the current user …]`。
   - 原因：ops_bash spawn 失败时返回的 value 里有 `error`、没有 `exitCode`（`dsh-ops:lib/shells.js:1098-1105`）。`classify` 只看 `exitCode`，没有 exitCode 就当成功（`fusion.js:235`）。
   - 建议：`classify` 里 `value.error` 存在时返回 `not_run`，`reasonOf` 用 `value.error` 当原因。模型看到 succeeded 会以为测试过了，这比标错成 failed 更危险。
2. **云主机环境问题，已修**：`<lab>\tmp` 的所有者是 Administrators（SSH 以管理员令牌建的目录）。ops_bash 的沙箱拒绝给不归当前用户所有的工作区自动配 ACL。我把 `<lab>\tmp` 递归改成 <test-user> 所有（LOG.md 有撤销方法），之后 ops_bash 正常。真实用户机器上工作区一般归用户自己，推断不会遇到。
3. **场景重跑的小坑**：`g2-ops` 三条都被 `write` 拒绝（`file has not been read`），因为 g1–g3 是第一次跑留下的、`write` 改已有文件要先读。换成 g4–g6 重跑（`g3-ops`）就好了。另外 DSH 会复用空的草稿会话，所以收集脚本改成按修改时间找会话，每个场景可能多列出一个只有 4–5 个事件的空会话，可以忽略。

## 修复后的真机复现（2026-10-19 00:45，r4-repro）

- 代码：SolDev 修了 Fusion 的 `classify`（`spawnErrorOf`，`fusion.js:238`、`:256-261`）。和 r3 相比变了 `lib/fusion.js`（`b0ee41813156…`）和 `lib/occ.js`（`8443d1e33c30…`，只改注释）。云主机副本 15 个文件逐一核对，全部一致；本机 `node --test` 428 条全过。哈希追加在 MANIFEST 末尾的 addendum 段。
- 做法：临时把 `<lab>\tmp` 的所有者改回 Administrators，复现 ops_bash 起不来的条件，跑一次 `write_then_run`，结束后在 `finally` 里改回 <test-user>（LOG.md 两行都记了）。
- 结果【已核实，`r4-repro-events.txt`，会话 `session-b341525d…` #19】：标记变成 `[then_run:not_run] bash could not be started: DSH workspace preparation failed … Workspace is not owned by the current user …`，原因就是 ops_bash 自己写在 `value.error` 里的那句话。模型的回答也是“the verification … did not run”。
- 证据包更新为 [20261019-0003-researcher-stage2b.v2.tgz]（sha256 `3cfd344e9121…`），比 v1 多了 r4-repro 的会话、事件摘要和 MANIFEST addendum。

## 最终规则的真机验证（2026-10-19 02:02，r5）

- 代码：SolDev 定稿的 `classify`，只有 `exitCode === 0` 才算 succeeded，缺键不再算成功。和 r4 相比只变了 `lib/fusion.js`（`c113aa71380c…`）。云主机副本 15 个文件逐一核对，全部一致；本机 `node --test` 431 条全过。哈希追加在 MANIFEST 的 addendum r5 段。
- `r5-clean`（工作区归 <test-user>）【已核实，`r5-events.txt`】：
  - `cat s2/r5a.txt; exit 0` → `[then_run:succeeded]`（会话 #20）。按 r5 的规则，只有 `exitCode === 0` 才能得到 succeeded，所以这一条就证明了 ops_bash 正常退出时确实带着 `exitCode: 0`。原始 `result.value` 本身没有落盘：会话日志只存渲染后的文本。
  - `exit 3` → `[then_run:failed] exit code: 3`（#34）。
- `r5-spawn`（工作区临时归 Administrators，结束后已改回 <test-user>）：`[then_run:not_run]`，原因是 dsh-ops 原文 `bash could not be started: … Workspace is not owned by the current user …`（#19）。
- 证据包更新为 [20261019-0003-researcher-stage2b.v3.tgz]（sha256 `cae567591058…`）。

## 没做的

- Reducer（等用户定模型）；其他 preset 的工具可见性；插件页 UI 截图（这一轮只看了日志和会话）。
