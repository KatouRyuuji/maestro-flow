# Session/Run v3（方案 B）core 实现蓝图（2026-08-12）

> ⚠️ **SUPERSEDED（2026-08-14）**：本文是 v0.5.70 时代的实现蓝图，多处内容与最终实现**冲突**，已由 `docs/session-run-v3-reference-design.md` 取代。冲突点：① `participant.ts`（register/status/unregister）与 `participant_id` 字段已删除（`--participant` option 仅兼容忽略）；② `identity_revision` 已从 session/3.0 删除（三 revision → 两 revision）；③ `paused` 状态与 `session pause/resume` 已删除（决策门 escalated 替代）；④ gates 系统（gates_ref/blocking 校验/run.gate_refs）已删除；⑤ chain-proposal/TC-P0-3 附加输入/resume-map 截断/22 条 retired stub/chain audit 已删除；⑥ 决策门（step.decision_ref + 未决阻断）为最终实现新增，蓝图未覆盖。阅读请直接以参考设计为准。

> 状态：实现蓝图（依据 Pi 侧权威文档 `D:\pi-maestro-flow\docs\session-run-minimal-state-architecture-20260812.md`，下称「方案 B」；合同来源 `session-run-v3-core-contract-checklist-20260812.md`，下称「合同清单」；对应 Pi 侧行动规划的阶段 1）。
> 范围：本仓库（maestro core CLI，`bin/maestro.js` → `dist/src/cli.js`，Node/TypeScript/ESM，zod schema，vitest）的 v3 schema、原子 mutation 引擎、receipt、命令面、resume-view 与 v2→v3 迁移器。
> 前提：operation registry / drain 与 `execution handoff prepare --drain-operation` 强制参数的拆除由另一并行工作流负责，本蓝图视其为**已删除**，不再重复规划。普查时在 `store.ts`/`execution.ts`/`commands/execution.ts` 中读到的 operation claim/drain 代码属拆除中的过渡态，本蓝图各工作流不触碰这些区域。

## 1. 现状模块地图（2026-08-12 实测，cli_version 0.5.69）

### 1.1 schema 与协议层

- `src/run/schemas.ts`（约 970 行）：session/1.0–1.3（全量文档，含 orchestration/chain/decision_points/requests）、session/2.0（statusless 身份文档：仅 identity + `current_execution_id`/`latest_execution_id`/archived 字段）、execution/1.0（含 lease、chain、generation）、command-run/1.0–1.4、gates/1.0、artifacts/1.0、evidence/1.0、execution-lease/1.0、execution-operation-registry/1.0（拆除中）。核心机制：`normalizeSessionState`/`normalizeCommandRun` 的 read-boundary normalization（低版本读入内存即升格）、`knownSessionStateReadSchema` 判别 union、`sessionStateUnknownSchema` 未知未来版本 passthrough fallback（旧 CLI 读新数据不崩）。
- `src/run/protocol-schemas.ts`（约 58KB）：transition-request/outcome 1.0 与 1.1、persisted transition record、run-response/1.0 与 1.1 envelope（1.1 含 fence/disposition/warnings/retryable/recovery_command，superRefine 禁止 raw lease_id/operation_token 泄漏）、`maestroCapabilitiesSchema`（maestro-capabilities/1.0，**features 为 strict 固定六键对象**）、错误码枚举（v1.0 与 v1.1 两代）、execution seal receipt / session archive receipt schema。
- `src/run/response.ts`：envelope 构造器（`createRunResponseSuccess/Error` 双代重载）、`stableRunResponseErrorCode(V11)` 错误码映射（typed code 优先，正则消息回退）、`emitRunResponse` 单行 JSON 输出 + exit code parity、lease token redaction。

### 1.2 持久化与并发层

- `src/run/store.ts`（约 162KB，3700 行）：`SessionStore` 是唯一持久化入口。
  - `SessionStoreLock`：`sessions/.session-store.lock` 单文件全工作区互斥锁；`wx` 独占创建 + 锁记录（pid/时间）+ PID 活性探测 + Windows EPERM/EACCES/EBUSY 重试；`LOCK_WAIT_MS=5000`、`LOCK_POLL_MS=15`。
  - `writeBatchUnlocked`：多文件原子提交。流程 = 写 intent journal（`session-store-intent/1.0`，含每个文件原文 base64 + 前后 sha256）→ 写临时文件 → 逐个 `safeRename` → 删 intent；每次取锁后先跑 `reconcileTransactionIntentUnlocked` 做崩溃恢复（回滚或前滚）。
  - 事务入口：`createExecutionAtomic`/`updateExecutionAtomic`（execution revision CAS + activity revision fence + sealed 不可变 + 单 open execution 不变量）、`update`（legacy bundle 整体写）、`StoreTransaction`/`ExecutionStoreTransaction` 写集合。
  - 读入口成对出现：`readX`（锁内）与 `readXReadOnly`（免锁只读）。
- `src/run/transition-receipts.ts`：request-id 幂等核心。`stableJsonUtf8`（key 排序 canonical 序列化）、`sha256Digest`、`replayOrApplyTransition(V11)` 幂等门：同 request_id + 同 normalized_request_hash → replay 返回原 outcome；异 hash → `REQUEST_CONFLICT`；replay 时校验 postconditions 与当前 fence 一致，否则 `REPLAY_STATE_DIVERGED`（V11 还有 `assertEvidenceBackedReplaySuccessor` 后继证据链校验）。receipt 与 request/outcome 交叉绑定校验（`validatePersistedTransitionRecord`）。
- `src/run/mutation-ledger.ts`：`.workflow/mutations.jsonl` append-only 轻量审计账本（actor/target/content_hash），与 receipt 体系独立。

### 1.3 业务引擎层

- `src/run/execution.ts`（约 95KB）：Execution 生命周期全部业务函数（start/attach/pause/resolve/resume/seal、lease heartbeat/release/recover、handoff prepare/accept/cancel、operation claim——后两者拆除中）。**v3 整体删除对象**。
- `src/run/lease.ts`：execution lease 三元组 fence 校验、staleness 判定、lease id hash。**v3 整体删除对象**。
- `src/run/runtime.ts`（约 204KB）：Run 引擎——`createRun`/`createExecutionRun`、`checkRun`、`completeRun`/`completeExecutionRun`/`completeRunWithVerdict`、`briefRun`、`prepareStep`、`sealSession`、`pruneOrphanSessions`、session 投影。legacy（session/1.3）与 execution（session/2.0）双路径并存。
- `src/run/next.ts`、`chain.ts`、`chain-admin.ts`、`chain-proposal.ts`：`run next` 推进、chain 结构、`session chain insert/skip/replace` 管理。
- `src/run/session-transition.ts`：paused Session 审计恢复（resolve/resume）、`listRecoveryBlockers`、`nextRecoveryAction` 建议生成。
- `src/run/session-resolver.ts`：上下文推导，优先级 = 显式 ID > `MAESTRO_SESSION_ID` 环境变量 > state.json 唯一 running 候选 > **全目录扫描按 mtime 取最新**（第 5 级，E3 要求删除项）；session/2.0 的 `derivedStatus` 兼容投影（archived_at → archived；execution paused → paused；否则 running）。
- `src/run/migrate.ts`：现有迁移器（ralph-meta.json → session/1.3；session/1.3 → session/2.0 + execution/1.0 的 `migrated-to-2.0` 路径），显式触发、幂等，是 v3 迁移器的结构先例。

### 1.4 命令注册与命令面

- `src/cli.ts`：Commander lazy-loading 注册表（`commandLoaders` 映射命令名 → 动态 import 注册函数）；machine-mode 判定基于**命令名/子命令白名单**（`runMachineSubcommands`/`sessionMachineSubcommands`/`executionMachineMode`）+ `--json`；fatal 错误 envelope 兜底。
- `src/commands/session.ts`（102KB）：`session resolve/resume/migrate/list/show/status/check/evidence/seal/create/start/chain {insert,skip,replace}/meta update/next/done/decide/prune/graph/archive/unarchive`。
- `src/commands/run.ts`（110KB）：`run start/status/recover/done/edit/prepare/next/create/check/rebind/complete/brief/accept-reuse/recall/skill/decide/seal-session/log-mutation/mutations`。
- `src/commands/execution.ts`：`execution start/attach/status/pause/resolve/resume/seal/lease {status,heartbeat,release,recover}/handoff {prepare,accept,cancel}/operation *`（后两族拆除中）；**`registerCapabilitiesCommand` 在此文件**，硬编码 v2 六键 features 广播。
- `src/commands/execution-cli-shared.ts`：`--request-id`/`--expected-*-revision`/lease claim 等 option 注入的共享 helper（v3 五个统一 option 的注入先例）。

### 1.5 测试基建

- 框架 vitest（`vitest.config.ts`），include = `src/**/*.test.ts`（与源码 colocated）+ `scripts/**/*.test.mjs`；`npm test` = `vitest run`；`npm run lint` = `tsc --noEmit`。
- fixture 风格：`mkdtempSync(join(tmpdir(), 'maestro-...'))` 建临时工作区，`afterEach` 清理；直接写 `.workflow/config.json` 切换 writer（`store-v20.test.ts` 的 `enableSessionV20` 先例）；`src/run/__fixtures__/` 存 JSON fixture 与子进程注入脚本；崩溃/durability 注入见 `store-durability.integration.test.ts` + `__fixtures__/session-store-crash-child.mjs`。

### 1.6 现状存储布局

```text
.workflow/
  config.json                     # session_schema writer 选择（session/1.3 | session/2.0）
  state.json                      # 只读投影（sessions 列表）
  mutations.jsonl                 # 审计账本
  sessions/
    .session-store.lock           # 全工作区互斥锁（单文件）
    .session-store-intent.json    # 事务 intent journal（仅提交期间存在）
    <session-id>/
      session.json                # session/1.3 全量文档 或 session/2.0 身份文档
      gates.json / artifacts.json / evidence.json    # 各自带 revision
      runs/<run-id>/run.json      # command-run/1.3（legacy）或 1.4（execution 绑定）
      executions/<exec-id>/       # execution.json、transitions/<request-id>.json、
                                  # seal-receipt.json（operation-registry* 拆除中）
      archive-receipts/           # session/2.0 archive receipt（按 activity revision 编号）
      .compat/session-1.3.json    # session/2.0 的旧版兼容投影
```

### 1.7 决定复用判断的关键现状事实

1. **request-id 幂等与 canonical hash 已生产级**：`replayOrApplyTransition` 的「同 hash replay / 异 hash REQUEST_CONFLICT」正是方案 B §6 语义，可直接演进。但现状 receipt **存完整 payload**（session/1.3 存在 `session.requests` 内嵌数组 → session.json 无界增长；execution 路径存独立 `transitions/<request-id>.json` 文件），且**不记录 participantId**。
2. **revision fence 现状与 v3 冲突**：`assertTransitionMutationRevisions` 与 `ExecutionAtomicOptions.expectedActivityRevision` 把 `activity_revision` 当 CAS fence 参与比较；v3 要求 activityRevision 盲递增、绝不参与 CAS。该路径不能沿用。
3. **多文件原子提交已解决**：intent journal + 临时文件 + rename + 取锁时崩溃恢复，是 v3 复合事务（`run complete --advance`、`session complete`）「故障注入无半提交」的现成地基。
4. **锁是全工作区单文件锁**，不是 per-entity 锁；事务在锁内为毫秒级（内存读改写 + 批量提交）。
5. **per-Run 独立文件已存在**（`runs/<run-id>/run.json`），v3 的 per-entity CAS 边界与现有文件边界天然对齐，只缺 Run 自身的 `revision` 字段。

## 2. 合同清单 §1–§6 逐条映射

### §1 capability 广播

- 落点：修改 `src/commands/execution.ts` 的 `registerCapabilitiesCommand`（建议迁出为独立 `src/commands/capabilities.ts` 并更新 `src/cli.ts` loader，摆脱对 execution 模块的 import）；修改 `src/run/protocol-schemas.ts` 的 `maestroCapabilitiesSchema`。
- 复用/新建：命令骨架复用。**schema 必须改**——三处：
  1. `features` 从 strict 固定六键改为「已知键 + 布尔 catchall」（`z.record(z.string(), z.boolean())` 与已知键合成），匹配 Pi 侧「顶层字段不增删、新增 feature 键走 features 布尔 catchall」的冻结解析假设；
  2. `session_schema_writes` enum 增 `session/3.0`；
  3. `execution_schema_writes` 允许空数组（现 shape 已允许，广播值改为 `[]`）。
- v3 目标广播：`session_run_minimal_v3/entity_revision_cas/participant_identity/request_receipts_v2` 全 true，`execution_lease/operation_registry` **显式 false**。翻转时机见 §4 W3。

### §2 命令面

- 落点：新建 `src/commands/session-v3.ts`（session open/pause/resume/complete/archive/status/resume-view/chain {insert,skip,replace,audit}）、`src/commands/run-v3.ts`（run next/create/brief/check/complete/cancel/seal）、`src/commands/participant.ts`（register/status/unregister）；`src/cli.ts` 在 loader 层按 workspace writer 分发 v3/v2 注册函数。
- 统一 option `--participant/--actor/--request-id/--expected-<target>-revision/--json`：注入 helper 新建（仿 `execution-cli-shared.ts` 模式），`--participant/--actor` 为全新 option；v3 面**不暴露** `--expected-activity-revision`（见风险 2）。
- 复合事务：`run complete <run-id> --advance` 与 `session complete` 调 W2 引擎的单事务 API，不做命令层拼接。
- 旧命令处置：`execution */lease */handoff *` 命令族保留注册壳但 action 一律返回结构化 replacement（`warnings[].replacement_command` 或 error `next_actions`），不得静默模拟；`run next --execution` 等带 execution flag 的调用在 v3 workspace fail-closed。
- 上下文推导 fail-closed（E3）：新建 `src/run/v3/resolve-context.ts`，优先级 = 显式 ID > 当前绑定 > 唯一 open Session > 唯一可运行候选；多候选返回 `SESSION_AMBIGUOUS` + 候选列表；**无 mtime fallback**。v2 的 `session-resolver.ts` 原样保留供旧读路径。

### §3 mutation 合同

- 落点：新建 `src/run/v3/mutation-engine.ts`，单入口 `mutateV3(ctx: MutationContext, apply)` 按方案 B §6 十步顺序执行；底层复用 `SessionStore.withLock` + `writeBatchUnlocked`。
- activityRevision 盲递增：引擎第 8 步在同一写批次内递增 Session 文档计数器；不接受 `activityRevision` 作为 CAS target；锁序（先 target 校验、后 session 计数器）作为引擎内固定逻辑顺序实现（见 §3 决策 2）。
- request receipt：新建 `src/run/v3/receipts.ts`，两个新 schema（W1 定义于 protocol-schemas.ts）：
  - `request-receipt/2.0`：`request_id + participant_id + payload_hash + transition_receipt_ref`，存 `sessions/<id>/receipts/requests/<request-id>.json`；
  - `transition-receipt/2.0`：immutable，含 target_type/target_id/revision before-after/actor/participant/reason/evidence/result，存 `sessions/<id>/receipts/transitions/<seq>-<transition-id>.json`（seq = activityRevision，天然全序）。
  - replay 判定：同 request_id 且同 hash 且同 participant → 返回原 transition receipt；异 hash **或异 participant** → `REQUEST_CONFLICT`。canonical hash 复用 `stableJsonUtf8`/`sha256Digest`。保留策略 = Session 生命期，archived 后随 Session 归档。
- Run 状态机：新建 `src/run/v3/run-machine.ts` 纯函数状态表（pending/running/blocked/completed/failed/cancelled/sealed），含 `pending→cancelled`、`blocked→failed` 需附 reason/evidence 的守卫；retry = 新建 Run（retryOfRunId/attempt+1），引擎拒绝 failed/sealed → running。
- Session 状态机与 paused 语义：新建 `src/run/v3/session-machine.ts`；paused 只禁「创建新 Run + 推进 chain step」，running/blocked Run 可走完自身状态机；`session complete` 前置校验（blocking gate 全过、required step 全完成/跳过有据、无 running Run）不因 paused 放宽。

### §4 错误合同

- 落点：`protocol-schemas.ts` 增 v3 错误码（`RUN_REVISION_CONFLICT`、`ORCHESTRATION_REVISION_CONFLICT`、`SESSION_SCHEMA_UNSUPPORTED`、`STORE_BUSY` 等，复用已有 `REQUEST_CONFLICT`/`SESSION_AMBIGUOUS`）与 **run-response/1.2**（见 §3 决策 4）；`response.ts` 增 1.2 构造器；新建 `src/run/v3/errors.ts` 定义带结构化字段的错误类型（target_type/target_id/expected_revision/current_revision/changed_by/next_actions）。
- `help --json` catalog（F1）：新建 `src/commands/help-json.ts`，强制加载全部 lazy loader 后遍历 Commander 树生成 catalog（mutation scope、CAS target、options、examples、deprecated/replacement）；parity 测试比对注册树与 catalog 快照。

### §5 resume-map

- 落点：新建 `src/run/v3/resume-view.ts`（ResumeMapV1 投影：三 revision、activeRuns[]、blockingGates、openDecisions、pendingPublications、nextActions[]、fingerprint）+ `session resume-view` 子命令。
- 硬约束实现：数组按稳定 ID 排序；fingerprint = `sha256Digest(stableJsonUtf8(map minus fingerprint))`；序列化 ≤2KB（超限截断规则见风险 10）；输出物不含任何 execution/lease/operation 字段（schema 层 strict 保证）。

### §6 迁移

- 落点：新建 `src/run/v3/migrate-v3.ts` + `session migrate --to-v3` 子命令；迁移报告写 `sessions/<id>/v3-migration-report.json`。
- 过程映射（方案 B §13 八步）：冻结旧 session.json/execution.json/run.json 快照并记 sha256（复用 seal-receipt 的 `sha256Prefixed` 模式）→ 投影 session/3.0（status 映射见风险 1）→ 每个 Run 补 sessionId/stepId/attempt/revision/participant-actor fallback → execution generation 记为 `legacyExecutionGeneration` 审计字段 → finalOutcome/seal summary 映射为 Session transition receipt → 丢弃 lease/heartbeat/handoff（报告只记 hash 与丢弃原因，不复制 token）→ 引用完整性验证（Run/Artifact/Evidence/Gate）→ `writeBatchUnlocked` 原子发布，旧 execution 目录保留只读。
- 双读单写：`schemas.ts` 的 read union 增 v3（新 CLI 双读）；v3 命令只写 v3；v2 mutation 入口读到 `session/3.0` 抛 `SESSION_SCHEMA_UNSUPPORTED`（仿 `assertLegacySessionMutationAllowed` 的 guard 模式）；禁止 dual-write。有 running Run 的旧 Session 拒绝自动迁移。

## 3. 关键设计决策点

**决策 1：v3 存储布局 —— Session 文档 + 独立 Run 文档 + session 级 receipt 目录。**
`sessions/<id>/session.json` 写 `session/3.0`（三 revision、chain、decisions、registry refs、status）；Run 沿用现有 `runs/<run-id>/run.json` 位置改写 `run/3.0` 并加入自身 `revision`，使 per-Run CAS 边界与文件边界一致（不同 Run 的 mutation 落不同文件，天然无写冲突）；receipt 迁出 session.json 落 `receipts/` 目录（1.3 的 `session.requests` 内嵌数组是无界增长缺陷，v3 修复）。gates/artifacts/evidence 三个 registry 文件与其自身 revision 原样保留，改引用 Session/Run ID。v3 pointer 复用 `.workflow/config.json` 的 `session_schema.writer` selection 机制扩展 `session/3.0`。

**决策 2：短事务锁 —— 保留单一 store 文件锁，不引入物理 per-entity 锁。**
现有 `SessionStoreLock` 已在 Windows 上打磨过（`wx` 独占 + PID 活性 + EPERM/EBUSY 重试 + intent 崩溃恢复），事务锁内为毫秒级。方案 B「先 target 锁后 Session 锁、固定锁序」的目的是防死锁并保证 activityRevision 串行化——单一全局锁是它的平凡正确实现（全序 ⊃ 任意固定偏序，不可能死锁）；§17「不同 Run 的 mutation 并发成功」是语义验收（互不产生 CAS 冲突、双双成功），不要求物理并行提交。故 v3 引擎直接用 `store.withLock` 包裹十步流程，把「target 校验先于 session 计数器递增」实现为引擎内固定逻辑顺序。引擎不直接持有锁对象，留出未来分裂 `runs/<id>/.lock` 的接口缝隙。

**决策 3：receipt 演进 —— 复用 canonical hash 幂等门，砍掉 v1.1 的 divergence 证据链。**
`request-receipt/2.0` 只存 payload hash + participantId + transition receipt 引用（存储有界）；replay 直接返回原 transition receipt。v1.1 `replayOrApplyTransitionV11` 的 `REPLAY_STATE_DIVERGED` 与 `assertEvidenceBackedReplaySuccessor` 后继证据链校验是 execution fence 时代的产物（replay 结果必须能被推进到当前 fence），v3 的 receipt 是终态事实、与当前 revision 无耦合，**不迁移**该机制——这是行为差异而非简单搬运，需要在 W2 测试中显式锚定「后续 mutation 发生后 replay 仍返回原 receipt」。

**决策 4：run-response envelope —— 新增 `run-response/1.2`，不在 1.1 内塞 v3 语义。**
1.1 的 `fence` 含 execution_id/generation/lease_epoch，schema 带 lease_id/operation_token redaction superRefine；v3 冲突响应要求顶层结构化 conflict payload（target_type/target_id/expected_revision/current_revision/changed_by/next_actions）。新增 1.2：去 execution/lease 字段、error 规范化为 conflict shape、保留单行输出与 exit parity；`run_response_writes` 广播三代；v2 命令继续写 1.0/1.1，互不污染。

**决策 5：双读单写接入点 —— 全部收敛在 `schemas.ts` read union + 写入口 guard。**
新增 `sessionStateV30Schema`/`runV30Schema` 进 `knownSessionStateReadSchema`；v3 命令读到 v2 数据只做只读投影 + 迁移提示；v2 写路径读到 `session/3.0` 在入口抛 `SESSION_SCHEMA_UNSUPPORTED`。normalization 方向保持「低版本升格为内存只读视图，持久升格只归迁移器」的现有单向惯例。旧 CLI（0.5.69 及之前）读 v3 靠已发布的 `sessionStateUnknownSchema` passthrough 不崩、写路径因未知版本 fail-closed。

## 4. 工作分解（5 个工作流）

文件交集原则：对现有大文件（`schemas.ts`/`protocol-schemas.ts`/`store.ts`/`cli.ts`）的修改集中在 W1 一次完成并冻结；W2–W5 只新建 `src/run/v3/*` 与 `src/commands/*-v3.ts` 各自文件，互相无交集。

### W1 schema + 存储（串行先行，冻结合同）

- 文件：`src/run/schemas.ts`（v30 schema + read union）、`src/run/protocol-schemas.ts`（capabilities 改造、run-response/1.2、v3 错误码、receipt 2.0 schema、ResumeMapV1 schema）、`src/run/store.ts`（v3 路径方法 `receiptsDir`/run v3 读写、writer selection 扩展、v2 写入口 guard）、`src/cli.ts`（loader 分发骨架 + machine-mode 登记）。
- 验收：schema 单测；`capabilities --json` 形状满足合同 §1（对照 Pi 侧 `test/cli-adapter-capabilities.test.ts` 的 `v3StructuredCapabilities` fixture 互测）；features 先广播 `session_run_minimal_v3: false` 占位，待 W2/W3 完成再翻 true。
- 依赖：等并行拆除工作流对 `store.ts` 的改动 land 后 rebase 合入（风险 4）。

### W2 mutation 引擎 + receipt + 状态机（依赖 W1）

- 文件（全新建）：`src/run/v3/mutation-engine.ts`、`receipts.ts`、`run-machine.ts`、`session-machine.ts`、`errors.ts`，及各自 colocated `*.test.ts`；复合事务 API `completeRunAndAdvance`/`completeSession`。
- 验收（合同 §7「并发」+「状态机」全部勾选项）：
  - 不同 Run 并发 mutation 成功且 activityRevision 递增不产生 CAS 冲突；
  - 同一 Run 两个 mutation 仅一成功，另一收到 current_revision + next_actions；
  - `--advance`/`session complete` 故障注入无半提交（复用 `store-durability` 子进程注入手法 + `__fixtures__` crash child）；
  - 同 requestId + 同 payload replay 返回同 receipt；异 payload 或跨 participant 返回 `REQUEST_CONFLICT`；
  - pending Run 可直接 cancel；blocked Run 直接 fail 需附判定依据；paused 下 running Run 可 complete、新建 Run 被拒。

### W3 命令面 + 错误合同 + capabilities 翻转（完整交付依赖 W2；骨架可并行）

- 文件：新建 `src/commands/session-v3.ts`、`run-v3.ts`、`participant.ts`、`capabilities.ts`、`help-json.ts`、`src/run/v3/resolve-context.ts`；修改 `src/commands/execution.ts`（action 改结构化 replacement——在拆除工作流 land 后进行）。
- 与 W2 的并行面：命令树骨架、option 注入 helper、help-json、replacement 输出、`resolve-context` 均不依赖引擎，可先行；接引擎 API 的 action 体最后接线。
- 验收：合同 §2 命令面全表存在且支持五个统一 option；§4 四个错误码（`RUN_REVISION_CONFLICT`/`REQUEST_CONFLICT`/`SESSION_AMBIGUOUS`/`SESSION_SCHEMA_UNSUPPORTED`）结构断言各至少一例；help --json parity gate 通过；capabilities 翻转为合同 §1 全表（v3 交付的最后一步）。

### W4 resume-view（依赖 W1；与 W2/W3/W5 无文件交集，可并行）

- 文件：新建 `src/run/v3/resume-view.ts` + `resume-view.test.ts`；命令挂接通过 W3 在 `session-v3.ts` 预留的一行注册钩子。
- 验收（合同 §5 + §7「恢复」）：字段全表；无 executionId/generation/lease/operation 字段（strict schema 断言）；序列化 ≤2KB；数组稳定排序；canonical fingerprint 可复算。

### W5 迁移器（依赖 W1；与 W2/W3/W4 无文件交集，可并行）

- 文件：新建 `src/run/v3/migrate-v3.ts` + `migrate-v3.test.ts`；fixture 集覆盖两代起点：session/1.3 全量文档、session/2.0 + execution/1.0 + command-run/1.4（含 sealed 与 open execution、带 lease 的样本）。
- 验收（合同 §6 + §7「迁移」）：Run/chain/gate/artifact/evidence 引用无损；`legacyExecutionGeneration` 审计字段就位；finalOutcome/seal summary → Session transition receipt；不持久化任何 lease/operation token（报告只记 hash 与丢弃原因）；旧目录只读且 hash 可审计；有 running Run 的 Session 拒绝自动迁移；旧 CLI 对 v3 mutation 返回 `SESSION_SCHEMA_UNSUPPORTED`。

### 依赖关系

```text
（并行拆除工作流 land）──> W1 ──┬──> W2 ──> W3 完整交付（capabilities 翻转收尾）
                                ├──> W4 ─────┘（经 W3 注册钩子挂接）
                                └──> W5 ─────┘（经 W3 注册钩子挂接）
W3 骨架（命令树/help-json/replacement/resolve-context）与 W2 并行
```

全部完成后统一跑 Pi 侧互测（合同 §7 全部勾选 = 阶段 2 完整交付启动门槛）。

## 5. 风险清单

1. **session/2.0「statusless」与 v3 有 status 的语义回摆**：2.0 刻意把生命周期移入 Execution（`derivedStatus` 推导）；v3 把 status 收回 Session 本体。迁移投影必须显式定义：`archived_at≠null → archived`；current execution `paused → paused`；sealed execution `final_outcome ∈ {done, done_with_concerns} → completed`、`failed → failed`；无 Execution 或 active → `open`。
2. **activity_revision 从 CAS fence 变为盲递增**：`transition-receipts.ts` 的 fence 比较、`--expected-activity-revision` option、`ExecutionAtomicOptions.expectedActivityRevision` 全部是 v3 反模式。最大风险是「顺手复用」——W2 必须新写 fence 层，v3 命令面不得暴露 activity revision 作为 expected 参数，测试显式锚定「activityRevision 永不产生冲突」。
3. **capabilities schema 是 strict 固定键**：直接在 strict features 上加键会让旧 CLI 解析新 CLI 输出时崩溃（跨版本互测场景）；改 catchall 形状需与 Pi 侧冻结的「顶层字段不增删、features 布尔 catchall」解析假设互验（合同 §1）。
4. **并行拆除工作流的文件冲突**：`store.ts`/`execution.ts`/`commands/execution.ts` 正被拆 operation registry/drain。W1 对 `store.ts` 的修改与 W3 对 `commands/execution.ts` 的 replacement 改造都应在拆除 land 后 rebase；蓝图各工作流不触碰 operation 相关代码区。
5. **receipt 双存储遗留**：session/1.3 的 `session.requests` 内嵌 receipt 与 execution `transitions/` 目录两套并存；迁移时两处都需处理（execution transitions 投影为 v3 transition receipt 审计历史；内嵌 legacy `session-request` 记录只作审计保留，不投影为 v3 request receipt）。
6. **全局锁 5s 等待上限**：多 participant 高频并发下可能锁等待超时（「Cannot create SessionStore lock」）。v3 错误合同应把该失败映射为 retryable 结构化错误（如 `STORE_BUSY`），避免 Pi 侧当作永久失败；并发验收测试需注意 vitest 并行 worker 对同一临时工作区的锁竞争。
7. **`session complete` 的「无 running Run」校验需要原子快照**：逐文件扫描 runs 目录慢且非快照。建议 Session 文档维护 active-run id 集合（引擎在同一事务内维护）；注意该聚合字段只由引擎写、不作为外部 CAS target，否则重新引入全局竞争点。
8. **旧命令与 alias 的收敛面大**：`session done`/`run done`/`run seal-session` 等 alias 众多（`compat-alias.test.ts`、`run-seal-alias.test.ts`）；F2 收敛必须保证每个旧入口在 v3 workspace 返回结构化 replacement 而非静默走 v2 写路径，`run next --execution` 等带 execution flag 的调用 fail-closed。
9. **machine-mode 白名单漂移**：`src/cli.ts` 的 `--json` machine-mode 判定是命令名白名单；新增 v3 子命令若漏登记，`--json` 会走 human 分支破坏 Pi 解析。建议 W3 改为命令注册时自声明 machine-mode（与 help-json catalog 同源），消除白名单。
10. **resume-map 2KB 硬约束**：activeRuns 无上限时可能超限；投影需定义截断规则（如 activeRuns 上限 N + `truncated` 指示位）并写进合同测试，否则 Pi 侧见超限即 fail-closed。
11. **Windows 路径与原子 rename**：现有 `safeRename` 与 EPERM 重试已覆盖，但 v3 新增 receipt 目录的高频小文件 append 在 Windows Defender 实时扫描下可能放大延迟；receipt 写入应始终走 `writeBatchUnlocked` 批次而非独立写，兼顾原子性与性能。

## 6. 验收总门槛

合同清单 §7 全部勾选项 = 本蓝图完成定义；逐项归属见 §4 各工作流验收行。跨仓互测入口：Pi 侧 `test/cli-adapter-capabilities.test.ts` 的 `v3StructuredCapabilities` fixture 与本仓库 `capabilities --json` 输出直接比对；方案 B §18 完成定义中 core 侧条目（v3 schema/atomic mutation/receipt/migration 完成、旧 Execution 命令有明确 replacement、迁移 fixture 与并发故障注入通过）由 W1–W5 验收行覆盖。
