<!-- session-mode: inherited -->
# Canonical Orchestrator Run Loop

Canonical lifecycle reference: `@~/.maestro/workflows/run-mode.md`.

Maestro 与 Ralph 共享这一执行循环。它只调用 `maestro run ...`；Session 与 Run 协议文件始终由 Runtime 写入。

## Public flags

- `-y`：自动确认低风险选择；不得越过高风险、低置信度、边界歧义或 drift 熔断。
- `-c`：继续唯一 live compatible Session。多个候选必须询问，paused Session 进入 audited recovery。
- `--amend`：修改唯一 live Session 的目标；剩余文本为 change request。

除以上 3 个 flags 外，其余文本全部视为 intent。Roadmap、quality、executor、platform、模板复用、并行与对抗策略由 intent、Session state、Skill contract 和 host runtime 推断。

## Authority

- Session 是 topic grouping/index；`session.json.orchestration` 是 chain/goal/decision 唯一真相源。
- Run 是一次执行 attempt；Run 的 outputs、handoff、gate、proposal 与 transition receipt 归该 Run。
- Skill 决定领域结果及可选 `chain-proposal/1.0`；orchestrator 决定 accept/reject/revise；Runtime 独占 chain mutation。
- historical similarity 只读；同 Session sealed outputs 只经 birth packet 的 canonical `upstream` 复用。

## Continuation Router

所有 `--json` machine response 优先读取 `continuation`。它是 Session/Run 权威状态的只读投影，不是第二状态源。旧 Runtime 没有该字段时，才回退到 `next`、`result.next_action` 与稳定 error code。

`suggest_only` 只表示 CLI 不自行执行；它不表示每一步都要询问用户。Session 已确认后：

- `authority=automatic`：立即执行 `command`，读取新回执并继续本循环。
- `authority=auto_mode_only`：仅当 Session 持久化 `auto_mode=true` 且该动作满足下述 `-y` 白名单时执行；否则询问用户。
- `authority=user_required`：停止自动动作，报告精确 blocker、hash、reason code 与所需证据。

**Turn 终止不变量**：只要 Session 为 `running` 且存在可满足 preconditions 的 `automatic` 动作，不得结束当前 turn、报告整体完成或仅把命令推荐给用户。每执行一条 continuation command 都重新读取回执；不得根据旧状态连续猜测多条命令。

| continuation.action | Prompt 行为 |
|---|---|
| `load_run` | 调用同一 `run_id` 的 `run brief --json`，禁止创建重复 Run |
| `execute_run` | 执行已加载的 Resume Packet，随后调用 directive 中的 check/complete command |
| `repair_run` | 重新附着同一 Run，修复 gate/scan error，再 check |
| `dispatch_next` | 校验 preconditions 后立即 `session next --json`；尤其是 `complete` 或 `decide` 后不得只展示命令 |
| `evaluate_decision` | `command` 非空时只执行一次以读取 decision card；`reason_code=DECISION_CARD_READY` 时不得再次 `session next`，直接派发只读 evaluator，再调用 `session decide` |
| `accept_reuse` | 按下述正式 reuse 流程处理 exact assessment |
| `recover_session` | 只走 audited `session recover`；不得隐式 resume |
| `seal_session` | 校验 Runs、decisions、goals 与 Session gates 后 seal |
| `offer_recommendations` | 只展示 chain 外建议；不得隐式创建新 Run |
| `repair_chain` / `stop` | 停止续跑并报告结构化原因，不绕过 authority |

### REVIEW reuse

`REUSE` 直接使用 canonical upstream；`REJECT` 与 `CONFLICT` 永不接受。`REVIEW` 只有 exact acceptance receipt 才能打开 required consume gate：

`maestro run accept-reuse {run_id} --session {session_id} --assessment-hash {assessment_hash} --request-id {stable_request_id} --actor {actor} --reason "{reason}" --evidence {evidence} --expected-identity-revision {identity_revision} --expected-activity-revision {activity_revision} --json`

接受后必须重新调用同一 Run 的 `brief --json`。`assessment.decision=REVIEW` 仍可保留作为原始判断；以 `assessment.acceptance_status=accepted` 为已处理依据，不得重复接受。

### `-y` policy

正常生命周期续跑不依赖 `-y`。`-y` 只扩大低风险裁量：

- 可自动：pending-tail 内已验证且 intent-aligned 的 proposal；仅含 `QUALITY_MEDIUM`、同 Session、producer/artifact sealed、hash/fence/current revision 完整且有 evidence 的 REVIEW。
- 必须停：`QUALITY_LOW`、`REJECT`、`CONFLICT`、hash mismatch、source fence/freshness/supersession unknown、边界变化、高风险、低置信度、retry exhausted、paused recovery 或外部 blocker。
- `-c` 继承 `session.orchestration.auto_mode`；不要求用户重复输入 `-y`。

链内 pending command 是已确认工作，`dispatch_next` 自动继续。handoff `next[]` 只是 chain 外 recommendation；若要在同一 Session 自动续跑，产生它的 Run 必须提交并原子应用有效 `chain-proposal/1.0`。

### `complete` / `decide` 闭环

- `session done|done --json` 返回 `dispatch_next` 时，当前 turn 必须立即执行其 command。
- 若下一节点是 decision，执行 `session next --json` 取得 canonical decision card；decision 不创建 Run，必须通过 `session decide` 提交 verdict。
- `session decide --json` 与 `complete` 使用同一 Continuation Router：`proceed` 后可继续到下一 Run、下一 decision 或 Session seal；`escalate` 转 audited recovery；`fix` 在获得新的 repair evidence 前不得重复 decide。
- `session next` 成功后，birth packet 中的 `run_already_created=true` 是严格约束：立即加载该 exact `run_id` 的 brief，只执行其 command/args/goal/canonical upstream，禁止再次 `run create`，并在仍有 automatic continuation 时保持当前 turn。

## Lifecycle

### 1. Resolve or create

1. `-c` / `--amend`：用 `maestro run recall <command> --intent "{intent}" --json` 定位唯一 live Session。
2. 新 intent：分类并构建 chain definition。每个 execution step 只声明 `command/args/stage/goal_ref/retry_max`；decision step 声明 `decision_ref`。
3. 用临时 JSON 文件创建，不把未转义 JSON 拼入 shell：

   `maestro run start "{intent}" --id {slug} --chain-file {path} --no-dispatch`

4. Runtime resolver 在 `session next` 分配 Run 前校验 command、Skill 和 lifecycle step；prompt 不调用独立 catalog CLI。

### 2. Locate and allocate

1. `maestro run status {session_id}` 读取 canonical 状态。
2. execution step：显式调用 `maestro session next --session {session_id} --json`。只有该动词能分配下一 Run。
3. decision step：不创建 Run，转 Decision evaluation。
4. `CHAIN_COMPLETE`：校验 goals 与 gates 后转 Session seal。

### 3. Load and execute one Run

1. 从 birth packet 取得 `run_id/run_dir/upstream/previous_handoff/queue/goal`。
2. `maestro run brief {run_id} --session {session_id}` 加载 Resume Packet 与 Skill 正文。
3. 派发一个 unnamed `run-executor`；executor 只执行该 Run，可按 Skill 自身 contract 选择串行、并行或对抗实现。
4. executor 写 formal artifacts 到 `{run_dir}/outputs/`，handoff 写 `{run_dir}/report.md`，然后运行 `maestro run check {run_id} --session {session_id}`。
5. executor 不调用 `session done/complete`；completion authority 属于 orchestrator。

### 4. Analyze, gate, and complete

从 executor 结果提取：

- `summary`：必须，动词开头，≤100 字。
- `evidence`：验证产物路径。
- `decision`：非显而易见的技术决策。
- `note`：concern、deferred 或 minor drift。

Drift policy：

| Result | Action |
|---|---|
| aligned | `session done --verdict done` |
| minor drift | `session done --verdict done-with-concerns --note ...` |
| major drift，未重试 | `session done --verdict needs-retry` |
| major drift，已重试 | `session done --verdict done-with-concerns` |
| external blocker | `session done --verdict blocked --reason ...` |

日常 completion：

`maestro session done {run_id} --session {session_id} --verdict {verdict} --summary "{summary}" [--evidence ...] [--decision ...] [--note ...]`

Runtime 返回的 next 仅为 `suggest_only`，因此 Runtime 自身不执行它；canonical `continuation.authority=automatic` 已代表 orchestrator authority，必须在同一 turn 调用 `session next`，无需再次询问用户。

### 5. Chain proposal

`run check` 自动发现并校验当前 Run outputs 中的 typed `chain-proposal/1.0`。

- accept：必须恰好有一个 valid proposal，调用 `session done ... --apply-proposal`；proposal 与 completion 在同一事务应用。
- reject：不传 `--apply-proposal`，以 `--note` 记录理由。
- revise：不 complete；用同一 `run_id` 重新加载 `run brief`，让原 Skill 修订后再次 check。

`-y` 仅可自动接受：proposal valid、只修改 pending tail、未越 budget、intent aligned、无 escalate。路径参数 `--chain-proposal` 只保留 legacy compatibility，不在 orchestrator 中使用。

### 6. Decision step

1. 派发一个只读 generic evaluator，读取对应 Run artifacts 与 goal evidence。
2. 严格解析 `proceed|fix|escalate`；解析失败降级为 `fix`，confidence=low，并在 summary 标记 `parse_failed=true`。
3. 调用：

   `maestro session decide {point_id} --session {session_id} --verdict {verdict} --confidence {high|medium|low} [--summary "..."] [--evidence ...] --json`

4. 读取 `session decide --json` 的 continuation 并留在同一闭环；`proceed` 立即继续，`escalate` 停在 recovery，`fix` 需要改变 pending tail 时必须由 repair Skill 产生 proposal，prompt 不直接复制 fix-loop template，也不得无新证据重复 decide。

### 7. Recovery and amend

Paused recovery 仅由显式 `-c` 触发：

1. `run status` 读取 exact blocker 与 revisions。
2. 每个 blocker 经用户选择后调用 `maestro session recover --session {id} ... (--decision {point}|--step {step}) --disposition {value}`。
3. blockers 清零后调用 `maestro session recover --resume --session {id} ...`。
4. resume 只恢复 Session；下一 Run 仍由显式 `session next` 分配。

Goal amend：读取 `ralph-amend-goal.md`，完成 snapshot → impact audit → confirmation → 通过 `maestro run edit --decomposition-file -` 整块更新 → planning Skill proposal。高风险修改不受 `-y` 影响。

### 8. Seal

所有 execution Runs sealed、decision steps terminal、goals done、Session gates clean 后：

`maestro session seal {session_id} --summary "..."`

## Failure rules

- `run check` blocking：重新附着同一 Run 修复，不得报告成功或分配新 Run。
- executor failed/null：首次 `needs-retry`；达到 retry budget 后 `blocked` 并暂停。
- lease/revision conflict：停止并重新读取 status，不猜测或 force。
- sealed/archived Session：终态，`session next` 应返回 `CHAIN_COMPLETE`，不得 resume。
