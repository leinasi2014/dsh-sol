# SoL-Pi 实现拆解（面向 DeepSeek Harness 重写）

来源：https://github.com/NVlabs/SoL-Pi main 分支，经 web_fetch 读 raw 文件（2026-10-18）。
行号说明：raw 内容为人工数行，标"≈"的行号误差约 ±3 行；以函数/常量名为准定位。字节数取自 GitHub 目录列表（准确值）；行数由字节数估算（标"估"）。

已读：src/sol-pi/ 全部 21 个文件；docs/compatibility.md、docs/configuration.md、SECURITY.md、agents-install.md、sol-pi.example.json、package.json；
tests/all-mechanisms、helpers、observation-pack、evidence-preserving-reducer、action-fusion、online-context-compact、online-context-compact-economics、online-context-compact-projection、sol-pi-regression-stress；scripts/check-pi-compat.mjs、check-sol-pi-config.mjs。
未读：tests/action-fusion-paths、config、install-guide、online-context-compact-{agent-session,plan,recovery,state}、package、pi-package-integration、runtime-paths、sol-pi-config-preflight、tui、star-history；scripts/update-star-history.mjs；README.md。

---

## 0. 公共骨架

- 入口 `src/sol-pi/index.ts`：`pi.on("session_start")` 中只初始化一次（≈31-35），按配置调用 4 个 register；OCC 最后注册（≈13-22），保证它的 `context` 观察器排在其他 context 变换器（ObservationPack）之后。
- 配置 `src/sol-pi/config.ts`：`DEFAULT_CACHE_WRITE_READ_RATIO = 12.5`（≈14）；所有 feature 默认 false（≈27-36）；查找顺序：项目 `<cwd>/<CONFIG_DIR_NAME>/sol-pi.json`，仅当 `ctx.isProjectTrusted()` 才读 → `<getAgentDir()>/sol-pi.json` → 默认（`findConfigPath` ≈48-60）；不合并；未知 key / version≠1 / 非 bool / ratio 非有限或<0 / reducer 字符串为空 → 抛错（`loadSolPiConfig` ≈62-121）。
- 存储根 `src/sol-pi/runtime-paths.ts`：`runtimeRoot(ctx)` = `<sessionManager.getSessionDir()>/sol-pi/<sessionId>`；sessionId 必须匹配 `/^[a-z0-9][a-z0-9._-]*$/i`，否则抛错（防路径穿越，≈16-18）；无 sessionDir（--no-session / inMemory）时 `mkdtempSync(tmpdir()/sol-pi-<id>-XXXX)`，进程内按 sessionId 复用，不清理（≈21-29）。
- TUI `src/sol-pi/tui.ts`：`showSolPiSavings` 仅 `ctx.mode === "tui"` 时 `ctx.ui.notify` + `ctx.ui.setStatus("sol-pi-savings", …)`，4 秒后清除；`renderSolPiTool` 包装 renderCall/renderResult。纯展示，不改消息。
- sol-pi.example.json：`{version:1, actionFusion:false, observationPack:false, evidencePreservingReducer:false, evidencePreservingReducerProvider:"provider-id", evidencePreservingReducerModel:"model-id", onlineContextCompact:false, cacheWriteReadRatio:12.5}`。
- package.json：`"pi": {"extensions": ["./src/sol-pi/index.ts"]}`；peerDeps `@earendil-works/pi-agent-core|pi-ai|pi-coding-agent|pi-tui`、`typebox`（均 "*"）；devDeps 锁 0.85.1；scripts `test=vitest run`、`typecheck=tsc --noEmit`、`check`；node>=22.19.0。

all-mechanisms.test.ts 验证：全关时不注册任何工具/事件；全开时工具顺序为 `["edit","write","obs_recall","update_plan"]`，事件集合为 `agent_settled, before_provider_request, context, input, session_before_tree, session_compact, session_shutdown, session_start, session_tree, tool_result, turn_end`；session_start 两次只加载配置一次；EPR 使用配置的 provider/model（receipt 中含 `reducer_model=`/`reducer_provider=`）。

helpers.ts：`FakeSessionManager`（entries、getBranch、appendCustomEntry、appendMessage、customEntryData）、`FakePi`（handlers Map、registerTool、appendEntry→custom entry、sendMessage 记录、`emit` 取最后一个非 undefined 返回、`emitContext` 链式传递 messages）、`fakeContext`（mode "json"、isIdle、abort、compact、getContextUsage、getSystemPrompt 等 stub）。DSH 重写时可照此做宿主 API 的测试替身。

---

## 1. Action Fusion（`extensions/action-fusion/`，3 文件，13,783 B，估 ~380 行）

### 1.1 挂载 API
- `pi.registerTool` 覆盖同名内置 `edit`、`write`（index.ts ≈83、≈117）。
- 复用公共工厂 `createEditToolDefinition(cwd, opts)`、`createWriteToolDefinition`、`createBashToolDefinition`（index.ts ≈20-29；then-run.ts ≈8、≈112）。内置定义闭包捕获 cwd → `memoizeByCwd` 每个 cwd 缓存一份（index.ts ≈57-67）。
- 不挂任何事件。

### 1.2 核心算法
- Schema：在内置参数上追加可选 `then_run`：`Type.Optional(Type.Object({command: Type.String(), timeout: Type.Optional(Type.Number({description:"Timeout in seconds (optional, no default timeout)"}))}))`（then-run.ts `createThenRunSchema` ≈21-31）。测试确认属性顺序 write=`[path, content, then_run]`、edit=`[path, edits, then_run]`，then_run 不在 required。
- 超时：无默认；`timeout` 原样传给内置 bash（测试 "passes then_run timeout through" 断言 exec 收到 `timeout===12`）。
- 流程 `executeMutationThenRun`（then-run.ts ≈79-128）：
  1. 整个过程在 `withFusedFileQueue(absolutePath)` 内（≈96）。
  2. 执行内置 mutate；失败且有 then_run → 抛 `"<原错误>\n\n[then_run:skipped] The file mutation did not complete successfully; the command was not run."`。
  3. 无 then_run → 原结果直接返回。
  4. `assertUnchangedBeforeCommand`（≈54-69）：sha256(文件) → `setImmediate` 让出 → 再 sha256，不同则抛 `[then_run:skipped] target content changed after the fused mutation`。
  5. 内置 bash 执行，toolCallId=`${id}:then_run`（≈114）。
  6. 成功：`content = [...mutation.content, {type:"text", text:"[then_run:succeeded]\n"+bash输出}]`（≈116-123）。
  7. bash 抛错（非零退出等）：抛 `[mutation文本, "[then_run:failed]", 错误文本].join("\n\n")`，文件修改保留（≈124-127）。
- 标记常量：`[then_run:succeeded]`/`[then_run:failed]`/`[then_run:skipped]`（then-run.ts 12-14）。EPR 和 ObservationPack 都依赖这些标记。
- 文件队列 `file-queue.ts`：
  - `resolveToolPath`（≈34-43）：Unicode 空格→普通空格、去掉前导 `@`、Windows 下 `/c/x`、`/mnt/c/x`、`/cygdrive/c/x` → `C:\x`（`normalizeWindowsShellPath` ≈26-32）、`file://` 用 `fileURLToPath`、`~`/`~/`/`~\` 展开、`resolve(cwd, …)`。
  - `canonicalQueueKey`（≈54-70）：对最长已存在前缀做 `realpath`，再拼接缺失段（文件尚不存在时也能得到规范 key）。
  - `withFusedFileQueue`（≈76-93）：按 key 维护 promise 尾链，串行化；只覆盖本扩展的融合调用，不嵌套 Pi 内置 mutation queue（compatibility.md 有说明）。
- savings：成功时 TUI 显示 "1 model round-trip avoided"（不做任何度量）。

### 1.3 存档
无。

### 1.4 安全
无沙箱；命令原样交给 Pi 默认 bash（测试 "passes the command unchanged"）。哈希检查防外部并发修改；队列防同文件交错。SECURITY.md："Action Fusion can modify files and run shell commands requested by the model."

### 1.5 测试不变量（action-fusion.test.ts）
命令在写入内容可见之后执行；不带 then_run 时不调用 bash；then_run 失败时文件保留且抛 `[then_run:failed]`；mutation 失败时 bash 调用 0 次且抛 skipped；队列在 then_run 期间保持锁（事件序 `write:first, then_run:start, then_run:end, write:second`）；外部修改 → skipped；TUI 只在成功时通知。action-fusion-paths.test.ts 未读。
无省 token 度量。

---

## 2. ObservationPack（`extensions/observation-pack/`，3 文件，17,400 B，估 ~490 行）

### 2.1 挂载 API
- `pi.registerTool({name:"obs_recall", …})`（index.ts ≈64）。
- `pi.on("context", …)` 返回 `{messages: projected}`，只改投影、不改历史（index.ts ≈133-196）。

### 2.2 核心算法
- 常量（observation.ts 13-17）：`THRESHOLD_BYTES = 10*1024`、`FULL_SENDS = 2`、`PLACEHOLDER_EXCERPT_BYTES = 1024`；token 估算 = `ceil(chars/4)`（≈19、45-47）。
- 资格 `isPureTextResult`（≈67-74）：role==="toolResult"、!isError、content 非空且全是 text。文本 join("\n") 后 UTF-8 字节数须 > 10 KiB；含独立行 `sol_pi_evidence_receipt_v1` 的结果（EPR 回执）跳过（≈28、80-82、98-103）。
- "大"：仅按字节阈值判断。"重复"：没有跨消息去重；id 按 (toolName, toolCallId, contentHash) 计算，所以同一个结果在多次请求中 id 稳定。
- 句柄格式：`obs_` + sha256(`${toolName}\0${toolCallId}\0${sha256(text)}`) 前 24 个 hex（observation.ts ≈105）；校验正则 `/^obs_[a-f0-9]{24}$/`（≈20）。
- 发送计数（index.ts ≈135-160）：从后往前数每条消息后面的 assistant 条数，作为该消息已参与过的请求数；内存 Map `sentCounts[root\0id]` 优先。`previousSends < 2` → 原文发送，并记 ledger "full"；否则替换为占位符，记 ledger "placeholder"。只在 `previousSends === 2` 时弹一次 TUI 节省提示。
- 占位符（`placeholderFor` ≈180-199），稳定、确定性（只破坏一次前缀缓存）：
  ```
  [large tool result replaced after its first 2 provider requests]
  id: obs_…
  tool: <name>
  original_bytes: N
  original_lines: N
  estimated_tokens: N
  retrieve: call obs_recall with {"id":"obs_…","offset":0}; continue with returned next_offset
  [first complete lines, up to 512 bytes]
  <头部完整行>
  [middle omitted; last complete lines, up to 512 bytes]
  <尾部完整行>
  [N original bytes omitted]
  ```
  头/尾只取完整行，各 512 B（`completeLineExcerpt` ≈160-178）。替换整个 content 为单个 text 块；其他字段（details、isError）保留。
- 回读工具 `obs_recall`：参数 `{id: string, offset?: integer>=0（字节偏移，默认 0）}`。上限：输出 ≤16 KiB 且 ≤400 行；内容预算 = 16384−512 B、398 行（index.ts ≈41-49）。`readRecallChunk`（observation.ts ≈215-252）：用 O_NOFOLLOW 打开，offset>size 抛错，读 maxBytes+4，在第 maxLines 个 \n 处截断，再向前回退到 UTF-8 字符边界（`trimUtf8End`）。输出头两行：
  `[obs_recall id=… offset=… next_offset=… eof=…]`、`[chunk_bytes=… chunk_lines=…; use next_offset to continue]`；details `{id, offset, bytes, lines, nextOffset, eof}`。若总输出超限则抛错；ENOENT → "Unknown observation id"。
- 失败回退：任何异常都 fail-open，保留原文，并 `console.error("[observationpack] fail-open …")`（index.ts ≈188-192）。

### 2.3 存档
- `<runtimeRoot>/observation-pack/objects/<obs_id>.txt`：原始 UTF-8 文本（目录 0700，文件 0600，O_CREAT|O_EXCL|O_NOFOLLOW）。
- `<runtimeRoot>/observation-pack/ledger.jsonl`：追加写，每行 `{timestamp, event:"full"|"placeholder"|"recall", id, request, tool, originalBytes, originalLines, originalTokens, contentHash | placeholderBytes, placeholderTokens, removedTokens, sendNumber | offset, bytes, lines, nextOffset, eof}`（ledger.ts、index.ts）。

### 2.4 安全
拒绝符号链接目录（lstat 检查）和符号链接文件（O_NOFOLLOW → ELOOP）；对象已存在时校验 size 与 sha256，不一致视为完整性错误（fail closed，即不打包、保留原文）。id 先经正则校验再拼路径，防止穿越。不向远程发送任何内容。

### 2.5 测试不变量（observation-pack.test.ts）
- 不丢证据：分页 recall 拼接结果与原文逐字节相等（含多字节 UTF-8 字符 "☾"），见 "returns the exact original bytes across paged recall"；对象文件内容 === 原文；扩展重启后仍能 recall；session 原消息未被修改（`resultText(message) === body`）。
- 前 2 次请求发原文，第 3、4 次占位符完全相同；旧占位符不会因后续消息再次变化（"breaks the prefix once per observation"）。
- 按 session 隔离；同尺寸不同内容 → hash mismatch → 原文透传；符号链接 → ELOOP / "not a regular directory"。
- 错误结果、混合 image、EPR 回执（含 fused write 中的回执）一律透传。
- 省 token 度量：只有 ledger 中的 `removedTokens = max(0, chars/4(原文) − chars/4(占位符))`，属于估算，不是真实计费。无 benchmark。

---

## 3. Evidence-Preserving Reducer（`extensions/evidence-preserving-reducer/`，7 文件，27,779 B，估 ~780 行）

### 3.1 挂载 API
- `pi.on("tool_result", …)`，返回 `{content, details, isError}` 替换结果；返回 undefined 表示原样保留（index.ts ≈183-198）。
- `pi.appendEntry("sol-pi-evidence-preserving-reducer-v1", {...})` 作为日志（journal.ts 16-25），不进入 LLM 上下文。
- 嵌套模型调用：`ctx.modelRegistry.find(provider, model)` → 优先 `ctx.modelRegistry.complete(model, context, opts)`；没有时用 `getApiKeyAndHeaders(model)` + `@earendil-works/pi-ai/compat` 的 `complete`（provider.ts ≈97-165）。`ctx.signal` 会转发给中止信号。

### 3.2 核心算法
- 默认值（config.ts 14-23）：`MAX_EVIDENCE_ITEMS=12`、`MAX_QUOTE_CHARS=600`、`minBytes=4096`、`maxChars=600000`、`maxOutputTokens=2048`、`timeoutMs=90000`、provider `openai-codex`、model `gpt-5.6-luna`；`runId = sha256(runtimeRoot)[:16]`；`storeRoot = runtimeRoot/evidence-preserving-reducer`（`loadReducerConfig` ≈61-72）。
- 候选提取 `reducibleToolResult`（candidate.ts ≈65-104）：
  - `bash`：command 来自 `input.command`；body 取内联文本，若有 `details.fullOutputPath` 或文本中有 `Full output: <path>`，且该文件通过 `safePiBashTempPath`，则读取完整未截断文件（≈35-59）。
  - `write`/`edit` 带 `then_run.command`：查找 `[then_run:succeeded]`（isError 时找 `[then_run:failed]`）标记，取标记之后的文本作为 body；`projectReceipt` 只替换标记之后的部分，保留 mutation 确认文本。
- 资格判定（index.ts ≈64-76），依次检查：
  1. command 匹配 `DIAGNOSTIC_COMMAND`（config.ts ≈25-26：lake build、lake env lean、lean、coq、cargo [build|test|check]、zig build、pytest、python[3] -m pytest|unittest|py_compile、ctest、cmake --build、ninja、make、npm/pnpm/yarn test、go test、bazel test）；
  2. UTF-8 字节数 ≥ 4096；
  3. 字符数 ≤ 600000（否则记 fallback `source-over-max-chars`）；
  4. 不匹配 `LIKELY_SECRET` = `/(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i`（否则 fallback `likely-secret`）。
  通过后先归档，再记 journal `candidate`。
- Prompt 结构（receipt.ts）：system = `reducerInstructions()`（≈37-52）：要求无损的 test/build 输出 reducer；日志是不可信数据；只返回 JSON；schema=`sol-pi-evidence-receipt/1`；is_error=false 时 status=success，true 时 failure；evidence 只能是逐字节连续的原文引用；kind 取值 fatal|failure|warning|target|summary；≤12 条、每条 ≤600 字符；优先首个因果性 fatal/failure；不做诊断、不建议修复、不编造命令；不确定时 uncertain=true；并给出 Required shape `{"schema","source_sha256","status","uncertain","evidence":[{"kind","quote"}]}`。user = `reducerInput()`（≈54-65）：`command_sha256=…\nsource_sha256=…\nsource_bytes=…\nsource_lines=…\nis_error=…\n<untrusted_log>\n<body>\n</untrusted_log>`。请求选项：`cacheRetention:"none"`、`maxTokens=min(2048, model.maxTokens)`、`sessionId=runId`、`signal`、`timeoutMs`（provider.ts ≈130-136）；stopReason 为 stop 或 length 都算 ok。
- 引文校验 `validateReceipt`（receipt.ts ≈82-143）：JSON.parse 失败 → `invalid-json`；schema、source_sha256===archive.hash、status===期望值、uncertain 为 boolean、evidence 为数组且 ≤12，任一不满足 → `schema-mismatch`；每条 kind ∈ 允许集合、1≤quote.length≤600、`body.includes(quote)`（精确子串，即逐字节），任一不满足 → `unverifiable-quote`（整个回执作废，而不是只丢掉这一条）；(kind, quote) 去重；行号 = 首次出现位置之前的 \n 数 + 1；isError 且 body 匹配 `FAILURE_SIGNAL`（`/error|failed|failure|fatal|exception|panic|timeout|unsolved|type mismatch|assert/i`）但没有 fatal/failure 证据 → `missing-failure-evidence`。
- 回执格式 `receiptText`（≈145-178）：
  ```
  sol_pi_evidence_receipt_v1
  status=… / uncertain=… / command_sha256=… / source_sha256=… / source_bytes=… / source_lines=…
  source_artifact=<归档绝对路径>
  reducer_provider=… / reducer_model=… / reducer_total_tokens=…
  verified_evidence:
  - kind=… line=… quote_sha256=… quote=<JSON字符串>   （无证据时为 "- none"）
  authority=Sol retains diagnosis, repair, rerun, and pass/fail adjudication
  readback=use bash with an explicit byte or line range on source_artifact when exact context is needed
  ```
  回执不提供专用回读工具，靠 bash 读 source_artifact。
- 失败回退（全部 fail-open，返回 undefined，原结果不变），journal 中 fallback 的 reason 取值：`source-over-max-chars`、`likely-secret`、`model-call-timeout`（AbortError）、`reducer-model-unavailable`、`model-call-exception`、`model-response-error`、`invalid-json`、`schema-mismatch`、`unverifiable-quote`、`missing-failure-evidence`、`receipt-not-smaller`（回执字节数 ≥ 原文时放弃）。runtimeRoot 抛错时也返回 undefined（index.ts ≈186-190）。
- 成功：journal `applied`（含 sha、bytes、evidenceCount、uncertain、usage）；details 合并 `evidencePreservingReducer:{schema, sourceSha256, sourceBytes, receiptSha256, receiptBytes, evidenceCount, uncertain}`；isError 保持不变。

### 3.3 存档
- `<runtimeRoot>/evidence-preserving-reducer/objects/<hash[0:2]>/<sha256>.txt`（目录 0700，文件 0600，`flag:"wx"`；已存在时内容必须相同，否则抛 integrity failure）（archive.ts ≈32-53）。
- 日志写在 Pi session 的 custom entry 中（type `sol-pi-evidence-preserving-reducer-v1`，schema `sol-pi-evidence-preserving-reducer/1`，字段 `runId, kind, …`），没有单独文件。

### 3.4 安全
- 远程发送：会把日志全文发给配置的 reducer 模型（SECURITY.md："Do not enable remote reduction for workloads whose logs must remain local"）；LIKELY_SECRET 只是预防措施，不是完整的密钥扫描器。
- 系统 prompt 声明日志不可信；日志用 `<untrusted_log>` 包裹。
- 读外部完整输出时，只接受文件名匹配 `/^pi-bash-[^/\\]+\.log$/`、realpath 后父目录等于 realpath(tmpdir)、是普通文件且不是符号链接的文件（candidate.ts ≈35-43）。
- 凭据由 Pi 管理，不写进 sol-pi.json。

### 3.5 测试不变量（evidence-preserving-reducer.test.ts、sol-pi-regression-stress.test.ts）
- 不丢证据：`readFile(source_artifact) === body`；归档路径位于 runtimeRoot/evidence-preserving-reducer 之下；文件权限为 0600；receipt 字节数 < body；line=2 定位正确；编造的 quote → `unverifiable-quote`，结果为 undefined（即原文保留）；fused 结果保留 "Successfully wrote…" 和标记，details.patch 不变。
- 调用选项断言为 `{cacheRetention:"none", maxTokens:2048, timeoutMs:90000}`，signal 为 AbortSignal；fork 形态的 registry 走 getApiKeyAndHeaders，并传递 apiKey/headers/env/baseUrl。
- 只读取 tmpdir 下的 `pi-bash-*.log`；其他位置的同名文件被忽略。
- 小输出（<4096 B）或非诊断命令（如 `rg`）→ 模型调用 0 次。
- 压力测试：200 次路由到 reducer 模型而非主模型；100 次模型不可用 → 0 次调用 + fallback。
- 省 token 度量：TUI 显示 `archive.bytes − receiptBytes` 字节；journal 记录 usage。无 benchmark。

---

## 4. Online Context Compact（`extensions/online-context-compact/`，7 文件，46,088 B，估 ~1250 行）

### 4.1 挂载 API（extension.ts ≈193-505）
- `pi.registerTool({name:"update_plan", executionMode:"sequential", …})`（tools.ts ≈48-110）。
- 事件：`session_start`、`session_tree`（都调用 restore）、`session_before_tree`（压缩进行中返回 `{cancel:true}`）、`context`（只记录 `observedMessages`，不修改）、`before_provider_request`（`recordProviderRequest` + 保存）、`input`（steer 或文本以 `CORRECTION:` 开头时 → `recordCorrection`；否则 `recordCompletedPlanHandoff`；返回 `{action:"continue"}`）、`turn_end`（边界决策）、`agent_settled`（执行压缩 + 续跑）、`session_compact`（`recordCompaction`）、`session_shutdown`。
- Context API：`ctx.getContextUsage()`（tokens、contextWindow）、`ctx.model.contextWindow`、`ctx.getSystemPrompt()`、`ctx.abort()`、`ctx.isIdle()`、`ctx.compact({customInstructions, onComplete, onError})`、`ctx.sessionManager.getBranch()`、`ctx.signal`、`ctx.mode`、`ctx.ui.notify`。
- Pi 导出：`estimateTokens`、`findCutPoint`、`sessionEntryToContextMessages`。
- 写入：`pi.appendEntry("sol-pi-online-context-state-v1", state)`、`pi.appendEntry("sol-pi-online-context-compact-skipped", {reason})`、`pi.sendMessage({customType:"sol-pi-online-context-compact", content, display:false}, {triggerTurn:true})`。
- 没有使用 `before_agent_start`、`session_before_compact`、`sendUserMessage`（对 src 全文阅读后未发现）。

### 4.2 "计划步骤完成"的识别
- `update_plan` 参数：`{steps: [{id: string 1..16384, goal: string 1..16384, status: "pending"|"in_progress"|"completed"}] (1..128 条), progress?: {files_changed: string≤1000 [≤128], verification: [≤64], decisions: [≤64]}}`，additionalProperties:false（tools.ts ≈30-46、≈67-73）。每次必须提交完整计划。
- `analyzePlanTransition`（plan.ts ≈54-74）：只有当某个 id 在上一份计划中存在、状态不是 completed、而这次变为 completed 时，才算完成边界；新出现的 completed 只记为历史。同 id 改 goal、多个 in_progress、没有 in_progress 却有 pending → 给出 advice 文本。id 重复或结构不合法 → 抛错（plan.ts `parsePlanSteps` ≈36-52）。
- 有完成边界时：`recordBoundary` 把 `requestCount − lastBoundaryRequestCount` 追加到 `completedBoundaryRequestCounts`，并把 progress 追加到 pendingProgress；设置 `pendingBoundary = {toolCallId}`（extension.ts ≈240-268）。工具返回 `<sol-pi-plan task_status="active">{"steps":[…]}</sol-pi-plan>` 加 advice，details 为 `{boundary, completed_step_ids, progress_recorded, task_status:"active", plan}`。

### 4.3 turn_end 决策（extension.ts ≈314-375）
前提：有 pendingBoundary、尚未选中、没有 compactionRefused；assistant 的 stopReason 不是 error/aborted；signal 未中止；该 update_plan 结果不是错误。

输入：
- `writeTokens = contextTokens(ctx) = max(getContextUsage().tokens, Σ estimateTokens(observedMessages) + ceil(bytes(systemPrompt)/4))`（Pi 没有报告时只用估算）。
- `archiveTokens = estimateNativeCompactionTokens(branch, keepRecentTokens=20000, observedMessages)`：在 branch 末尾补一个 aborted assistant 标记后，调用 Pi 的 `findCutPoint` 得到原生切点；被移除部分按最近一次观测到的投影计价（`projectedEntryTokens`，按 toolCallId/toolName/timestamp 匹配，因此 ObservationPack 的占位符按占位符大小计价；被丢弃、新增或有歧义的消息计 0，绝不回退到原始大小），再加上上一次摘要的 token（extension.ts ≈158-187；projection.ts 16-58）。
- `memoTokens = 1000`（DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE）。
- `contextWindow`：取 getContextUsage().contextWindow，没有则取 ctx.model.contextWindow，再没有则为 null。
- `averageContextTokenIncrement = positiveContextDeltaTotal / positiveContextDeltaCount`。
- `remainingBoundaries` = 未完成步骤数。

`decideCompaction`（economics.ts ≈129-260），默认参数（economics.ts 16-23）：`remainingRequestScale=1, remainingRequestStddevK=0, windowReserveTokens=16384, firstCompactionRequestScale=2, subsequentCompactionMargin=1.5, minimumRequestsSinceCompaction=2`。
```
saving        = archiveTokens − memoTokens
post          = max(0, writeTokens − saving)
incr          = max(0, cacheWriteReadRatio − 1)         # ratio=null → 无法做经济判断
newDebt       = post × incr
breakeven     = newDebt / saving                         (saving>0)
combined      = (carriedDebt + newDebt) / (debtRepayment + saving)
mean          = 已完成边界请求数的均值；k≠0 时样本<3 则下界=mean×0.5，否则下界=max(0, mean − k·sd)
horizon       = min(1 + floor(下界 × remainingBoundaries × scale),
                    floor((window − ctx) / avgIncrement))    # 后一项无数据时忽略
首次压缩：     compact if breakeven ≤ min(horizon×2, windowUB)
后续压缩：     breakeven ≤ horizon AND breakeven×1.5 ≤ horizon AND combined ≤ horizon
冷却：         距上次压缩 requests < 2 → 不做经济压缩
窗口保护：     ctx ≥ window − 16384 → 压缩（可越过冷却）
最终：         compact = saving>0 AND (窗口保护 OR (经济 AND 不在冷却))
```
另外：若 archiveTokens===0，则改为 `native_not_compactable`（不压缩）。reason 取值：economic、window_protection、deferred_economic、deferred_subsequent_margin、deferred_carried_debt、deferred_post_compaction_cooldown、horizon_unavailable、cache_ratio_unavailable、native_not_compactable、non_positive_saving。
cacheWriteReadRatio 的用途只有一个：`incr = ratio − 1`，即压缩后整段上下文需要重新写缓存所付出的超额成本倍数；每次节省 saving 个缓存读 token，从而得到回本请求数。
债务偿还：每次 `before_provider_request` 执行 `cacheDebt = max(0, debt − repayment)`；债务降到 0 时 repayment 也清 0（state.ts `recordProviderRequest` ≈156-168）。

决定压缩时：`selected = {decision}` 并调用 `ctx.abort()`，停止当前 run。

### 4.4 压缩与续跑（agent_settled，extension.ts ≈377-490）
- `!ctx.isIdle()` 时保留 selected，等待下一次 settled。
- 设 `activeDebt = {debtTokens: post×incr, repaymentTokens: max(0, archive − memo)}`；`compactionInFlight = true`；调用 `ctx.compact({customInstructions: "Preserve completed work, verification results, important decisions, and remaining work.", onComplete, onError})` 并等待回调。
- 可恢复错误（精确匹配错误消息）：`Nothing to compact (session too small)`、`Already compacted`、`Summarization failed: generation hit the token cap and the summary is incomplete` → 设 compactionRefused，appendEntry skipped，TUI 警告，并用 SKIPPED 提醒续跑。AbortError 或 "Compaction cancelled" → 静默，不续跑。其他错误继续抛出。
- 续跑：`pi.sendMessage({customType:"sol-pi-online-context-compact", content: POST_COMPACTION_PLAN_REMINDER（"Online context compaction finished. The parent task is still active. Continue the remaining work from the current plan. Preserve existing step IDs when updating progress."）, display:false}, {triggerTurn:true})`。之后若 ctx 仍 idle（新版宿主会延后启动 turn）就立即释放；否则（Pi 0.85.1 同步启动）await 一个 continuation promise，等下一次 agent_settled 再释放。这个"结算屏障"让 print/JSON 模式在同一次调用中完成压缩并续跑。
- compactionRefused 会阻止仅含 update_plan 的回合重试；出现成功的非 update_plan 工具结果或新的用户输入后才清除。
- `session_compact`：`recordCompaction(state, event.fromExtension || !activeDebt ? 0债 : activeDebt)`：epoch+1、保留 plan、清空 pendingProgress、lastContextTokens=null、nativeCompactionCount+1、累加债务。

### 4.5 状态存储
- 完全存于 Pi session log 的 custom entry `sol-pi-online-context-state-v1`，每次变化追加一条完整状态；restore 时从 `getBranch()` 倒序查找第一条合法记录（state.ts 8、≈142-154）。没有任何文件（configuration.md："creates no separate Online Context Compact files"）。
- OnlineState 字段（state.ts 19-35）：version:1、epoch、plan、pendingProgress[{stepId, goal, filesChanged, verification, decisions, nextWork}]、requestCount、lastCompactionRequestCount|null、lastBoundaryRequestCount、completedBoundaryRequestCounts[]、lastContextTokens|null、positiveContextDeltaTotal/Count、nativeCompactionCount、cacheDebtTokens、cacheDebtRepaymentTokens。
- 注意：pendingProgress 只被记录，没有注入压缩 prompt（customInstructions 是固定文本），只在压缩时清空。
- 纠偏/新任务：`recordCorrection` 清空 plan、样本和债务；`recordCompletedPlanHandoff`（计划已全部完成后出现新输入）清空样本，但保留未还清的债务。

### 4.6 安全
SECURITY.md：state 中含模型撰写的计划、路径、命令名，应与对话同等敏感；不会进入模型上下文（只有通用提醒会）；删除 session 即删除全部数据。不向远程发送额外内容（压缩由 Pi 原生完成）。session_before_tree 在压缩期间取消，防止 leaf 被移动。

### 4.7 测试不变量
- economics.test：horizon 示例 `[4,6,5]`、剩余 3 个边界 → mean=5、expected=16、windowUB=20；saving≤0 → non_positive_saving；ratio=null → cache_ratio_unavailable；窗口保护可越过冷却；`post=400, breakeven=4, combined=14/3`；`ratio=2` 时 `breakeven=21000/59000`；冷却 1 次请求时推迟、2 次时允许；首次压缩前不适用冷却。
- projection.test（ObservationPack + OCC 联动）：按原始大小计价会判定"压缩"，按投影大小（<1000）计价则 non_positive_saving，且不调用 abort；投影中缺失的消息计 0；按来源身份匹配，有歧义时排除。
- online-context-compact.test：只注册 1 个工具和公共事件；context 观察不改变消息；压缩后第一次 update_plan 仍能识别边界；完整流程：turn_end 调用 abort 一次 → 非 idle 时 settled 不压缩 → idle 时 compact 一次（customInstructions 正确）→ 压缩期间 session_before_tree 返回 cancel → sendMessage 为 hidden + triggerTurn → 第一次 settled 一直挂起，直到第二次 settled；债务精确值 `cacheDebtTokens = (195000−1001)×11.5 = 2,230,988.5`、`repayment = 1001`。
- agent-session / recovery / state / plan 测试未读。compatibility.md 称 agent-session 测试用 faux provider 验证一次和连续两次原生压缩加自动续跑；"verify runtime compatibility, not live provider authentication or token savings"。
- 省 token 度量：TUI 显示 `archiveTokens − ceil(bytes(summary)/4)`。无 benchmark。

---

## 5. scripts/ 与 benchmark
- `check-pi-compat.mjs`：检查以下公共 API 是否存在：createBash/Edit/WriteToolDefinition、ModelRegistry.prototype.getApiKeyAndHeaders、getAgentDir、pi-ai/compat complete、SessionManager.prototype.getSessionDir/getSessionId、CONFIG_DIR_NAME。
- `check-sol-pi-config.mjs`：`--config <path> [--require-all-enabled]`，按与 config.ts 相同的规则校验并输出 effective JSON。
- `update-star-history.mjs`：未读（从文件名看与 GitHub star 有关，不是度量脚本；未核实）。
- 在已读文件中未找到任何 token 节省 benchmark 或度量脚本。README 未读，其中是否引用了外部实验数据未核实。

## 6. compatibility.md 中的 Pi API 清单（原样摘录）
```
SoL-Pi imports only public package exports:

- `createEditToolDefinition`
- `createWriteToolDefinition`
- `createBashToolDefinition`
- extension types and `ExtensionAPI.registerTool`
- `context`, `before_provider_request`, `tool_result`, `turn_end`, `agent_settled`, and `session_before_tree` extension events
- native compaction events, `ExtensionContext.getContextUsage()`, and `ExtensionContext.compact()`
- `ExtensionContext.model` and `ExtensionContext.modelRegistry`
- the public session-manager methods exposed through `ExtensionContext`
```
注意：代码中实际还用到了清单之外的 `ExtensionAPI.on("session_start"|"session_tree"|"input"|"session_compact"|"session_shutdown")`、`ExtensionAPI.appendEntry`、`ExtensionAPI.sendMessage`、`ctx.abort()`、`ctx.isIdle()`、`ctx.getSystemPrompt()`、`ctx.isProjectTrusted()`、`ctx.ui.notify/setStatus`、`ctx.mode`、`ctx.signal`，以及导出 `estimateTokens`、`findCutPoint`、`sessionEntryToContextMessages`、`getAgentDir`、`CONFIG_DIR_NAME`、`@earendil-works/pi-ai/compat` 的 `complete`。

## 7. DSH 重写映射提示（需要宿主提供的能力）
1. AF：能覆盖或包装内置 edit/write 工具，并在工具内部调用宿主 bash 执行器；需要每个文件一个异步锁。
2. OP：需要"请求前投影"钩子（只改发往 provider 的消息，不改持久化历史），并能计数每条 tool result 已被发送的次数；需要一个回读工具。
3. EPR：需要 tool_result 后置改写钩子，以及一个能用独立模型和凭据发起的嵌套 completion；需要能获取被截断 bash 输出的完整文件路径。
4. OCC：需要 provider 请求计数钩子、turn_end/settled 生命周期、可编程的原生压缩（带 onComplete/onError）、中止当前 run、隐藏消息加触发新 turn、session 内的自定义状态条目，以及原生切点算法（或等价实现），保证估算与实际压缩一致。
